/**
 * Loaded before every test file: makes any attempt to use the network fail at once.
 *
 * The tests bring their own node (`fakeNode.ts`), their own database (PGlite in memory) and their
 * own scripted `fetch`. Anything that reaches for the real network is a mistake, and this turns it
 * into a failed test instead of a slow or flaky one.
 *
 * One connection can be let through, and only when it is asked for: with `TEST_DATABASE_URL` set
 * the tests run on a Postgres server (see `db.ts`), and a socket to that server's port is allowed
 * if the server is on this machine. Everything else is refused as before, `fetch` included.
 */
import net from "node:net";

const refuse = (what: string) => {
  throw new Error(`a test tried to use the network (${what}); tests must run offline`);
};

globalThis.fetch = ((input: unknown) => refuse(`fetch ${String(input)}`)) as typeof fetch;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** The port of the test database server, when one is configured and it is on this machine. */
function testDatabasePort(): number | null {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (!LOOPBACK.has(url.hostname)) {
    throw new Error("TEST_DATABASE_URL must point at this machine (127.0.0.1, localhost or ::1)");
  }
  return Number(url.port || 5432);
}

const databasePort = testDatabasePort();
const connect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function guarded(this: net.Socket, ...args: unknown[]) {
  // `connect(port, host)` or `connect({ port, host })`: the two forms a database driver uses.
  const [first, second] = args;
  const target =
    typeof first === "object" && first !== null
      ? (first as { port?: unknown; host?: unknown })
      : { port: first, host: second };
  const host = typeof target.host === "string" ? target.host : "localhost";
  if (databasePort !== null && Number(target.port) === databasePort && LOOPBACK.has(host)) {
    return (connect as (...inner: unknown[]) => net.Socket).apply(this, args);
  }
  return refuse("a socket connection");
} as typeof net.Socket.prototype.connect;
