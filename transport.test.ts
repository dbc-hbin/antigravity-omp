import { afterEach, expect, spyOn, test } from "bun:test";
import { __resetProxyCache } from "@oh-my-pi/pi-ai/utils/proxy";
import * as http from "node:http";
import * as http2 from "node:http2";
import * as net from "node:net";
import * as tls from "node:tls";
import { createGzip } from "node:zlib";
import { antigravityFetch, closeAntigravityTransport } from "./transport";
import { cert, endpoint, key, listen, post } from "./transport-fixture";

afterEach(closeAntigravityTransport);

test.each(["record", "Headers"])(
  "omits compatibility headers at the HTTPS boundary with %s headers",
  async (kind) => {
    const observed = Promise.withResolvers<http.IncomingHttpHeaders>();
    await using target = await endpoint((request, response) => {
      observed.resolve(request.headers);
      response.end("ok");
    });
    const values = {
      Accept: "*/*",
      "Anthropic-Beta": "must-not-leak",
      "X-Ccpa-Test": "retained",
      "User-Agent":
        "antigravity/hub/1.5.9 (aidev_client; os_type=darwin; arch=arm64; cl=1021519450)",
    };
    const response = await antigravityFetch(
      target.url,
      post({ headers: kind === "Headers" ? new Headers(values) : values }),
    );
    await response.text();
    const headers = await observed.promise;
    expect(headers.accept).toBeUndefined();
    expect(headers["anthropic-beta"]).toBeUndefined();
    expect(headers.connection).toBeUndefined();
    expect(headers["x-ccpa-test"]).toBe("retained");
    expect(headers["user-agent"]).toBe(
      "antigravity/cli/1.5.9 (aidev_client; os_type=darwin; arch=arm64; cl=1021519450; auth_method=consumer)",
    );
    expect(headers["content-length"]).toBeUndefined();
    expect(headers["transfer-encoding"]).toBe("chunked");
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
  await using target = await endpoint((_request, stream) => {
    stream.writeHead(200, {
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
  await using target = await endpoint((_request, stream) => {
    connections++;
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
  await using target = await endpoint((_request, stream) => {
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
  "closes the HTTP/1.1 connection on %s cancellation",
  async (phase) => {
    const arrived = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    await using target = await endpoint((_request, stream) => {
      stream.once("close", () => closed.resolve());
      if (phase !== "headers") {
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

async function proxyServer(secure: boolean, targetPort: number, stalled = false) {
  const observed = Promise.withResolvers<string>();
  const closed = Promise.withResolvers<void>();
  const requests: string[] = [];
  const sockets = new Set<net.Socket>();
  const accept = (socket: net.Socket): void => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      closed.resolve();
    });
    socket.on("error", () => {
      /* Peer cancellation closes fixture tunnels. */
    });
    let request = "";
    const receive = (chunk: Buffer): void => {
      request += chunk.toString();
      if (!request.includes("\r\n\r\n")) return;
      socket.off("data", receive);
      requests.push(request);
      observed.resolve(request);
      if (stalled) return;
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
    closed: closed.promise,
    requests,
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
    const ports = new Set<number | undefined>();
    await using target = await endpoint((request, stream) => {
      ports.add(request.socket.remotePort);
      const headers = request.headers;
      stream.end(
        JSON.stringify({
          accept: headers.accept ?? null, beta: headers["anthropic-beta"] ?? null,
          connection: headers.connection ?? null,
        }),
      );
    });
    await using proxy = await proxyServer(secure, Number(new URL(target.url).port));
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    // The fixture proxy has an ephemeral self-signed certificate. Target CA trust is tested separately.
    if (secure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      for (let count = 0; count < 2; count++) {
        const response = await antigravityFetch(
          target.url,
          post({ proxy: proxy.url, headers: { Accept: "*/*", "anthropic-beta": "removed" } }),
        );
        expect(await response.json()).toEqual({ accept: null, beta: null, connection: null });
      }
      expect(await proxy.observed).toContain("Proxy-Authorization: Basic dXNlcjpzZWNyZXQ=");
      expect(proxy.requests).toHaveLength(1);
      expect(ports.size).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    }
  },
);

test("honors provider proxy environment and explicit direct override", async () => {
  await using target = await endpoint((_request, stream) => {
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

test("negotiates HTTP/1.1 even when the HTTPS target offers HTTP/2", async () => {
  const sockets = new Set<net.Socket>();
  const server = http2.createSecureServer({ key, cert, allowHTTP1: true });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("request", (request, response) => {
    response.end(JSON.stringify({
      version: request.httpVersion,
      alpn: (request.socket as tls.TLSSocket).alpnProtocol,
    }));
  });
  const port = await listen(server);
  try {
    const response = await antigravityFetch(`https://127.0.0.1:${port}/oauth`, post());
    expect(await response.json()).toEqual({ version: "1.1", alpn: "http/1.1" });
  } finally {
    for (const socket of sockets) socket.destroy();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  }
});

test.each([false, true])("preserves UTF-8 bytes with stream request framing=%s", async (streaming) => {
  const body = "한국어 😀\u0000 finish";
  const observed = Promise.withResolvers<{
    headers: http.IncomingHttpHeaders; rawHeaders: string[]; body: Buffer;
  }>();
  await using target = await endpoint((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      observed.resolve({ headers: request.headers, rawHeaders: request.rawHeaders, body: Buffer.concat(chunks) });
      response.end("ok");
    });
  });
  const url = new URL(target.url);
  if (!streaming) url.pathname = "/v1internal:loadCodeAssist";
  const response = await antigravityFetch(url, post({ body }));
  expect(await response.text()).toBe("ok");
  const received = await observed.promise;
  expect(received.body).toEqual(Buffer.from(body));
  expect(received.headers["content-length"]).toBe(streaming ? undefined : String(Buffer.byteLength(body)));
  expect(received.headers["transfer-encoding"]).toBe(streaming ? "chunked" : undefined);
  expect(received.rawHeaders.filter((_value, index) => index % 2 === 0).slice(0, 3))
    .toEqual(["Host", "User-Agent", streaming ? "Transfer-Encoding" : "Content-Length"]);
});

test("GET uses the Go HTTP/1.1 fallback UA and no body framing", async () => {
  const observed = Promise.withResolvers<http.IncomingHttpHeaders>();
  await using target = await endpoint((request, response) => {
    observed.resolve(request.headers);
    response.end("ok");
  });
  const options: BunFetchRequestInit = {
    method: "GET", proxy: false, tls: { ca: cert, serverName: "localhost" },
    headers: { "Content-Length": "123", "Transfer-Encoding": "chunked", "X-Custom": "retained" },
  };
  const response = await antigravityFetch(target.url, options);
  await response.text();
  const headers = await observed.promise;
  expect(headers["user-agent"]).toBe("Go-http-client/1.1");
  expect(headers["content-length"]).toBeUndefined();
  expect(headers["transfer-encoding"]).toBeUndefined();
  expect(headers["x-custom"]).toBe("retained");
});

test("reuses eligible HTTPS connections and explicitly shuts down the pool", async () => {
  const ports: Array<number | undefined> = [];
  const connectionHeaders: Array<string | undefined> = [];
  await using target = await endpoint((request, response) => {
    ports.push(request.socket.remotePort);
    connectionHeaders.push(request.headers.connection);
    request.resume();
    response.end("ok");
  });
  for (let count = 0; count < 2; count++) {
    const response = await antigravityFetch(target.url, post());
    await response.text();
  }
  expect(ports[1]).toBe(ports[0]);
  closeAntigravityTransport();
  const response = await antigravityFetch(target.url, post());
  await response.text();
  expect(ports[2]).not.toBe(ports[0]);
  expect(connectionHeaders).toEqual([undefined, undefined, undefined]);
});

test("reuses plain HTTP loopback connections", async () => {
  const ports = new Set<number | undefined>();
  const server = http.createServer((request, response) => {
    ports.add(request.socket.remotePort);
    request.resume();
    response.end("ok");
  });
  const port = await listen(server);
  try {
    const options: BunFetchRequestInit = { proxy: false };
    for (let count = 0; count < 2; count++) {
      const response = await antigravityFetch(`http://127.0.0.1:${port}`, options);
      await response.text();
    }
    expect(ports.size).toBe(1);
  } finally {
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  }
});

test("does not reuse sockets across proxy identities or direct traffic", async () => {
  const ports: Array<number | undefined> = [];
  await using target = await endpoint((request, response) => {
    ports.push(request.socket.remotePort);
    request.resume();
    response.end("ok");
  });
  await using first = await proxyServer(false, Number(new URL(target.url).port));
  await using second = await proxyServer(false, Number(new URL(target.url).port));
  const otherCredentials = new URL(first.url);
  otherCredentials.username = "other";
  otherCredentials.password = "password";
  for (const proxy of [first.url, second.url, false, first.url, second.url, otherCredentials.href, first.url] as const) {
    const response = await antigravityFetch(target.url, post({ proxy }));
    await response.text();
  }
  expect(new Set(ports.slice(0, 3)).size).toBe(3);
  expect(ports[3]).toBe(ports[0]);
  expect(ports[4]).toBe(ports[1]);
  expect(ports[5]).not.toBe(ports[0]);
  expect(ports[6]).toBe(ports[0]);
  expect(first.requests).toHaveLength(2);
  expect(first.requests[1]).toContain("Proxy-Authorization: Basic b3RoZXI6cGFzc3dvcmQ=");
  expect(second.requests).toHaveLength(1);
});

test.each([false, true])("isolates TLS verification and identity callbacks with proxy=%s", async (proxied) => {
  await using target = await endpoint((request, response) => {
    request.resume();
    response.end("ok");
  });
  await using proxy = await proxyServer(false, Number(new URL(target.url).port));
  const route = proxied ? proxy.url : false;
  const trusted = await antigravityFetch(target.url, post({ proxy: route }));
  await trusted.text();
  const untrusted = await antigravityFetch(target.url, post({ proxy: route, tls: {} }))
    .catch((error: unknown) => error);
  expect(untrusted).toBeInstanceOf(Error);
  const wrongName = await antigravityFetch(target.url, post({
    proxy: route, tls: { ca: cert, serverName: "not-localhost.invalid" },
  })).catch((error: unknown) => error);
  expect(wrongName).toBeInstanceOf(Error);
  const denied = await antigravityFetch(target.url, post({
    proxy: route,
    tls: { ca: cert, serverName: "localhost", checkServerIdentity: () => new Error("identity denied") },
  })).catch((error: unknown) => error);
  expect(denied).toMatchObject({ message: "identity denied" });
});

test("preserves custom CA and client-certificate authentication", async () => {
  await using target = await endpoint((request, response) => {
    response.end(String((request.socket as tls.TLSSocket).authorized));
  }, { requestCert: true, rejectUnauthorized: true, ca: cert });
  const response = await antigravityFetch(target.url, post({
    tls: { ca: cert, cert, key, serverName: "localhost" },
  }));
  expect(await response.text()).toBe("true");
  const missing = await antigravityFetch(target.url, post()).catch((error: unknown) => error);
  expect(missing).toBeInstanceOf(Error);
});

test.each(["CONNECT", "TLS"])("aborts an in-progress proxy %s handshake without orphan sockets", async (phase) => {
  const reached = Promise.withResolvers<void>();
  const upstreamSockets = new Set<net.Socket>();
  const upstream = net.createServer((socket) => {
    upstreamSockets.add(socket);
    socket.once("close", () => upstreamSockets.delete(socket));
    socket.on("error", () => {});
    reached.resolve();
  });
  const port = await listen(upstream);
  await using proxy = await proxyServer(false, port, phase === "CONNECT");
  try {
    const controller = new AbortController();
    const pending = antigravityFetch(`https://127.0.0.1:${port}`, post({
      proxy: proxy.url, signal: controller.signal,
    })).catch((error: unknown) => error);
    if (phase === "CONNECT") await proxy.observed;
    else await reached.promise;
    controller.abort(new DOMException("handshake cancelled", "AbortError"));
    expect(await pending).toMatchObject({ name: "AbortError", message: "handshake cancelled" });
    await proxy.closed;
  } finally {
    for (const socket of upstreamSockets) socket.destroy();
    const closed = Promise.withResolvers<void>();
    upstream.close(() => closed.resolve());
    await closed.promise;
  }
});

test("final shutdown aborts pending proxy connections", async () => {
  await using proxy = await proxyServer(false, 1, true);
  const pending = antigravityFetch("https://127.0.0.1:1", post({ proxy: proxy.url }))
    .catch((error: unknown) => error);
  await proxy.observed;
  closeAntigravityTransport();
  expect(await pending).toBeInstanceOf(Error);
  await proxy.closed;
});

test.each([301, 302, 303, 307, 308])("follows %s redirects with safe method and string-body replay", async (status) => {
  const seen: Array<{ method: string | undefined; body: string; authorization: string | undefined }> = [];
  await using target = await endpoint((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      seen.push({ method: request.method, body, authorization: request.headers.authorization });
      if (request.url?.startsWith("/first")) {
        response.writeHead(status, { Location: "/last" });
        response.end("redirect");
      } else response.end("done");
    });
  });
  const first = new URL("/first", target.url);
  const response = await antigravityFetch(first, post({
    body: "utf8 한글", headers: { Authorization: "Bearer retained" },
  }));
  expect(await response.text()).toBe("done");
  expect(response.url).toBe(new URL("/last", target.url).href);
  expect(response.redirected).toBe(true);
  expect(seen[1]).toEqual({
    method: status < 307 ? "GET" : "POST",
    body: status < 307 ? "" : "utf8 한글",
    authorization: "Bearer retained",
  });
});

test("strips credentials across redirect domains and HTTPS downgrades", async () => {
  const seen = Promise.withResolvers<http.IncomingHttpHeaders>();
  const server = http.createServer((request, response) => {
    seen.resolve(request.headers);
    response.end("done");
  });
  const ready = Promise.withResolvers<void>();
  server.once("error", ready.reject);
  // Listen on both loopback families so localhost DNS ordering is immaterial.
  server.listen(0, () => ready.resolve());
  await ready.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new TypeError("Missing loopback port.");
  const port = address.port;
  try {
    await using target = await endpoint((_request, response) => {
      response.writeHead(302, { Location: `http://localhost:${port}/last` });
      response.end();
    });
    const response = await antigravityFetch(target.url, post({
      headers: { Authorization: "Bearer secret", Cookie: "session=secret", Referer: "https://secret.invalid/" },
    }));
    expect(await response.text()).toBe("done");
    const headers = await seen.promise;
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(headers.referer).toBeUndefined();
  } finally {
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  }
});

test("stops default redirect loops after ten requests", async () => {
  let requests = 0;
  await using target = await endpoint((_request, response) => {
    requests++;
    response.writeHead(302, { Location: "/again" });
    response.end();
  });
  const error = await antigravityFetch(target.url, post()).catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(TypeError);
  expect(requests).toBe(10);
});

test.each([307, 308])("does not replay unknown-length generation bodies after %s", async (status) => {
  let requests = 0;
  await using target = await endpoint((_request, response) => {
    requests++;
    response.writeHead(status, { Location: "/must-not-generate-again" });
    response.end("not replayed");
  });
  const response = await antigravityFetch(target.url, post());
  expect(response.status).toBe(status);
  expect(response.redirected).toBe(false);
  expect(await response.text()).toBe("not replayed");
  expect(requests).toBe(1);
});

test("keeps explicit caller user-agent and encoding headers", async () => {
  const observed = Promise.withResolvers<http.IncomingHttpHeaders>();
  await using target = await endpoint((request, response) => {
    observed.resolve(request.headers);
    response.end("ok");
  });
  const response = await antigravityFetch(target.url, post({
    headers: { "User-Agent": "caller-agent", "Accept-Encoding": "identity", "X-Other": "unchanged" },
  }));
  await response.text();
  expect(await observed.promise).toMatchObject({
    "user-agent": "caller-agent", "accept-encoding": "identity", "x-other": "unchanged",
  });
});

test.each(["TCP dial", "TLS handshake"])("bounds the direct %s stage without a response deadline", async (stage) => {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    // Accept TCP but deliberately never complete a TLS handshake.
  });
  const port = await listen(server);
  const duration = stage === "TCP dial" ? 30_000 : 10_000;
  const deadline = Promise.withResolvers<() => void>();
  const nativeSetTimeout = globalThis.setTimeout;
  const interceptTimeout = Object.assign((handler: TimerHandler, milliseconds?: number, ...args: unknown[]) => {
    const timer = Reflect.apply(nativeSetTimeout, globalThis, [handler, milliseconds, ...args]);
    if (milliseconds === duration && typeof handler === "function")
      deadline.resolve(() => handler(...args));
    return timer;
  }, { __promisify__: nativeSetTimeout.__promisify__ });
  // Forward every overload unchanged; Bun and Node's merged timer signatures
  // cannot express this variadic wrapper as one inferred function signature.
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(interceptTimeout as typeof setTimeout);
  try {
    const pending = antigravityFetch(`https://127.0.0.1:${port}`, post())
      .catch((error: unknown) => error);
    // Invoke only the captured stage deadline; no wall-clock sleeps or real
    // thirty-second stalls are required, and normal socket events still run.
    const expire = await deadline.promise;
    expire();
    expect(await pending).toMatchObject({
      code: "ETIMEDOUT", message: `Antigravity ${stage} timed out.`,
    });
  } finally {
    timers.mockRestore();
    for (const socket of sockets) socket.destroy();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  }
});

test("limits each transport to 100 idle sockets across origins without capping active requests", async () => {
  const waiting: http.ServerResponse[] = [];
  const firstSockets = new Set<net.Socket>();
  const evicted = Promise.withResolvers<void>();
  const first = http.createServer((_request, response) => {
    waiting.push(response);
    // All one hundred requests must be active before any connection goes idle.
    if (waiting.length === 100) {
      for (const pending of waiting) pending.end("ok");
    }
  });
  first.on("connection", (socket) => {
    firstSockets.add(socket);
    socket.once("close", () => {
      firstSockets.delete(socket);
      evicted.resolve();
    });
  });
  const second = http.createServer((_request, response) => response.end("ok"));
  const firstPort = await listen(first);
  const secondPort = await listen(second);
  const options: BunFetchRequestInit = { proxy: false };
  try {
    await Promise.all(Array.from({ length: 100 }, async () => {
      const response = await antigravityFetch(`http://127.0.0.1:${firstPort}`, options);
      expect(await response.text()).toBe("ok");
    }));
    expect(firstSockets.size).toBe(100);
    const otherOrigin = await antigravityFetch(`http://127.0.0.1:${secondPort}`, options);
    expect(await otherOrigin.text()).toBe("ok");
    await evicted.promise;
    expect(firstSockets.size).toBe(99);
  } finally {
    for (const server of [first, second]) {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    }
  }
});
