#!/usr/bin/env -S npx tsx
/**
 * The indexer's command line.
 *
 *   run                         sync, mirror the API and serve the read-only API until stopped
 *   once [--mirror]             one sync pass (and one mirror pass), then exit
 *   backfill --module <name> --from <block>
 *                               read an older range for one module, down to <block>
 *   skip --module <name> --to <block|latest-N>
 *                               give up the blocks a module cannot read any more and start its
 *                               coverage again at <block> (or N blocks behind the head)
 *   reproject [--module <name>] rebuild modules' tables from the stored events
 *   rewind --to <block>         discard everything above <block> and read it again on the next sync
 *   snapshot [--out <dir>] [--through <block>]
 *                               write the deterministic JSON files of the evidence pack, cut at
 *                               the node's finalized block or at <block>
 *   status                      print what is stored
 *   migrate                     create or update the tables, then exit
 *
 * Results go to stdout as JSON; logs go to stderr.
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createChainClient } from "./chain/client.js";
import { loadConfig, parseStartBlock, type Config } from "./config.js";
import { openDatabase } from "./db/client.js";
import { createLogger, errorMessage, parseLogLevel } from "./log.js";
import { createQueries } from "./queries.js";
import { openRuntime, protectSecrets, runForever } from "./run.js";
import { chooseCut, DEFAULT_SNAPSHOT_DIR, writeSnapshot } from "./snapshot.js";

const USAGE = `usage: hw-indexer <command>

  run                           sync, mirror and serve until stopped
  once [--mirror]               one sync pass (and one mirror pass), then exit
  backfill --module <name> --from <block>
  skip --module <name> --to <block|latest-N>
  reproject [--module <name>]
  rewind --to <block>
  snapshot [--out <dir>] [--through <block>]
  status
  migrate

Configuration is read from the environment; see .env.example.`;

function print(value: unknown): void {
  const text = JSON.stringify(
    value,
    (_key, inner: unknown) => (typeof inner === "bigint" ? inner.toString(10) : inner),
    2,
  );
  process.stdout.write(`${text}\n`);
}

function blockArg(raw: string | undefined, name: string): number {
  if (raw === undefined || !/^[0-9]{1,15}$/.test(raw)) throw new Error(`--${name} must be a block number`);
  return Number(raw);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return command ? 0 : 1;
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      mirror: { type: "boolean", default: false },
      module: { type: "string", multiple: true },
      from: { type: "string" },
      to: { type: "string" },
      out: { type: "string" },
      through: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  const log = createLogger(parseLogLevel(process.env.LOG_LEVEL));
  const config: Config = loadConfig();
  protectSecrets(config);

  switch (command) {
    case "run": {
      const controller = new AbortController();
      const stop = () => {
        if (controller.signal.aborted) process.exit(130);
        log.info("stopping; press again to stop at once");
        controller.abort();
        // A request in flight may take a while to give up; do not wait for it for ever.
        setTimeout(() => process.exit(0), 10_000).unref();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      await runForever(config, log, controller.signal);
      return 0;
    }

    case "once": {
      const runtime = await openRuntime(config, log);
      try {
        const sync = await runtime.indexer.tick();
        const mirror = values.mirror && config.mirror.enabled ? await runtime.mirror.runOnce() : null;
        const stored = await createQueries(runtime.database.db, { house: config.houseAddresses }).status();
        print({ sync, mirror, stored });
        return sync.failed.length > 0 || (mirror?.failed.length ?? 0) > 0 ? 2 : 0;
      } finally {
        await runtime.close();
      }
    }

    case "backfill": {
      const [module] = values.module ?? [];
      if (!module) throw new Error("backfill needs --module <name>");
      const from = blockArg(values.from, "from");
      const runtime = await openRuntime(config, log);
      try {
        print(await runtime.indexer.backfill(module, from));
        return 0;
      } finally {
        await runtime.close();
      }
    }

    case "skip": {
      const [module] = values.module ?? [];
      if (!module) throw new Error("skip needs --module <name>");
      if (values.to === undefined) {
        throw new Error("skip needs --to <block>, or --to latest-N for N blocks behind the head");
      }
      const to = parseStartBlock(values.to, "--to");
      const runtime = await openRuntime(config, log);
      try {
        print(await runtime.indexer.skip(module, to));
        return 0;
      } finally {
        await runtime.close();
      }
    }

    case "reproject": {
      const runtime = await openRuntime(config, log, { checkChain: false });
      try {
        print({ modules: await runtime.indexer.reproject(values.module) });
        return 0;
      } finally {
        await runtime.close();
      }
    }

    case "rewind": {
      const to = blockArg(values.to, "to");
      const runtime = await openRuntime(config, log, { checkChain: false });
      try {
        print({ keptThrough: to, ...(await runtime.indexer.rewindTo(to)) });
        return 0;
      } finally {
        await runtime.close();
      }
    }

    case "snapshot": {
      const dir = resolve(process.cwd(), values.out ?? DEFAULT_SNAPSHOT_DIR);
      const through = values.through === undefined ? undefined : blockArg(values.through, "through");
      const cut = await chooseCut(createChainClient(config.rpcUrls), through, log);
      const database = await openDatabase({ databaseUrl: config.databaseUrl, pgliteDir: config.pgliteDir });
      try {
        print(await writeSnapshot(database.db, dir, { house: config.houseAddresses, cut }));
        return 0;
      } finally {
        await database.close();
      }
    }

    case "status": {
      const database = await openDatabase({ databaseUrl: config.databaseUrl, pgliteDir: config.pgliteDir });
      try {
        print({
          database: database.where,
          ...(await createQueries(database.db, { house: config.houseAddresses }).status()),
        });
        return 0;
      } finally {
        await database.close();
      }
    }

    case "migrate": {
      const database = await openDatabase({ databaseUrl: config.databaseUrl, pgliteDir: config.pgliteDir });
      await database.close();
      print({ migrated: database.where });
      return 0;
    }

    default:
      process.stderr.write(`unknown command "${command}"\n\n${USAGE}\n`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  },
);
