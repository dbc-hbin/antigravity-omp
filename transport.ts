import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { connectProxiedSocket, getProxyForUrl } from "@oh-my-pi/pi-ai/utils/proxy";
import * as http from "node:http";
import * as http2 from "node:http2";
import { Readable, pipeline } from "node:stream";
import type * as tls from "node:tls";
import { createGunzip } from "node:zlib";

async function pem(
  value: Bun.TLSOptions["ca"],
): Promise<string | Buffer | Array<string | Buffer> | undefined> {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  return Promise.all(
    values.map(async (entry) => {
      if (typeof entry === "string") return entry;
      if (entry instanceof Blob) return Buffer.from(await entry.arrayBuffer());
      if (ArrayBuffer.isView(entry))
        return Buffer.from(entry.buffer, entry.byteOffset, entry.byteLength);
      return Buffer.from(entry);
    }),
  );
}

/** Native CCPA/OAuth transport; deliberately never delegates to Bun fetch. */
export const antigravityFetch: FetchImpl = async (input, init) => {
  if (input instanceof Request)
    throw new TypeError("Antigravity transport requires a string or URL.");
  const url = new URL(input);
  const options: BunFetchRequestInit = init ?? {};
  const method = options.method ?? "GET";
  if (
    (method !== "POST" || typeof options.body !== "string") &&
    (method !== "GET" || options.body !== undefined)
  ) {
    throw new TypeError("Antigravity transport requires a string POST body or a bodyless GET.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("Antigravity transport requires HTTP or HTTPS.");
  }
  if (options.unix || options.session)
    throw new TypeError("Unix sockets and fetch sessions are unsupported.");
  const explicitProxy = options.proxy;
  if (
    explicitProxy !== undefined &&
    explicitProxy !== false &&
    typeof explicitProxy !== "string" &&
    !(explicitProxy instanceof URL)
  ) {
    throw new TypeError("Antigravity transport requires a proxy URL or false.");
  }
  if (explicitProxy === "") throw new TypeError("Use false to explicitly disable the proxy.");
  const proxy =
    explicitProxy === false
      ? undefined
      : explicitProxy === undefined
        ? getProxyForUrl("google-antigravity", url)
        : explicitProxy.toString();
  if (proxy && !["http:", "https:"].includes(new URL(proxy).protocol)) {
    throw new TypeError("Antigravity transport supports HTTP and HTTPS CONNECT proxies.");
  }
  if (proxy && url.protocol === "http:")
    throw new TypeError("Plain HTTP is supported only without a proxy.");
  const headers = new Headers(options.headers);
  for (const name of [
    "accept",
    "anthropic-beta",
    "connection",
    "keep-alive",
    "proxy-connection",
    "transfer-encoding",
    "upgrade",
    "host",
  ]) {
    headers.delete(name);
  }
  if (!headers.has("accept-encoding")) headers.set("accept-encoding", "gzip");
  const userAgent = headers.get("user-agent");
  if (userAgent?.startsWith("antigravity/hub/")) {
    headers.set(
      "user-agent",
      userAgent
        .replace("antigravity/hub/", "antigravity/cli/")
        .replace(/\)$/, "; auth_method=consumer)"),
    );
  } else if (!userAgent) {
    headers.set("user-agent", "Go-http-client/2.0");
  }
  // The agent stream uses an unknown-length Go reader. Ordinary CCPA and
  // OAuth requests have a known length; GET requests carry no body.
  if (url.pathname === "/v1internal:streamGenerateContent") headers.delete("content-length");
  else if (typeof options.body === "string" && !headers.has("content-length"))
    headers.set("content-length", String(Buffer.byteLength(options.body)));
  const signal = options.signal ?? undefined;
  signal?.throwIfAborted();
  const tlsOptions: tls.ConnectionOptions = {
    ALPNProtocols: ["h2"],
    ...(options.tls?.rejectUnauthorized !== undefined
      ? { rejectUnauthorized: options.tls.rejectUnauthorized }
      : {}),
    ...(options.tls?.checkServerIdentity
      ? { checkServerIdentity: options.tls.checkServerIdentity }
      : {}),
    ...(options.tls?.serverName || options.tls?.servername
      ? { servername: options.tls.serverName ?? options.tls.servername }
      : {}),
  };
  const ca = await pem(options.tls?.ca);
  const cert = await pem(options.tls?.cert);
  const key = await pem(options.tls?.key);
  if (ca !== undefined) tlsOptions.ca = ca;
  if (cert !== undefined) tlsOptions.cert = cert;
  if (key !== undefined) tlsOptions.key = key;
  if (options.tls?.passphrase !== undefined) tlsOptions.passphrase = options.tls.passphrase;
  signal?.throwIfAborted();
  const socket = proxy
    ? await connectProxiedSocket(proxy, url.href, {
        ...(signal ? { signal } : {}),
        tls: tlsOptions,
      })
    : undefined;
  if (signal?.aborted) {
    socket?.destroy();
    signal.throwIfAborted();
  }
  const result = Promise.withResolvers<Response>();
  let session: http2.ClientHttp2Session | undefined;
  let request: http.ClientRequest | http2.ClientHttp2Stream | undefined;
  let body: Readable | undefined;
  let settled = false;
  let finished = false;
  const cleanup = (): void => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener("abort", abort);
    session?.destroy();
  };
  const fail = (error: Error): void => {
    if (!settled) {
      settled = true;
      result.reject(error);
    }
    body?.destroy(error);
    request?.destroy(error);
    cleanup();
  };
  const abort = (): void =>
    fail(
      signal?.reason instanceof Error
        ? signal.reason
        : new DOMException("The operation was aborted.", "AbortError"),
    );
  const receive = (source: Readable, status: number, responseHeaders: Headers): void => {
    if (settled) {
      source.destroy();
      return;
    }
    body = source;
    source.once("error", fail);
    source.once("end", cleanup);
    source.once("close", () => {
      if (!source.readableEnded)
        fail(new TypeError("Antigravity response closed before completion."));
    });
    const decoded =
      responseHeaders.get("content-encoding")?.toLowerCase() === "gzip"
        ? pipeline(source, createGunzip(), (error) => {
            if (error) fail(error);
          })
        : source;
    const reader = Readable.toWeb(decoded).getReader();
    const webBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) controller.close();
          else controller.enqueue(chunk.value);
        } catch (error) {
          controller.error(error instanceof Error ? error : new TypeError(String(error)));
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          request?.destroy();
          cleanup();
        }
      },
    });
    try {
      const response = new Response(status === 204 || status === 304 ? null : webBody, {
        status,
        headers: responseHeaders,
      });
      Object.defineProperty(response, "url", { value: url.href });
      settled = true;
      result.resolve(response);
    } catch (error) {
      fail(error instanceof Error ? error : new TypeError(String(error)));
    }
  };
  try {
    signal?.addEventListener("abort", abort, { once: true });
    if (url.protocol === "https:") {
      session = http2.connect(
        url.origin,
        socket ? { ...tlsOptions, createConnection: () => socket } : tlsOptions,
      );
      session.on("error", fail);
      session.once("close", () => {
        if (!settled)
          fail(new TypeError("Antigravity HTTP/2 session closed before response headers."));
      });
      const stream = session.request({
        ...Object.fromEntries(headers),
        ":method": method,
        ":path": `${url.pathname}${url.search}`,
      });
      request = stream;
      stream.once("close", () => {
        if (!settled)
          fail(new TypeError("Antigravity HTTP/2 request closed before response headers."));
      });
      stream.once("response", (received) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(received)) {
          if (name.startsWith(":")) continue;
          if (Array.isArray(value)) value.forEach((entry) => responseHeaders.append(name, entry));
          else if (value !== undefined) responseHeaders.set(name, String(value));
        }
        receive(stream, Number(received[":status"]), responseHeaders);
      });
    } else {
      request = http.request(
        url,
        { method, headers: Object.fromEntries(headers), agent: false },
        (message) => {
          const responseHeaders = new Headers();
          for (let index = 0; index < message.rawHeaders.length; index += 2) {
            const name = message.rawHeaders[index];
            const value = message.rawHeaders[index + 1];
            if (name !== undefined && value !== undefined) responseHeaders.append(name, value);
          }
          receive(message, message.statusCode ?? 0, responseHeaders);
        },
      );
    }
    request.on("error", fail);
    if (signal?.aborted) abort();
    else request.end(options.body);
  } catch (error) {
    socket?.destroy();
    fail(error instanceof Error ? error : new TypeError(String(error)));
  }
  return result.promise;
};
