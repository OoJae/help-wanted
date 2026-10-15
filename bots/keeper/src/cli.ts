#!/usr/bin/env node
/**
 * hw-keeper: the HELP WANTED keeper.
 *
 *   hw-keeper once        one pass, then exit (for cron)
 *   hw-keeper run         a pass every POLL_SECONDS until stopped
 *   hw-keeper status      look and decide, list what a pass would do, send nothing
 *   hw-keeper first-day   launch A's first-day runbook, step by step
 *
 * Dry-run unless LIVE=1 is set and KEEPER_PRIVATE_KEY is present. See README.md.
 */
import { ConfigError, loadConfig } from "./config.js";
import { runFirstDay } from "./firstDayRun.js";
import { redactText } from "./log.js";
import { runLoop, runPass } from "./pass.js";
import { buildRuntime, secrets } from "./runtime.js";
import { StoreError } from "./store.js";

const COMMANDS = ["once", "run", "status", "first-day"] as const;
type Command = (typeof COMMANDS)[number];

async function main(argv: readonly string[]): Promise<number> {
  const command = (argv[0] ?? "once") as Command;
  if (!COMMANDS.includes(command)) {
    process.stderr.write(`usage: hw-keeper [${COMMANDS.join("|")}]\n`);
    return 2;
  }
  let rt;
  try {
    rt = await buildRuntime(loadConfig(process.env));
  } catch (error) {
    if (error instanceof ConfigError || error instanceof StoreError) {
      process.stderr.write(`${redactText(error.message, secrets)}\n`);
      return 2;
    }
    throw error;
  }

  if (command === "first-day") {
    const result = await runFirstDay(rt);
    // A dry run that printed its plan has done its job; a live run has when every step is on chain.
    if (rt.writer.mode === "dry-run") return result.plan.steps.some((s) => s.status === "blocked") ? 1 : 0;
    return result.complete ? 0 : 1;
  }
  if (command === "status") {
    const status = await runPass(rt, { command, planOnly: true });
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return 0;
  }
  if (command === "once") {
    const status = await runPass(rt, { command });
    // Cron should hear about a pass that could not read the chain; a step that failed is in the
    // status file and does not fail the command.
    return status.errors.length > 0 ? 1 : 0;
  }

  const stop = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      rt.log.info("stopping after the current step", { signal });
      stop.abort();
    });
  }
  await runLoop(rt, { signal: stop.signal });
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Never print a raw error object here: it may carry request headers.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`fatal: ${redactText(message, secrets)}\n`);
    process.exitCode = 1;
  },
);
