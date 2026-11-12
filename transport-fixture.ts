import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http2 from "node:http2";
import type * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const { key, cert } = (() => {
  const directory = mkdtempSync(join(tmpdir(), "antigravity-transport-"));
  try {
    writeFileSync(
      join(directory, "openssl.cnf"),
      "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n",
    );
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-config",
        join(directory, "openssl.cnf"),
        "-keyout",
        join(directory, "key.pem"),
        "-out",
        join(directory, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    return {
      key: readFileSync(join(directory, "key.pem"), "utf8"),
      cert: readFileSync(join(directory, "cert.pem"), "utf8"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
})();

export async function listen(server: net.Server) {
  const ready = Promise.withResolvers<void>();
  server.once("error", ready.reject);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", ready.reject);
    ready.resolve();
  });
  await ready.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new TypeError("Missing loopback port.");
  return address.port;
}

export async function endpoint(
  handler: (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => void,
) {
  const server = http2.createSecureServer({ key, cert });
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
  });
  server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
    stream.on("error", () => {
      /* Client aborts are expected in cancellation cases. */
    });
    handler(stream, headers);
  });
  const port = await listen(server);
  return {
    url: `https://127.0.0.1:${port}/v1internal:streamGenerateContent?alt=sse`,
    async [Symbol.asyncDispose]() {
      for (const session of sessions) session.destroy();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

export function post(options: BunFetchRequestInit = {}): BunFetchRequestInit {
  return {
    method: "POST",
    body: "{}",
    proxy: false,
    tls: { ca: cert, serverName: "localhost" },
    ...options,
  };
}
