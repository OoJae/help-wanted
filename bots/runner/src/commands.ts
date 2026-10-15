/**
 * What the command line does once everything is wired: the loop, the status report, the one-time
 * Permit2 approval, and clearing the breaker. Kept apart from `cli.ts` so each can be run against
 * stand-ins in tests; nothing here builds a client or reads the environment.
 */
import { formatUnits, type Abi, type Address } from "viem";
import { MAINNET, PAID_ACTION_PRICE, erc20Abi } from "@help-wanted/shared";
import type { ChainCall, WriteOutcome } from "./chain.js";
import type { ReaderLike } from "./desk.js";
import type { Logger } from "./log.js";
import type { OrderStatus } from "./store.js";

const ERC20 = erc20Abi as unknown as Abi;

/** The parts of the machine the commands use. */
export interface MachineLike {
  tick(): Promise<void>;
  summary(): { status: OrderStatus; count: number }[];
  held(): unknown[];
  bondsAtRisk(): bigint;
  resume(): boolean;
}

export interface CommandDeps {
  config: {
    runner: Address | null;
    workOrders: Address;
    maxConcurrent: number;
    permit2Allowance: bigint;
  };
  log: Logger;
  machine: MachineLike;
  reader: Pick<ReaderLike, "readContract" | "getBalance">;
  send: (call: ChainCall) => Promise<WriteOutcome>;
  killed: () => boolean;
  /** What the store says beyond the orders: the breaker, employers that cost a bond, a waiting transaction. */
  notes: () => Record<string, unknown>;
}

/**
 * Everything in an RPC URL that may be a provider key, for the log's redaction list: the URL
 * itself when it has a path, a query or credentials, and each long piece of those on its own.
 * viem prints the request URL in its errors, and a key can sit in any of the three places.
 */
export function rpcSecrets(rpcUrl: string): string[] {
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    return [];
  }
  const carriesKey =
    url.pathname.length > 1 || url.search.length > 1 || url.username !== "" || url.password !== "";
  if (!carriesKey) return [];
  const out = new Set<string>([rpcUrl, url.href, `${url.pathname}${url.search}`]);
  for (const segment of url.pathname.split("/")) out.add(segment);
  for (const value of url.searchParams.values()) out.add(value);
  out.add(url.password);
  out.add(decodeURIComponent(url.password));
  out.add(url.username);
  // Short pieces are words, not keys; the logger ignores anything under sixteen characters.
  return [...out].filter((piece) => piece.length >= 16);
}

/** Takes orders until `signal` is aborted. One failed pass does not end the loop. */
export async function runLoop(
  machine: Pick<MachineLike, "tick">,
  options: {
    pollSeconds: number;
    signal: AbortSignal;
    log: Logger;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  },
): Promise<void> {
  const sleep =
    options.sleep ??
    ((ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      }));
  while (!options.signal.aborted) {
    try {
      await machine.tick();
    } catch (error) {
      options.log.error("pass failed", { error });
    }
    if (options.signal.aborted) break;
    await sleep(options.pollSeconds * 1000, options.signal);
  }
}

/** Prints where every order stands, what the wallet holds, and anything an operator should act on. */
export async function status(deps: CommandDeps): Promise<void> {
  const { config, log, machine, reader } = deps;
  const fields: Record<string, unknown> = {
    orders: machine.summary(),
    held: machine.held(),
    bondsAtRisk: formatUnits(machine.bondsAtRisk(), 18),
    killed: deps.killed(),
    ...deps.notes(),
  };
  if (config.runner !== null) {
    const runner = config.runner;
    const read = (functionName: string, args: readonly unknown[]) =>
      reader.readContract({ address: MAINNET.IMD, abi: ERC20, functionName, args }) as Promise<bigint>;
    const [eth, imd, toDesk, toPermit2] = await Promise.all([
      reader.getBalance({ address: runner }),
      read("balanceOf", [runner]),
      read("allowance", [runner, config.workOrders]),
      read("allowance", [runner, MAINNET.PERMIT2]),
    ]);
    Object.assign(fields, {
      runner,
      eth: formatUnits(eth, 18),
      imd: formatUnits(imd, 18),
      imdAllowanceToDesk: formatUnits(toDesk, 18),
      imdAllowanceToPermit2: formatUnits(toPermit2, 18),
    });
    // Each order in hand may need one fee from this allowance, and it shrinks with every payment.
    const wanted = PAID_ACTION_PRICE * BigInt(config.maxConcurrent);
    if (toPermit2 < wanted) {
      log.warn("Permit2's allowance covers fewer fees than the orders this runner may hold at once", {
        allowance: formatUnits(toPermit2, 18),
        wanted: formatUnits(wanted, 18),
        fix: "run the bootstrap command (PERMIT2_ALLOWANCE_IMD sets the amount)",
      });
    }
  }
  log.info("status", fields);
}

/** The one-time approval that lets Permit2 move the runner's IMD when a payment is settled. */
export async function bootstrap(deps: CommandDeps): Promise<WriteOutcome | null> {
  const { config, log, reader } = deps;
  if (config.runner === null) throw new Error("bootstrap needs RUNNER_ADDRESS or RUNNER_PRIVATE_KEY");
  const current = (await reader.readContract({
    address: MAINNET.IMD,
    abi: ERC20,
    functionName: "allowance",
    args: [config.runner, MAINNET.PERMIT2],
  })) as bigint;
  if (current >= config.permit2Allowance) {
    log.info("Permit2 is already approved", { allowance: formatUnits(current, 18) });
    return null;
  }
  return deps.send({
    address: MAINNET.IMD,
    abi: ERC20,
    functionName: "approve",
    args: [MAINNET.PERMIT2, config.permit2Allowance],
    label: `approve Permit2 for ${formatUnits(config.permit2Allowance, 18)} IMD`,
  });
}

/**
 * Lets the runner take orders again after payments kept failing, and has every order it had put
 * off looked at again on the next pass. An operator's decision.
 */
export function resume(deps: Pick<CommandDeps, "machine" | "log">): void {
  if (deps.machine.resume()) deps.log.warn("the breaker is cleared: the runner takes orders again");
  else deps.log.info("the breaker was not set: nothing to clear");
  deps.log.info("every order that was put off is looked at again on the next pass");
}
