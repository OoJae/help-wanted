#!/usr/bin/env node
/**
 * hw-runner: the HELP WANTED runner.
 *
 *   hw-runner run        take orders until stopped (the default)
 *   hw-runner once       one pass, then exit
 *   hw-runner status     print where every order stands, and the wallet's balances
 *   hw-runner bootstrap  approve Permit2 to move the runner's IMD (needed once before paying)
 *   hw-runner resume     take orders again after the runner stopped itself (see the README)
 *
 * Dry-run unless LIVE=1 is set and RUNNER_PRIVATE_KEY is present. See README.md.
 */
import { bootstrap, resume, runLoop, status } from "./commands.js";
import { ConfigError, loadConfig } from "./config.js";
import { redactText } from "./log.js";
import { buildRuntime, secrets, type Runtime } from "./runtime.js";
import { StoreError } from "./store.js";

const COMMANDS = ["run", "once", "status", "bootstrap", "resume"] as const;
type Command = (typeof COMMANDS)[number];

async function main(argv: readonly string[]): Promise<number> {
  const command = (argv[0] ?? "run") as Command;
  if (!COMMANDS.includes(command)) {
    process.stderr.write(`usage: hw-runner [${COMMANDS.join("|")}]\n`);
    return 2;
  }
  let rt: Runtime;
  try {
    rt = await buildRuntime(loadConfig(process.env));
  } catch (error) {
    if (error instanceof ConfigError || error instanceof StoreError) {
      process.stderr.write(`${redactText(error.message, secrets)}\n`);
      return 2;
    }
    throw error;
  }

  if (command === "status") {
    await status(rt);
    return 0;
  }
  if (command === "bootstrap") {
    await bootstrap(rt);
    return 0;
  }
  if (command === "resume") {
    resume(rt);
    return 0;
  }
  if (command === "once") {
    await rt.machine.tick();
    return 0;
  }

  const stop = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      rt.log.info("stopping after the current step", { signal });
      stop.abort();
    });
  }
  await runLoop(rt.machine, { pollSeconds: rt.runnerConfig.pollSeconds, signal: stop.signal, log: rt.log });
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
