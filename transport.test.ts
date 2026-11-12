import { expect, test } from "bun:test";
import { __resetProxyCache } from "@oh-my-pi/pi-ai/utils/proxy";
import * as http from "node:http";
import * as http2 from "node:http2";
import * as net from "node:net";
import * as tls from "node:tls";
import { createGzip } from "node:zlib";
import { antigravityFetch } from "./transport";
import { cert, endpoint, key, listen, post } from "./transport-fixture";

test.each(["record", "Headers"])(
  "omits compatibility headers at the HTTPS boundary with %s headers",
  async (kind) => {
    const observed = Promise.withResolvers<http2.IncomingHttpHeaders>();
    await using target = await endpoint((stream, headers) => {
      observed.resolve(headers);
      stream.respond({ ":status": 200 });
      stream.end("ok");
    });
    const values = {
      Accept: "*/*",
      "Anthropic-Beta": "must-not-leak",
      "X-Ccpa-Test": "retained",
      "User-Agent":
        "antigravity/hub/1.5.6 (aidev_client; os_type=darwin; arch=arm64; cl=1018951551)",
    };
    const response = await antigravityFetch(
      target.url,
      post({ headers: kind === "Headers" ? new Headers(values) : values }),
    );
    await response.text();
    const headers = await observed.promise;
    expect(headers.accept).toBeUndefined();
    expect(headers["anthropic-beta"]).toBeUndefined();
    expect(headers["x-ccpa-test"]).toBe("retained");
    expect(headers["user-agent"]).toBe(
      "antigravity/cli/1.5.6 (aidev_client; os_type=darwin; arch=arm64; cl=1018951551; auth_method=consumer)",
    );
    expect(headers["content-length"]).toBeUndefined();
    expect(response.url).toBe(target.url);
  },
);

test("omits compatibility headers for plain HTTP loopback", async () => {
  const observed = Promise.withResolvers<http.IncomingHttpHeaders>();
  const server = http.createServer((request, response) => {
    observed.resolve(request.headers);
    response.end("ok");
  });
  const port = await listen(server);
  try {
    const response = await antigravityFetch(
      `http://127.0.0.1:${port}`,
      post({ headers: { Accept: "*/*", "anthropic-beta": "removed" } }),
    );
    expect(await response.text()).toBe("ok");
    const headers = await observed.promise;
    expect(headers.accept).toBeUndefined();
    expect(headers["anthropic-beta"]).toBeUndefined();
  } finally {
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  }
});

test.each([false, true])("delivers SSE before completion with gzip=%s", async (gzip) => {
  const finish = Promise.withResolvers<void>();
  await using target = await endpoint((stream) => {
    stream.respond({
      ":status": 200,
      "content-type": "text/event-stream",
      ...(gzip ? { "content-encoding": "gzip" } : {}),
    });
    if (gzip) {
      const encoder = createGzip();
      encoder.on("error", (error) => stream.destroy(error));
      encoder.pipe(stream);
      encoder.write("data: first\n\n");
      encoder.flush();
      void finish.promise.then(() => encoder.end("data: last\n\n"));
    } else {
      stream.write("data: first\n\n");
      void finish.promise.then(() => stream.end("data: last\n\n"));
    }
  });
  const response = await antigravityFetch(target.url, post());
  const reader = response.body?.getReader();
  if (!reader) throw new TypeError("Missing SSE body.");
  try {
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("data: first\n\n");
    finish.resolve();
    let remainder = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      remainder += new TextDecoder().decode(next.value);
    }
    expect(remainder).toBe("data: last\n\n");
  } finally {
    finish.resolve();
    reader.releaseLock();
  }
});

test("rejects pre-aborted requests before sending an HTTP request", async () => {
  let connections = 0;
  await using target = await endpoint((stream) => {
    connections++;
    stream.respond({ ":status": 200 });
    stream.end();
  });
  const controller = new AbortController();
  controller.abort(new DOMException("cancelled", "AbortError"));
  const error = await antigravityFetch(target.url, post({ signal: controller.signal })).catch(
    (reason: unknown) => reason,
  );
  expect(error).toMatchObject({ name: "AbortError", message: "cancelled" });
  expect(connections).toBe(0);
});

