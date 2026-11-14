import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { connectProxiedSocket, getProxyForUrl } from "@oh-my-pi/pi-ai/utils/proxy";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
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

const agents = new Map<http.Agent, Map<net.Socket, NodeJS.Timeout>>();
const secureAgents = new Map<
  string,
  Map<tls.ConnectionOptions["checkServerIdentity"], https.Agent>
>();
const pendingTunnels = new Set<AbortController>();
let plainAgent: http.Agent | undefined;

function connectionDeadlines(socket: net.Socket, secure: boolean): void {
  let timer: NodeJS.Timeout | undefined;
  const cleanup = (): void => {
    clearTimeout(timer);
    socket.off("connect", connected);
    socket.off("secureConnect", cleanup);
    socket.off("error", cleanup);
    socket.off("close", cleanup);
  };
  const expire = (stage: string): void => {
    cleanup();
    socket.destroy(Object.assign(new Error(`Antigravity ${stage} timed out.`), { code: "ETIMEDOUT" }));
  };
  const connected = (): void => {
    clearTimeout(timer);
    if (secure) {
      timer = setTimeout(() => expire("TLS handshake"), 10_000);
      timer.unref();
    } else cleanup();
  };
  socket.once("error", cleanup);
  socket.once("close", cleanup);
  if (secure) socket.once("secureConnect", cleanup);
  if (socket.connecting) {
    timer = setTimeout(() => expire("TCP dial"), 30_000);
    timer.unref();
    socket.once("connect", connected);
  } else connected();
}

function retainAgent<T extends http.Agent>(agent: T): T {
  const idleSockets = new Map<net.Socket, NodeJS.Timeout>();
  const tracked = new WeakSet<net.Socket>();
  const clearIdle = (socket: net.Socket): void => {
    clearTimeout(idleSockets.get(socket));
    idleSockets.delete(socket);
  };
  const create = agent.createConnection;
  agent.createConnection = function (options, callback) {
    const socket = create.call(this, options, callback);
    if (socket instanceof net.Socket) connectionDeadlines(socket, this instanceof https.Agent);
    return socket;
  };
  // Only free sockets expire. A timeout on the Agent itself would also limit SSE.
  agent.on("free", (socket: net.Socket) => {
    // Agent's own free listener may immediately assign this socket to a queued
    // request. Never arm an idle timer on that now-active connection.
    let free = false;
    for (const name in agent.freeSockets) {
      if (agent.freeSockets[name]?.includes(socket)) {
        free = true;
        break;
      }
    }
    if (!free) return;
    clearIdle(socket);
    const timer = setTimeout(() => {
      clearIdle(socket);
      socket.destroy();
    }, 90_000);
    timer.unref();
    idleSockets.set(socket, timer);
    if (idleSockets.size > 100) {
      const oldest = idleSockets.keys().next().value;
      if (oldest) {
        clearIdle(oldest);
        oldest.destroy();
      }
    }
    if (!tracked.has(socket)) {
      tracked.add(socket);
      socket.once("close", () => clearIdle(socket));
    }
  });
  const reuse = agent.reuseSocket;
  agent.reuseSocket = function (socket, request) {
    clearIdle(socket as net.Socket);
    reuse.call(this, socket, request);
  };
  agents.set(agent, idleSockets);
  return agent;
}

/** Releases pooled connections and pending proxy handshakes at final extension shutdown. */
export function closeAntigravityTransport(): void {
  for (const controller of pendingTunnels) controller.abort();
  for (const [agent, idleSockets] of agents) {
    for (const timer of idleSockets.values()) clearTimeout(timer);
    idleSockets.clear();
    agent.destroy();
  }
  agents.clear();
  secureAgents.clear();
  plainAgent = undefined;
}

