import { readFileSync } from "node:fs";
import { toHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { HOUSE_FEEDS, MAINNET, unlaunchedBook } from "@help-wanted/shared";
import {
  ConfigError,
  PUBLISHED_DEV_KEY_ADDRESSES,
  describeConfig,
  loadConfig,
  parseTimeOfDay,
  type Env,
} from "../src/config.js";
import { createLogger, redactText } from "../src/log.js";
import { BUILT_MODULES, MODULE_LAUNCH } from "../src/modules/names.js";
import { rpcSecrets } from "../src/runtime.js";

const QUESTIONS = "0x00000000000000000000000000000000000A11cE";
const JOBS_REPORT = "0x0000000000000000000000000000000000000B0b";
const PAYROLL = "0x000000000000000000000000000000000000c0dE";
const DESK = "0x000000000000000000000000000000000000dE5c";
const POTS = "0x0000000000000000000000000000000000009075";
const BELL = "0x000000000000000000000000000000000000be11";
const RULES = "0x0000000000000000000000000000000000002013";
const ENDOWMENTS = "0x000000000000000000000000000000000000E9D0";
/** A made-up key for these tests: sixty-four hex characters that guard nothing. */
const KEY = `0x${"5a".repeat(32)}`;
/** The key of the first account every local development node prints, from the public test mnemonic. */
const DEV_KEY = toHex(
  mnemonicToAccount("test test test test test test test test test test test junk").getHdKey()
    .privateKey as Uint8Array,
);

/** Nothing launched, so these tests say the same thing whatever the deployments book holds today. */
const NOTHING = unlaunchedBook();
const base: Env = { QUESTIONS, JOBS_REPORT, PAYROLL };
const load = (env: Env = {}) => loadConfig({ ...base, ...env }, NOTHING);
const refused = (env: Env): string => {
  try {
    load(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
  throw new Error("expected a ConfigError");
};

describe("dry run is the default", () => {
  it("with nothing but the addresses: no key, no account, nothing that could sign", () => {
    const config = load();
    expect(config.mode).toBe("dry-run");
    expect(config.dryRunReason).toBe("LIVE=1 is not set");
    expect(config.privateKey).toBeNull();
    expect(config.keeper).toBeNull();
  });

  it("stays a dry run with a key and no LIVE, and does not keep the key", () => {
    const config = load({ KEEPER_PRIVATE_KEY: KEY });
    expect(config.mode).toBe("dry-run");
    expect(config.privateKey).toBeNull();
    // The address is known, so calls can be simulated from it.
    expect(config.keeper).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("stays a dry run with LIVE and no key, and says why", () => {
    const config = load({ LIVE: "1" });
    expect(config.mode).toBe("dry-run");
    expect(config.dryRunReason).toBe("LIVE=1 is set but KEEPER_PRIVATE_KEY is not");
    expect(load({ LIVE: "0", KEEPER_PRIVATE_KEY: KEY }).mode).toBe("dry-run");
  });

  it("is live only with both", () => {
    const config = load({ LIVE: "1", KEEPER_PRIVATE_KEY: KEY });
    expect(config.mode).toBe("live");
    expect(config.dryRunReason).toBeNull();
    expect(config.privateKey).toBe(KEY);
  });

  it("takes an address to simulate from in a keyless dry run, and checks it against a key", () => {
    expect(load({ KEEPER_ADDRESS: QUESTIONS.toLowerCase() }).keeper).toBe(QUESTIONS);
    expect(refused({ KEEPER_ADDRESS: QUESTIONS, KEEPER_PRIVATE_KEY: KEY })).toContain("does not belong");
    expect(refused({ KEEPER_ADDRESS: "0x1234" })).toContain("not an address");
  });

  it("refuses settings it cannot read rather than guess", () => {
    expect(refused({ LIVE: "yes" })).toBe("LIVE must be 1 or 0");
    expect(refused({ KEEPER_PRIVATE_KEY: "0x1234" })).toContain("64 hex characters");
    expect(refused({ KILL_SWITCH: "on" })).toContain("must be 1 or 0");
    expect(refused({ POLL_SECONDS: "5" })).toContain("between 10 and 86400");
    expect(refused({ MAX_FEE_GWEI: "cheap" })).toContain("gwei");
    expect(refused({ TIP_COLLECT_MIN_IMD: "-1" })).toContain("IMD amount");
    expect(refused({ BOOK_MIN_IMD: "0" })).toContain("above zero");
    expect(refused({ LOG_LEVEL: "loud" })).toContain("LOG_LEVEL");
    expect(refused({ CHAIN_ID: "4663" })).toContain("CHAIN_ID must be 1");
  });
});

describe("the key", () => {
  it("is never in an error message", () => {
    for (const env of [
      { KEEPER_PRIVATE_KEY: KEY, LIVE: "maybe" },
      { KEEPER_PRIVATE_KEY: KEY, KEEPER_ADDRESS: QUESTIONS },
      { KEEPER_PRIVATE_KEY: `${KEY}00` },
    ]) {
      const message = refused(env);
      expect(message).not.toContain(KEY.slice(2));
    }
  });

  it("is not in what is printed at start, and neither is the RPC URL", () => {
    const config = load({
      LIVE: "1",
      KEEPER_PRIVATE_KEY: KEY,
      RPC_URL: "https://node.example/v2/abcdef0123456789abcdef",
    });
    const printed = JSON.stringify(describeConfig(config));
    expect(printed).not.toContain(KEY.slice(2));
    expect(printed).not.toContain("abcdef0123456789abcdef");
    expect(printed).toContain("node.example");
  });

  it("is removed from a log line even when something logs it by mistake", () => {
    const lines: string[] = [];
    const log = createLogger({ secrets: [KEY], write: (line) => lines.push(line) });
    log.info("oops", {
      note: `the key is ${KEY}`,
      upper: KEY.slice(2).toUpperCase(),
      privateKey: "anything",
    });
    expect(lines[0]).not.toContain(KEY.slice(2));
    expect(lines[0]).not.toContain(KEY.slice(2).toUpperCase());
    expect(lines[0]).toContain("[redacted]");
    expect(JSON.parse(lines[0] as string).privateKey).toBe("[redacted]");
    expect(redactText(`fatal: ${KEY}`, [KEY])).toBe("fatal: [redacted]");
  });

  it("an RPC URL that carries a provider key is redacted piece by piece", () => {
    const pieces = rpcSecrets(
      "https://user:s3cretpassw0rdvalue@node.example/v2/abcdef0123456789abcdef?apikey=zyxwvutsrqponmlk9876",
    );
    expect(pieces).toContain("abcdef0123456789abcdef");
    expect(pieces).toContain("zyxwvutsrqponmlk9876");
    expect(pieces).toContain("s3cretpassw0rdvalue");
    expect(rpcSecrets("https://ethereum-rpc.publicnode.com")).toEqual([]);
    expect(rpcSecrets("not a url")).toEqual([]);
  });

  it("a published development key is refused live on a public chain, and allowed on a local node", () => {
    expect(PUBLISHED_DEV_KEY_ADDRESSES).toHaveLength(10);
    expect(refused({ LIVE: "1", KEEPER_PRIVATE_KEY: DEV_KEY })).toContain("published development key");
    expect(refused({ LIVE: "1", KEEPER_PRIVATE_KEY: DEV_KEY })).not.toContain(DEV_KEY.slice(2));
    // A dry run signs nothing, so it does not matter there.
    expect(load({ KEEPER_PRIVATE_KEY: DEV_KEY }).mode).toBe("dry-run");
    // A rehearsal against a node on this machine is what those keys are for.
    const local = load({ LIVE: "1", KEEPER_PRIVATE_KEY: DEV_KEY, RPC_URL: "http://127.0.0.1:8545" });
    expect(local.mode).toBe("live");
    expect(local.rpcIsLocal).toBe(true);
  });
});

describe("where it points", () => {
  it("defaults to mainnet, IdentityMD's API and the launch's own expectations", () => {
    const config = load();
    expect(config.chainId).toBe(1);
    expect(config.apiBase).toBe("https://api.imd.fun");
    expect(config.rpcIsLocal).toBe(false);
    expect(config.expected).toEqual({
      intake: MAINNET.INTAKE,
      imd: MAINNET.IMD,
      oracleSigner: MAINNET.ORACLE_SIGNER,
    });
    expect(config.apiMinIntervalMs).toBe(2100);
    expect(config.rpcBatch).toBe(true);
    expect(load({ RPC_BATCH: "0" }).rpcBatch).toBe(false);
  });

  it("refuses a plain-http node or API unless it is on this machine", () => {
    expect(refused({ RPC_URL: "http://node.example" })).toBe("RPC_URL must use https");
    expect(refused({ IMD_API: "http://api.example" })).toBe("IMD_API must use https");
    expect(refused({ RPC_URL: "nonsense" })).toBe("RPC_URL is not a URL");
    expect(load({ RPC_URL: "http://localhost:8545", IMD_API: "http://127.0.0.1:9000/" }).apiBase).toBe(
      "http://127.0.0.1:9000",
    );
  });

  it("needs the address of each contract a switched-on module calls, and no other", () => {
    expect(() => loadConfig({}, NOTHING)).toThrow(/QUESTIONS is not set/);
    expect(() => loadConfig({ QUESTIONS }, NOTHING)).toThrow(/JOBS_REPORT is not set/);
    expect(() => loadConfig({ QUESTIONS, JOBS_REPORT }, NOTHING)).toThrow(/PAYROLL is not set/);
    const only = loadConfig({ QUESTIONS, MODULES: "questions" }, NOTHING);
    expect([...only.modules]).toEqual(["questions"]);
    expect(only.payroll).toBeNull();
    // The report reads Questions too.
    expect(() => loadConfig({ JOBS_REPORT, MODULES: "jobsReport" }, NOTHING)).toThrow(/QUESTIONS is not set/);
    expect([...loadConfig({ PAYROLL, MODULES: "payroll" }, NOTHING).modules]).toEqual(["payroll"]);
  });
});

describe("modules and feeds", () => {
  it("runs the three launch A modules by default, each switchable off", () => {
    expect([...load().modules]).toEqual(["questions", "jobsReport", "payroll"]);
    expect([...load({ MODULES: "payroll, questions" }).modules].sort()).toEqual(["payroll", "questions"]);
    expect(BUILT_MODULES).toEqual([
      "questions",
      "jobsReport",
      "payroll",
      "desk",
      "pots",
      "doorbell",
      "rules",
      "endowments",
    ]);
    expect(MODULE_LAUNCH).toMatchObject({ questions: "A", desk: "B", pots: "B", doorbell: "B", rules: "C" });
  });

  it("adds the modules of launches B and C as their contracts become known", () => {
    // With MODULES unset, a later module runs once the addresses it needs are given.
    expect([...load({ WORK_ORDERS: DESK }).modules]).toEqual(["questions", "jobsReport", "payroll", "desk"]);
    expect([...load({ WORK_ORDERS: DESK, CROWD_POTS: POTS, DOORBELL: BELL }).modules]).toEqual([
      "questions",
      "jobsReport",
      "payroll",
      "desk",
      "pots",
      "doorbell",
    ]);
    // The rules module reads the desk as well: Rules alone does not switch it on.
    expect([...load({ RULES }).modules]).toEqual(["questions", "jobsReport", "payroll"]);
    expect([...load({ RULES, WORK_ORDERS: DESK, ENDOWMENTS }).modules]).toEqual([
      "questions",
      "jobsReport",
      "payroll",
      "desk",
      "rules",
      "endowments",
    ]);
    // Named without its address, a module is refused with the name of what is missing.
    expect(refused({ MODULES: "questions,desk" })).toContain(
      "WORK_ORDERS is not set: the desk module needs the address launch B created",
    );
    expect(refused({ MODULES: "rules", RULES })).toContain("WORK_ORDERS is not set: the rules module");
    expect(refused({ MODULES: "endowments" })).toContain("launch C created");
    expect(refused({ MODULES: "questions,weather" })).toContain("not one of");
    // A keeper for launch B alone needs nothing of launch A.
    expect([
      ...loadConfig({ WORK_ORDERS: DESK, CROWD_POTS: POTS, MODULES: "desk,pots" }, NOTHING).modules,
    ]).toEqual(["desk", "pots"]);
  });

  it("never challenges unless both the float and the daily cap are set", () => {
    const off = load({ WORK_ORDERS: DESK });
    expect(off.challengeFloat).toBe(0n);
    expect(off.challengeDailyCap).toBe(0n);
    expect(off.challengeArbiters.size).toBe(0);
    expect(off.challengeConfirmSeconds).toBe(900);
    expect(off.finalizeClaims).toBe(true);
    expect(off.settleReceipts).toBe(true);
    expect(refused({ CHALLENGE_FLOAT_IMD: "1" })).toContain("go together");
    expect(refused({ CHALLENGE_DAILY_CAP_IMD: "1" })).toContain("go together");
    const on = load({
      WORK_ORDERS: DESK,
      CHALLENGE_FLOAT_IMD: "1",
      CHALLENGE_DAILY_CAP_IMD: "0.5",
      CHALLENGE_ARBITERS: `${RULES}, ${POTS}`,
      CHALLENGE_EMPLOYERS: BELL,
      CHALLENGE_CONFIRM_SECONDS: "60",
      DESK_OWN_RUNNERS: BELL,
      DESK_FINALIZE: "0",
      DESK_SETTLE: "0",
    });
    expect(on.challengeFloat).toBe(10n ** 18n);
    expect(on.challengeDailyCap).toBe(5n * 10n ** 17n);
    // Kept lowercase, as they are compared.
    expect([...on.challengeArbiters]).toEqual([RULES.toLowerCase(), POTS.toLowerCase()]);
    expect(on.ownRunners.has(BELL.toLowerCase())).toBe(true);
    // With no list the keeper posts bonds for any employer's order.
    expect([...on.challengeEmployers]).toEqual([BELL.toLowerCase()]);
    expect(off.challengeEmployers.size).toBe(0);
    expect(on.challengeConfirmSeconds).toBe(60);
    expect(on.finalizeClaims).toBe(false);
    expect(on.settleReceipts).toBe(false);
    expect(refused({ CHALLENGE_ARBITERS: "nobody" })).toContain("not an address");
  });

  it("reads the settings of the rules and endowments modules", () => {
    const config = load({
      RULES,
      WORK_ORDERS: DESK,
      RULES_HOUSE: "1, 7",
      RULES_IMD_PER_ETH: "25000.5",
      RULES_TIP_COVER_BPS: "15000",
      ENDOWMENTS_STAKE_MIN_IMD: "2",
      ENDOWMENTS_HARVEST_MIN_IMD: "0.25",
      START_BLOCK_B: "26200000",
      START_BLOCK_C: "26300000",
    });
    expect([...config.houseRules]).toEqual(["1", "7"]);
    expect(config.imdPerEth).toBe(250005n * 10n ** 17n);
    expect(config.tipCoverBps).toBe(15_000n);
    expect(config.stakeMin).toBe(2n * 10n ** 18n);
    expect(config.harvestMin).toBe(25n * 10n ** 16n);
    expect(config.startBlockB).toBe(26_200_000n);
    expect(config.startBlockC).toBe(26_300_000n);
    // Without a rate, a tip in IMD cannot be held against gas in ETH: only house rules fire.
    expect(load().imdPerEth).toBeNull();
    expect(load().startBlockB).toBeNull();
    expect(refused({ RULES_HOUSE: "first" })).toContain("RULES_HOUSE must be rule ids");
    expect(refused({ RULES_IMD_PER_ETH: "0" })).toContain("above zero");
    expect(refused({ ENDOWMENTS_STAKE_MIN_IMD: "0" })).toContain("above zero");
    expect(refused({ START_BLOCK_B: "soon" })).toContain("must be a block number");
  });

  it("keeps the three house feeds by default, in the order they are asked", () => {
    expect(load().feeds.map((f) => f.name)).toEqual(["payrolls", "hires", "employers"]);
    expect(load().feeds[0]).toBe(HOUSE_FEEDS.payrolls);
    expect(load({ FEEDS: "hires,payrolls,hires" }).feeds.map((f) => f.name)).toEqual(["hires", "payrolls"]);
    expect(refused({ FEEDS: "payrolls,weather" })).toContain("not one of");
  });
});

describe("the settings and their documentation", () => {
  it("documents every setting it reads, and reads every setting it documents", () => {
    const source = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
    const read = new Set(
      [
        ...source.matchAll(
          /(?:read|imd|optionalImd|eth|gwei|integer|flag|address|addressSet|block|list)\(env, "([A-Z0-9_]+)"/g,
        ),
      ].map((m) => m[1]),
    );
    const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    const documented = new Set([...example.matchAll(/^#? ?([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
    // Read only to be refused unless it is 1.
    read.delete("CHAIN_ID");
    expect([...read].filter((name) => !documented.has(name))).toEqual([]);
    expect([...documented].filter((name) => !read.has(name))).toEqual([]);
    expect(read.size).toBeGreaterThan(50);
  });
});

describe("limits and policy", () => {
  it("has defaults an operator can read off", () => {
    const config = load();
    expect(config.maxFeePerGas).toBe(5_000_000_000n);
    expect(config.maxPriorityFeePerGas).toBe(100_000_000n);
    // A settlement on the desk is sent with about two million gas: 0.0104 ETH at the fee cap.
    expect(config.maxTxCost).toBe(2n * 10n ** 16n);
    expect(config.dailySpendCap).toBe(5n * 10n ** 16n);
    expect(config.tipCollectMin).toBe(5n * 10n ** 17n);
    expect(config.closeRoundsInProgress).toBe(false);
    expect(config.expiryMarginSeconds).toBe(120);
    expect(config.requestAtUtc).toBeNull();
    expect(config.dripEverySeconds).toBe(3600);
    expect(config.pollSeconds).toBe(300);
    expect(config.killSwitch).toBe(false);
    expect(config.statePath).toBe("./data/keeper.json");
    expect(config.killFile).toBe("./data/keeper.json.KILL");
    expect(config.firstDayFund).toEqual({ payrolls: null, hires: null, employers: null });
    expect(config.firstDayConfirm).toBeNull();
  });

  it("reads what the operator sets", () => {
    const config = load({
      MAX_FEE_GWEI: "12.5",
      MAX_TX_COST_ETH: "0.02",
      DAILY_SPEND_CAP_ETH: "0.1",
      CLOSE_ROUNDS_IN_PROGRESS: "1",
      REQUEST_AT_UTC: "14:00",
      KILL_SWITCH: "1",
      STATE_PATH: "/data/keeper.json",
      FIRST_DAY_FUND_PAYROLLS_IMD: "3.3",
      FIRST_DAY_CONFIRM: `0x${"ab".repeat(32)}`,
    });
    expect(config.maxFeePerGas).toBe(12_500_000_000n);
    expect(config.dailySpendCap).toBe(10n ** 17n);
    expect(config.closeRoundsInProgress).toBe(true);
    expect(config.requestAtUtc).toBe(50_400);
    expect(config.killSwitch).toBe(true);
    expect(config.killFile).toBe("/data/keeper.json.KILL");
    expect(config.firstDayFund.payrolls).toBe(33n * 10n ** 17n);
    expect(config.firstDayConfirm).toBe(`0x${"ab".repeat(32)}`);
  });

  it("refuses limits that contradict each other", () => {
    expect(refused({ MAX_PRIORITY_FEE_GWEI: "9" })).toContain("above MAX_FEE_GWEI");
    expect(refused({ DAILY_SPEND_CAP_ETH: "0.001" })).toContain("below MAX_TX_COST_ETH");
    expect(refused({ REQUEST_AT_UTC: "25:00" })).toContain("time of day");
    expect(refused({ FIRST_DAY_CONFIRM: "yes" })).toContain("plan digest");
  });

  it("reads a time of day", () => {
    expect(parseTimeOfDay("00:00")).toBe(0);
    expect(parseTimeOfDay("23:59")).toBe(86_340);
    expect(parseTimeOfDay("24:00")).toBeNull();
    expect(parseTimeOfDay("9:00")).toBeNull();
  });
});
