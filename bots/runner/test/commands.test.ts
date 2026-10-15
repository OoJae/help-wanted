import { type Abi } from "viem";
import { describe, expect, it } from "vitest";
import { MAINNET } from "@help-wanted/shared";
import type { ChainCall, WriteOutcome } from "../src/chain.js";
import { bootstrap, resume, rpcSecrets, runLoop, status, type CommandDeps } from "../src/commands.js";
import { createLogger, memoryLogger, redactText } from "../src/log.js";
import { DESK, RUNNER } from "./world.js";

function deps(overrides: { toPermit2?: bigint; runner?: typeof RUNNER | null; breaker?: boolean } = {}) {
  const log = memoryLogger();
  const sent: ChainCall[] = [];
  const reads: string[] = [];
  let cleared = 0;
  const d: CommandDeps = {
    config: {
      runner: overrides.runner === undefined ? RUNNER : overrides.runner,
      workOrders: DESK,
      maxConcurrent: 2,
      permit2Allowance: 5n * 10n ** 18n,
    },
    log,
    machine: {
      tick: async () => undefined,
      summary: () => [{ status: "claimed", count: 1 }],
      held: () => [{ order: "7", status: "claimed", bond: "250000000000000000" }],
      bondsAtRisk: () => 25n * 10n ** 16n,
      resume: () => {
        cleared++;
        return overrides.breaker ?? false;
      },
    },
    reader: {
      getBalance: async () => 4n * 10n ** 16n,
      async readContract({ address, functionName, args }) {
        reads.push(`${address} ${functionName} ${String(args?.[1] ?? "")}`);
        if (functionName === "balanceOf") return 3n * 10n ** 18n;
        return args?.[1] === MAINNET.PERMIT2 ? (overrides.toPermit2 ?? 5n * 10n ** 18n) : 0n;
      },
    },
    send: async (call): Promise<WriteOutcome> => {
      sent.push(call);
      return { kind: "dry-run", label: call.label, wouldSucceed: true };
    },
    killed: () => false,
    notes: () => ({ spentToday: "0", breaker: { failures: 2, trippedAt: 1 } }),
  };
  return { d, log, sent, reads, cleared: () => cleared };
}

describe("status", () => {
  it("prints the orders, what is in hand, and what the wallet holds", async () => {
    const { d, log, reads } = deps();
    await status(d);
    const line = JSON.parse(log.lines.at(-1) ?? "{}") as Record<string, unknown>;
    expect(line).toMatchObject({
      msg: "status",
      orders: [{ status: "claimed", count: 1 }],
      held: [{ order: "7", status: "claimed", bond: "250000000000000000" }],
      bondsAtRisk: "0.25",
      killed: false,
      breaker: { failures: 2, trippedAt: 1 },
      runner: RUNNER,
      eth: "0.04",
      imd: "3",
      imdAllowanceToDesk: "0",
      imdAllowanceToPermit2: "5",
    });
    // The token is always IMD on mainnet: nothing in the configuration can point it elsewhere.
    expect(reads.every((r) => r.startsWith(MAINNET.IMD))).toBe(true);
    expect(log.lines.some((l) => l.includes('"level":"warn"'))).toBe(false);
  });

  it("warns when Permit2's allowance covers fewer fees than the orders it may hold", async () => {
    const { d, log } = deps({ toPermit2: 5n * 10n ** 17n }); // one fee, two orders allowed
    await status(d);
    const warning = log.lines.find((l) => l.includes('"level":"warn"'));
    expect(warning).toContain("covers fewer fees");
    expect(warning).toContain("bootstrap");
  });

  it("reads no balances when no address is configured", async () => {
    const { d, log, reads } = deps({ runner: null });
    await status(d);
    expect(reads).toEqual([]);
    expect(log.lines.at(-1)).toContain('"msg":"status"');
  });
});