function transportAgent(
  url: URL,
  proxy: string | undefined,
  tlsOptions: tls.ConnectionOptions,
): http.Agent {
  if (url.protocol === "http:")
    return (plainAgent ??= retainAgent(new http.Agent({
      keepAlive: true, keepAliveMsecs: 30_000, maxFreeSockets: 100,
    })));
  const key = proxy ?? "";
  let profiles = secureAgents.get(key);
  if (!profiles) secureAgents.set(key, (profiles = new Map()));
  let agent = profiles.get(tlsOptions.checkServerIdentity);
  if (agent) return agent;
  agent = retainAgent(
    new https.Agent({
      keepAlive: true, keepAliveMsecs: 30_000, maxFreeSockets: 100, maxCachedSessions: 0,
    }),
  );
  if (proxy) {
    agent.createConnection = (connectionOptions, callback) => {
      const options = connectionOptions as tls.ConnectionOptions & {
        hostname?: string;
        host: string;
        port: number;
        antigravitySignal?: AbortSignal;
      };
      const controller = new AbortController();
      pendingTunnels.add(controller);
      const signal = options.antigravitySignal
        ? AbortSignal.any([controller.signal, options.antigravitySignal])
        : controller.signal;
      const target = new URL("https://localhost");
      target.hostname = options.hostname ?? options.host;
      target.port = String(options.port);
      void connectProxiedSocket(proxy, target.href, { signal, tls: options }).then(
        (socket) => {
          pendingTunnels.delete(controller);
          // Cancellation may race with the async CONNECT/TLS completion. Never hand
          // an already-aborted request an otherwise orphaned live tunnel.
          if (signal.aborted) {
            socket.destroy();
            callback?.(new DOMException("The operation was aborted.", "AbortError"), undefined!);
          } else callback?.(null, socket);
        },
        (error: Error) => {
          pendingTunnels.delete(controller);
          callback?.(error, undefined!);
        },
      );
      return undefined;
    };
  }
  profiles.set(tlsOptions.checkServerIdentity, agent);
  return agent;
}

async function requestOnce(
  url: URL,
  options: BunFetchRequestInit,
  method: string,
  requestBody: string | undefined,
  headers: Headers,
  tlsOptions: tls.ConnectionOptions,
): Promise<Response> {
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
  // The agent stream uses an unknown-length Go reader. Ordinary CCPA and
  // OAuth requests have a known length; GET requests carry no body.
  if (method === "GET") headers.delete("content-length");
  else if (url.pathname === "/v1internal:streamGenerateContent") {
    headers.delete("content-length");
    headers.set("transfer-encoding", "chunked");
  } else {
    headers.delete("transfer-encoding");
    if (!headers.has("content-length"))
      headers.set("content-length", String(Buffer.byteLength(requestBody ?? "")));
  }
  if (method === "GET") headers.delete("transfer-encoding");
  const signal = options.signal ?? undefined;
  signal?.throwIfAborted();
  const result = Promise.withResolvers<Response>();
  let request: http.ClientRequest | undefined;
  let body: Readable | undefined;
  let settled = false;
  let finished = false;
  const cleanup = (): void => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener("abort", abort);
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
    decoded.once("end", cleanup);
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
    const wireHeaders: http.OutgoingHttpHeaders = {
      Host: url.host,
      "User-Agent": headers.get("user-agent") ?? "Go-http-client/1.1",
    };
    const contentLength = headers.get("content-length");
    if (contentLength !== null) wireHeaders["Content-Length"] = contentLength;
    const transferEncoding = headers.get("transfer-encoding");
    if (transferEncoding !== null) wireHeaders["Transfer-Encoding"] = transferEncoding;
    for (const [name, value] of headers) {
      if (["host", "user-agent", "content-length", "transfer-encoding", "accept-encoding"].includes(name)) continue;
      wireHeaders[name.replace(/(^|-)[a-z]/g, (part) => part.toUpperCase())] = value;
    }
    const encoding = headers.get("accept-encoding");
    if (encoding !== null) wireHeaders["Accept-Encoding"] = encoding;
    const requestOptions: https.RequestOptions & { antigravitySignal?: AbortSignal } = {
      ...tlsOptions,
      method,
      headers: wireHeaders,
      setDefaultHeaders: false,
      setHost: false,
      agent: transportAgent(url, proxy, tlsOptions),
      ...(signal ? { antigravitySignal: signal } : {}),
    };
    request = (url.protocol === "https:" ? https.request : http.request)(
        url,
        requestOptions,
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
    request.on("error", fail);
    request.once("close", () => {
      if (!settled) fail(new TypeError("Antigravity request closed before response headers."));
    });
    if (signal?.aborted) abort();
    else {
      // end(body) lets Node infer Content-Length, unlike Go's unknown-length
      // stream reader. Writing separately preserves chunked request framing.
      if (requestBody !== undefined) request.write(requestBody);
      request.end();
    }
  } catch (error) {
    fail(error instanceof Error ? error : new TypeError(String(error)));
  }
  return result.promise;
}