test("rejects an untrusted TLS endpoint instead of disabling certificate verification", async () => {
  await using target = await endpoint((stream) => {
    stream.respond({ ":status": 200 });
    stream.end("ok");
  });
  const error = await antigravityFetch(target.url, post({ tls: {} })).catch(
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(Error);
});

test.each([
  { method: "GET", body: "{}" },
  { method: "POST", body: new Uint8Array([1]) },
  { method: "POST", body: "{}", proxy: "socks5://localhost:9999" },
])("rejects unsupported request inputs: %j", async (options) => {
  const error = await antigravityFetch("https://localhost:1", options).catch(
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(TypeError);
});

test.each(["headers", "body", "cancel"])(
  "closes the HTTP/2 stream on %s cancellation",
  async (phase) => {
    const arrived = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    await using target = await endpoint((stream) => {
      stream.once("close", () => closed.resolve());
      if (phase !== "headers") {
        stream.respond({ ":status": 200 });
        stream.write("data: ready\n\n");
      }
      arrived.resolve();
    });
    const controller = new AbortController();
    const pending = antigravityFetch(target.url, post({ signal: controller.signal }));
    await arrived.promise;
    if (phase === "headers") {
      controller.abort(new DOMException("cancelled", "AbortError"));
      const error = await pending.catch((reason: unknown) => reason);
      expect(error).toMatchObject({ name: "AbortError", message: "cancelled" });
    } else {
      const response = await pending;
      const reader = response.body?.getReader();
      if (!reader) throw new TypeError("Missing response body.");
      await reader.read();
      if (phase === "cancel") await reader.cancel();
      else {
        controller.abort(new DOMException("cancelled", "AbortError"));
        const error = await reader.read().catch((reason: unknown) => reason);
        expect(error).toBeInstanceOf(Error);
      }
    }
    await closed.promise;
  },
);

async function proxyServer(secure: boolean, targetPort: number) {
  const observed = Promise.withResolvers<string>();
  const sockets = new Set<net.Socket>();
  const accept = (socket: net.Socket): void => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {
      /* Peer cancellation closes fixture tunnels. */
    });
    let request = "";
    const receive = (chunk: Buffer): void => {
      request += chunk.toString();
      if (!request.includes("\r\n\r\n")) return;
      socket.off("data", receive);
      observed.resolve(request);
      const upstream = net.connect(targetPort, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        socket.pipe(upstream).pipe(socket);
      });
      sockets.add(upstream);
      upstream.once("close", () => sockets.delete(upstream));
      upstream.on("error", (error) => socket.destroy(error));
      socket.once("close", () => upstream.destroy());
    };
    socket.on("data", receive);
  };
  const server = secure ? tls.createServer({ key, cert }, accept) : net.createServer(accept);
  const port = await listen(server);
  return {
    url: `${secure ? "https" : "http"}://user:secret@127.0.0.1:${port}`,
    observed: observed.promise,
    async [Symbol.asyncDispose]() {
      for (const socket of sockets) socket.destroy();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

test.each([false, true])(
  "routes through an authenticated CONNECT proxy with TLS=%s",
  async (secure) => {
    await using target = await endpoint((stream, headers) => {
      stream.respond({ ":status": 200 });
      stream.end(
        JSON.stringify({ accept: headers.accept ?? null, beta: headers["anthropic-beta"] ?? null }),
      );
    });
    await using proxy = await proxyServer(secure, Number(new URL(target.url).port));
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    // The fixture proxy has an ephemeral self-signed certificate. Target CA trust is tested separately.
    if (secure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      const response = await antigravityFetch(
        target.url,
        post({ proxy: proxy.url, headers: { Accept: "*/*", "anthropic-beta": "removed" } }),
      );
      expect(await response.json()).toEqual({ accept: null, beta: null });
      expect(await proxy.observed).toContain("Proxy-Authorization: Basic dXNlcjpzZWNyZXQ=");
    } finally {
      if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    }
  },
);

test("honors provider proxy environment and explicit direct override", async () => {
  await using target = await endpoint((stream) => {
    stream.respond({ ":status": 200 });
    stream.end("ok");
  });
  await using proxy = await proxyServer(false, Number(new URL(target.url).port));
  const previous = process.env.PI_PROXY_GOOGLE_ANTIGRAVITY;
  process.env.PI_PROXY_GOOGLE_ANTIGRAVITY = proxy.url;
  __resetProxyCache();
  try {
    const remote = new URL(target.url);
    remote.hostname = "ccpa.invalid";
    const options = post({ tls: { ca: cert, serverName: "localhost" } });
    delete options.proxy;
    const response = await antigravityFetch(remote, options);
    expect(await response.text()).toBe("ok");
    expect(await proxy.observed).toContain(`CONNECT ccpa.invalid:${remote.port} HTTP/1.1`);
    const direct = await antigravityFetch(target.url, post());
    expect(await direct.text()).toBe("ok");
  } finally {
    if (previous === undefined) delete process.env.PI_PROXY_GOOGLE_ANTIGRAVITY;
    else process.env.PI_PROXY_GOOGLE_ANTIGRAVITY = previous;
    __resetProxyCache();
  }
});
