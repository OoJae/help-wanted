/**
 * Puts the app behind Node's own HTTP server. No framework: the app is a function from `Request`
 * to `Response`, and this file is the few lines that connect it to a socket.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { errorMessage, silentLogger, type Logger } from "../log.js";

export interface RunningServer {
  server: Server;
  /** The port actually bound: useful when 0 was asked for. */
  port: number;
  close(): Promise<void>;
}

/** Answers one Node request with the app. Exported so it can be tested without a socket. */
export async function answer(
  app: (request: Request) => Promise<Response>,
  incoming: Pick<IncomingMessage, "method" | "url" | "headers">,
  outgoing: Pick<ServerResponse, "writeHead" | "end">,
): Promise<void> {
  // The request body is never read: the API takes none, and anything but GET is refused by the app.
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === "string") headers.set(name, value);
  }
  const target = incoming.url ?? "/";
  if (target.length > 2048) {
    outgoing.writeHead(414, { "content-type": "application/json; charset=utf-8" });
    outgoing.end('{"error":"URL too long"}\n');
    return;
  }
  // Only the ordinary form "/path?query" is served; a full URL in the request line is not.
  if (!target.startsWith("/")) {
    outgoing.writeHead(400, { "content-type": "application/json; charset=utf-8" });
    outgoing.end('{"error":"unreadable request target"}\n');
    return;
  }
  const response = await app(
    new Request(`http://indexer.local${target}`, { method: incoming.method ?? "GET", headers }),
  );
  const body = response.body === null ? null : Buffer.from(await response.arrayBuffer());
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(body ?? undefined);
}

export function serve(
  app: (request: Request) => Promise<Response>,
  options: { host: string; port: number; log?: Logger },
): Promise<RunningServer> {
  const log = options.log ?? silentLogger;
  const server = createServer((incoming, outgoing) => {
    answer(app, incoming, outgoing).catch((error: unknown) => {
      log.error("could not answer a request", { error: errorMessage(error) });
      if (!outgoing.headersSent)
        outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      outgoing.end('{"error":"internal error"}\n');
    });
  });
  // A client that sends its request slowly, or never finishes, is cut off instead of held open.
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 64;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