describe("bootstrap", () => {
  it("approves Permit2 for the configured amount of IMD, through the one writer", async () => {
    const { d, sent } = deps({ toPermit2: 0n });
    const outcome = await bootstrap(d);
    expect(outcome?.kind).toBe("dry-run");
    expect(sent).toHaveLength(1);
    const call = sent[0] as ChainCall;
    expect(call.address).toBe(MAINNET.IMD);
    expect(call.functionName).toBe("approve");
    expect(call.args).toEqual([MAINNET.PERMIT2, 5n * 10n ** 18n]);
    expect(call.label).toBe("approve Permit2 for 5 IMD");
    expect((call.abi as Abi).some((i) => "name" in i && i.name === "approve")).toBe(true);
  });

  it("sends nothing when the allowance is already there", async () => {
    const { d, sent, log } = deps({ toPermit2: 5n * 10n ** 18n });
    expect(await bootstrap(d)).toBeNull();
    expect(sent).toEqual([]);
    expect(log.lines.at(-1)).toContain("Permit2 is already approved");
  });

  it("needs an address", async () => {
    await expect(bootstrap(deps({ runner: null }).d)).rejects.toThrow("RUNNER_ADDRESS or RUNNER_PRIVATE_KEY");
  });
});

describe("resume", () => {
  it("clears the breaker and says so, or says there was nothing to clear", () => {
    const tripped = deps({ breaker: true });
    resume(tripped.d);
    expect(tripped.cleared()).toBe(1);
    expect(tripped.log.lines.at(-2)).toContain("takes orders again");
    expect(tripped.log.lines.at(-1)).toContain("looked at again on the next pass");
    const calm = deps({ breaker: false });
    resume(calm.d);
    expect(calm.log.lines.at(-2)).toContain("nothing to clear");
    expect(calm.log.lines.at(-1)).toContain("looked at again on the next pass");
  });
});

describe("the loop", () => {
  it("takes one pass after another until it is told to stop, and survives a pass that fails", async () => {
    const log = memoryLogger();
    const stop = new AbortController();
    let passes = 0;
    const slept: number[] = [];
    await runLoop(
      {
        tick: async () => {
          passes++;
          if (passes === 2) throw new Error("the node is down");
          if (passes === 4) stop.abort();
        },
      },
      { pollSeconds: 60, signal: stop.signal, log, sleep: async (ms) => void slept.push(ms) },
    );
    expect(passes).toBe(4);
    expect(slept).toEqual([60_000, 60_000, 60_000]); // none after the stop
    expect(log.lines.filter((l) => l.includes("pass failed"))).toHaveLength(1);
    expect(log.lines[0]).toContain("the node is down");
  });

  it("does not start a pass when it was stopped before it began", async () => {
    const stop = new AbortController();
    stop.abort();
    let passes = 0;
    await runLoop(
      { tick: async () => void passes++ },
      { pollSeconds: 1, signal: stop.signal, log: memoryLogger() },
    );
    expect(passes).toBe(0);
  });

  it("stops waiting as soon as it is told to stop", async () => {
    const stop = new AbortController();
    let passes = 0;
    const done = runLoop(
      {
        tick: async () => {
          passes++;
          setTimeout(() => stop.abort(), 5);
        },
      },
      { pollSeconds: 3600, signal: stop.signal, log: memoryLogger() },
    );
    await done; // would take an hour if the sleep ignored the signal
    expect(passes).toBe(1);
  });
});

describe("a provider key in the RPC URL", () => {
  const KEY = "SECRETKEY1234567890abcdef";

  it.each([
    ["in the path", `https://rpc.example/v2/${KEY}`],
    ["in the query string", `https://rpc.example/?apikey=${KEY}`],
    ["in a query string after a path", `https://rpc.example/rpc?dkey=${KEY}&x=1`],
    ["as a password", `https://user:${KEY}@rpc.example/`],
  ])("is registered for redaction when it sits %s", (_where, url) => {
    const secrets = rpcSecrets(url);
    expect(secrets).toContain(url);
    expect(secrets).toContain(KEY);
    // What viem prints when the node cannot be reached, and what the log then shows.
    const printed = `HTTP request failed.\n\nURL: ${url}\nRequest body: {"method":"eth_chainId"}`;
    expect(redactText(printed, secrets)).not.toContain(KEY);
    // The key alone, should a message quote it without the rest.
    expect(redactText(`key ${KEY} was refused`, secrets)).not.toContain(KEY);
    const lines: string[] = [];
    createLogger({ secrets, write: (l) => lines.push(l) }).error("rpc failed", { error: new Error(printed) });
    expect(lines.join("\n")).not.toContain(KEY);
  });

  it("registers nothing for a URL that carries no key, and survives one that is not a URL", () => {
    expect(rpcSecrets("https://ethereum-rpc.publicnode.com")).toEqual([]);
    expect(rpcSecrets("https://ethereum-rpc.publicnode.com/")).toEqual([]);
    expect(rpcSecrets("not a url")).toEqual([]);
  });
});
