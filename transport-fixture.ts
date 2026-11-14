import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type * as http from "node:http";
import * as https from "node:https";
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
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
  options: https.ServerOptions = {},
) {
  const server = https.createServer({ key, cert, ALPNProtocols: ["http/1.1"], ...options }, (request, response) => {
    response.on("error", () => {
      /* Client aborts are expected in cancellation cases. */
    });
    handler(request, response);
  });
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const port = await listen(server);
  return {
    url: `https://127.0.0.1:${port}/v1internal:streamGenerateContent?alt=sse`,
    async [Symbol.asyncDispose]() {
      for (const socket of sockets) socket.destroy();
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