/** Native HTTP/1.1 CCPA/OAuth transport; deliberately never delegates to Bun fetch. */
export const antigravityFetch: FetchImpl = async (input, init) => {
  if (input instanceof Request)
    throw new TypeError("Antigravity transport requires a string or URL.");
  let url = new URL(input);
  const options: BunFetchRequestInit = init ?? {};
  let method = options.method ?? "GET";
  if (
    (method !== "POST" || typeof options.body !== "string") &&
    (method !== "GET" || options.body !== undefined)
  ) {
    throw new TypeError("Antigravity transport requires a string POST body or a bodyless GET.");
  }
  let requestBody = typeof options.body === "string" ? options.body : undefined;
  const headers = new Headers(options.headers);
  const explicitReferer = headers.get("referer");
  for (const name of [
    "accept", "anthropic-beta", "connection", "keep-alive", "proxy-connection",
    "transfer-encoding", "upgrade", "host",
  ]) headers.delete(name);
  if (!headers.has("accept-encoding")) headers.set("accept-encoding", "gzip");
  const userAgent = headers.get("user-agent");
  if (userAgent?.startsWith("antigravity/hub/")) {
    headers.set("user-agent", userAgent.replace("antigravity/hub/", "antigravity/cli/")
      .replace(/\)$/, "; auth_method=consumer)"));
  } else if (!userAgent) headers.set("user-agent", "Go-http-client/1.1");
  options.signal?.throwIfAborted();
  const tlsOptions: tls.ConnectionOptions = {
    ALPNProtocols: ["http/1.1"],
    ...(options.tls?.rejectUnauthorized !== undefined
      ? { rejectUnauthorized: options.tls.rejectUnauthorized } : {}),
    ...(options.tls?.checkServerIdentity
      ? { checkServerIdentity: options.tls.checkServerIdentity } : {}),
    ...(options.tls?.serverName || options.tls?.servername
      ? { servername: options.tls.serverName ?? options.tls.servername } : {}),
  };
  const ca = await pem(options.tls?.ca);
  const cert = await pem(options.tls?.cert);
  const key = await pem(options.tls?.key);
  if (ca !== undefined) tlsOptions.ca = ca;
  if (cert !== undefined) tlsOptions.cert = cert;
  if (key !== undefined) tlsOptions.key = key;
  if (options.tls?.passphrase !== undefined) tlsOptions.passphrase = options.tls.passphrase;
  for (let redirects = 0; ; redirects++) {
    const response = await requestOnce(url, options, method, requestBody, new Headers(headers), tlsOptions);
    const location = response.headers.get("location");
    const unknownLengthReplay = method === "POST" &&
      url.pathname === "/v1internal:streamGenerateContent" && [307, 308].includes(response.status);
    // Native io.NopCloser hides bytes.Reader from Go's GetBody detection.
    // A redirect must not silently issue another potentially charged generation.
    if (![301, 302, 303, 307, 308].includes(response.status) || !location ||
      options.redirect === "manual" || (unknownLengthReplay && options.redirect !== "error")) {
      Object.defineProperty(response, "redirected", { value: redirects > 0 });
      return response;
    }
    if (options.redirect === "error" || redirects === 9) {
      await response.body?.cancel();
      throw new TypeError(options.redirect === "error"
        ? "Antigravity redirect mode forbids redirects." : "Antigravity stopped after 10 redirects.");
    }
    let next: URL;
    try {
      next = new URL(location, url);
      if (next.protocol !== "https:" && next.protocol !== "http:")
        throw new TypeError("Antigravity redirects require HTTP or HTTPS.");
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    // Go permits sensitive headers only to the same host or a subdomain. Once
    // stripped they stay stripped, including a subsequent redirect back home.
    if (next.hostname !== url.hostname &&
      (net.isIP(url.hostname.replace(/^\[|\]$/g, "")) || !next.hostname.endsWith(`.${url.hostname}`))) {
      for (const name of ["authorization", "www-authenticate", "cookie", "cookie2"])
        headers.delete(name);
    }
    if (url.protocol === "https:" && next.protocol === "http:") headers.delete("referer");
    else if (!explicitReferer) {
      const referer = new URL(url);
      referer.username = "";
      referer.password = "";
      referer.hash = "";
      headers.set("referer", referer.href);
    }
    if ([301, 302, 303].includes(response.status) && method === "POST") {
      method = "GET";
      requestBody = undefined;
      headers.delete("content-length");
    }
    // Bound redirect-body draining as Go does, retaining small responses for
    // connection reuse without buffering arbitrarily large redirect bodies.
    const reader = response.body?.getReader();
    if (reader) {
      try {
        let drained = 0;
        while (drained <= 2048) {
          const chunk = await reader.read();
          if (chunk.done) break;
          drained += chunk.value.byteLength;
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    }
    url = next;
  }
};
