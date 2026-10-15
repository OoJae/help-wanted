import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kindHash, unlaunchedBook } from "@help-wanted/shared";
import { ConfigError, describeConfig, loadConfig, type Env } from "../src/config.js";
import { REDACTED, createLogger, memoryLogger, redactText } from "../src/log.js";
import {
  StoreError,
  addSpend,
  addSpendOn,
  memoryStore,
  openFileStore,
  paidToken,
  spentToday,
  utcDay,
} from "../src/store.js";
import { DESK, NOW, RUNNER, TEST_PRIVATE_KEY } from "./world.js";

/** A key made up for these tests: not a development default, and never funded. */
const SOME_KEY = `0x${"5e".repeat(31)}01`;
/** Nothing launched, so these tests say the same thing whatever the deployments book holds today. */
const NOTHING = unlaunchedBook();
const base: Env = { WORK_ORDERS: DESK };
/** What a live run needs beyond the key: the block the desk was deployed in. */
const live: Env = { ...base, LIVE: "1", RUNNER_PRIVATE_KEY: SOME_KEY, START_BLOCK: "26164000" };

function errorOf(env: Env): string {
  try {
    loadConfig(env, NOTHING);
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
  return "no error";
}

describe("configuration", () => {
  it("is a dry run by default, with no key in it", () => {
    const config = loadConfig(base);
    expect(config.mode).toBe("dry-run");
    expect(config.dryRunReason).toBe("LIVE=1 is not set");
    expect(config.privateKey).toBeNull();
    expect(config.runner).toBeNull();
  });

  it("stays a dry run when only the key is set, and drops the key", () => {
    const config = loadConfig({ ...base, RUNNER_PRIVATE_KEY: SOME_KEY });
    expect(config.mode).toBe("dry-run");
    expect(config.privateKey).toBeNull();
    expect(config.runner).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("stays a dry run when only LIVE=1 is set", () => {
    const config = loadConfig({ ...base, LIVE: "1" });
    expect(config.mode).toBe("dry-run");
    expect(config.dryRunReason).toBe("LIVE=1 is set but RUNNER_PRIVATE_KEY is not");
  });

  it("is live only with LIVE=1 and a key", () => {
    const config = loadConfig(live);
    expect(config.mode).toBe("live");
    expect(config.privateKey).toBe(SOME_KEY);
    expect(config.dryRunReason).toBeNull();
    for (const text of ["true", "yes", "on", "2"]) {
      expect(errorOf({ ...live, LIVE: text })).toBe("LIVE must be 1 or 0");
    }
    expect(loadConfig({ ...live, LIVE: "0" }).mode).toBe("dry-run");
  });

  it("does not go live without the block the desk was deployed in", () => {
    // With it a runner whose store was lost reads every order again, the ones it holds included.
    expect(errorOf({ ...base, LIVE: "1", RUNNER_PRIVATE_KEY: SOME_KEY })).toContain("START_BLOCK is not set");
    // A dry run stakes nothing and may start from the last few thousand blocks.
    expect(loadConfig({ ...base, RUNNER_PRIVATE_KEY: SOME_KEY }).startBlock).toBeNull();
  });

  it("refuses to go live with a published development key, and allows it in a dry run", () => {
    expect(errorOf({ ...live, RUNNER_PRIVATE_KEY: TEST_PRIVATE_KEY })).toContain("published development key");
    expect(loadConfig({ ...base, RUNNER_PRIVATE_KEY: TEST_PRIVATE_KEY }).runner).toBe(RUNNER);
  });

  it("never puts the key in an error or in the printable configuration", () => {
    const bad = `${SOME_KEY}zz`;
    expect(errorOf({ ...base, RUNNER_PRIVATE_KEY: bad })).not.toContain(SOME_KEY.slice(2, 20));
    const config = loadConfig({
      ...live,
      IMD_PAID_TOKEN: "a".repeat(64),
      RPC_URL:
        "https://user:hunter2-hunter2-hunter2@rpc.example/v2/secret-api-key-123456?apikey=another-secret-key-7890",
    });
    const printed = JSON.stringify(describeConfig(config));
    expect(printed).not.toContain(SOME_KEY.slice(2));
    expect(printed).not.toContain("a".repeat(64));
    expect(printed).not.toContain("secret-api-key");
    expect(printed).not.toContain("another-secret-key");
    expect(printed).not.toContain("hunter2");
    expect(printed).toContain('"mode":"live"');
    expect(printed).toContain('"operatorTokenSet":true');
    expect(printed).toContain("rpc.example");
  });

  it("needs the desk's address", () => {
    expect(errorOf({})).toContain("WORK_ORDERS is not set");
    expect(errorOf({ WORK_ORDERS: "0x1234" })).toBe("WORK_ORDERS is not an address");
  });

  it("checks a declared address against the key", () => {
    expect(errorOf({ ...base, RUNNER_PRIVATE_KEY: SOME_KEY, RUNNER_ADDRESS: RUNNER })).toBe(
      "RUNNER_ADDRESS does not belong to RUNNER_PRIVATE_KEY",
    );
    expect(loadConfig({ ...base, RUNNER_ADDRESS: RUNNER.toLowerCase() }).runner).toBe(RUNNER);
  });

  it("refuses a published development key on a public chain, and allows it on a local node", () => {
    // Account 5 of every local development node: its key is printed in the tools' documentation.
    const devKey = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
    const live = { ...base, LIVE: "1", START_BLOCK: "1", RUNNER_PRIVATE_KEY: devKey };
    expect(errorOf(live)).toContain("published development key");
    expect(errorOf({ ...live, RPC_URL: "https://rpc.example/key" })).toContain("on a public chain");
    // A rehearsal against a node on this machine holds nothing real.
    const local = loadConfig({ ...live, RPC_URL: "http://127.0.0.1:8545" });
    expect(local.mode).toBe("live");
    expect(local.rpcIsLocal).toBe(true);
    expect(loadConfig(base).rpcIsLocal).toBe(false);
  });

  it("names the setting that replaced REQUIRE_CLAIMED_PATH instead of ignoring it", () => {
    expect(errorOf({ ...base, REQUIRE_CLAIMED_PATH: "1" })).toContain("use RECEIPT_ONLY_ORDERS");
    expect(errorOf({ ...base, RECEIPT_ONLY_ORDERS: "sometimes" })).toContain(
      "RECEIPT_ONLY_ORDERS must be one of: never, when-receipts-flow, always",
    );
    expect(loadConfig({ ...base, RECEIPT_ONLY_ORDERS: "never" }).receiptOnlyOrders).toBe("never");
  });

  it("refuses limits under which a settlement could not be sent at the fee cap", () => {
    // 3,000,000 gas at 3 gwei is 0.009 ETH: a cost limit of 0.005 would refuse every settlement
    // sent at the cap, and the runner is paid by settlements.
    const message = errorOf({ ...base, MAX_TX_COST_ETH: "0.005" });
    expect(message).toContain("MAX_TX_COST_ETH is below what a settlement may cost at the fee cap");
    expect(message).toContain("0.009 ETH");
    expect(loadConfig({ ...base, MAX_TX_COST_ETH: "0.009" }).maxTxCost).toBe(9n * 10n ** 15n);
    // A lower fee cap makes the old cost limit enough again.
    expect(loadConfig({ ...base, MAX_TX_COST_ETH: "0.005", MAX_FEE_GWEI: "1.5" }).maxTxCost).toBe(
      5n * 10n ** 15n,
    );
    // A gas limit under what a record of an allowed kind has needed could settle nothing.
    expect(errorOf({ ...base, MAX_SETTLE_GAS: "2000000" })).toContain(
      "is below the 2077865 gas a record of kind skill:research-report has needed",
    );
    // An audit's record never fits one transaction: it is not what the gas limit is judged by.
    expect(loadConfig({ ...base, TEMPLATES: "audit" }).maxSettleGas).toBe(3_000_000n);
  });

  it("has conservative defaults", () => {
    const config = loadConfig(base);
    expect(config.dailyCap).toBe(2n * 10n ** 18n);
    expect(config.orderCap).toBe(5n * 10n ** 17n);
    // The desk's minimum bond, and no more: a bond is what an order can cost beyond the fee.
    expect(config.maxBond).toBe(25n * 10n ** 16n);
    expect(config.maxBondsAtRisk).toBe(10n ** 18n);
    expect(config.minMargin).toBe(5n * 10n ** 16n);
    expect(config.failureBps).toBe(500n);
    expect(config.maxConcurrent).toBe(2);
    // An order only a receipt can pay is taken only while receipts are being written.
    expect(config.receiptOnlyOrders).toBe("when-receipts-flow");
    expect(config.receiptStallBlocks).toBe(1800);
    expect(config.latchConditions).toBe(true);
    expect(config.stampAfterFinalize).toBe(true);
    expect(config.stampWatchSeconds).toBe(30 * 86_400);
    expect(config.disputeTimeoutAfter).toBe(86_400);
    // What the desk's documents say to send a settlement with, and a cost limit that allows it
    // at the fee cap: 3,000,000 gas at 3 gwei is 0.009 ETH.
    expect(config.maxSettleGas).toBe(3_000_000n);
    expect(config.maxTxCost).toBe(10n ** 16n);
    expect(config.maxSettleGas * config.maxFeePerGas <= config.maxTxCost).toBe(true);
    expect(config.arbiters.size).toBe(0);
    expect(config.employers.size).toBe(0);
    expect(config.maxEmployerLosses).toBe(1);
    expect(config.maxPayFailures).toBe(2);
    // A blocked job is never bought again, and a job is registered only when it is time.
    expect(config.maxJobsPerOrder).toBe(1);
    expect(config.registerAtOnce).toBe(false);
    expect(config.claimSettleSeconds).toBe(600);
    expect(config.maxSettleRecordBytes).toBe(100_000);
    expect(config.dryRunPreflight).toBe(false);
    expect(config.preparedInputExtraKeys).toEqual([]);
    expect(config.maxFeePerGas).toBe(3n * 10n ** 9n);
    expect(config.urgentMaxFeePerGas).toBe(30n * 10n ** 9n);
    expect(config.urgentMaxTxCost).toBe(2n * 10n ** 16n);
    expect(config.minGasBalance).toBe(3n * 10n ** 15n);
    expect(config.killSwitch).toBe(false);
    expect(config.logLevel).toBe("info");
    // One kind. An audit's code is named by the employer and its record is too large to settle
    // in one transaction, so audits are for an operator to switch on.
    expect([...config.templates.values()]).toEqual(["skill:research-report"]);
    expect(config.templates.get(kindHash("skill:research-report"))).toBe("skill:research-report");
    expect(config.chainId).toBe(1);
  });

  it("reads caps, the allow-list, arbiters and the kill switch", () => {
    const config = loadConfig({
      ...base,
      DAILY_CAP_IMD: "10",
      ORDER_CAP_IMD: "1.5",
      MAX_BOND_IMD: "0.25",
      MIN_MARGIN_IMD: "0",
      MAX_CONCURRENT: "5",
      TEMPLATES: "skill:create-image, audit",
      ARBITERS: `${RUNNER},`,
      KILL_SWITCH: "1",
      RECEIPT_ONLY_ORDERS: "always",
      RECEIPT_STALL_BLOCKS: "300",
      LATCH_CONDITIONS: "0",
      STAMP_AFTER_FINALIZE: "0",
      STAMP_WATCH_DAYS: "7",
      DISPUTE_TIMEOUT_AFTER_SECONDS: "0",
      MAX_SETTLE_GAS: "5000000",
      MAX_FEE_GWEI: "1.5",
      START_BLOCK: "26164000",
      EMPLOYERS: RUNNER.toLowerCase(),
      MAX_EMPLOYER_LOSSES: "3",
      MAX_BONDS_AT_RISK_IMD: "0.5",
      EXPECTED_FAILURE_BPS: "0",
      MAX_PAY_FAILURES: "5",
      MAX_JOBS_PER_ORDER: "2",
      REGISTER_AT_ONCE: "1",
      CLAIM_SETTLE_SECONDS: "0",
      MAX_SETTLE_RECORD_BYTES: "50000",
      DRY_RUN_PREFLIGHT: "1",
      PREPARED_INPUT_EXTRA_KEYS: "minCitations, references",
      URGENT_MAX_FEE_GWEI: "50",
      URGENT_MAX_TX_COST_ETH: "0.05",
      LOG_LEVEL: "debug",
    });
    expect(config.employers.has(RUNNER)).toBe(true);
    expect(config.maxEmployerLosses).toBe(3);
    expect(config.maxBondsAtRisk).toBe(5n * 10n ** 17n);
    expect(config.failureBps).toBe(0n);
    expect(config.maxPayFailures).toBe(5);
    expect(config.maxJobsPerOrder).toBe(2);
    expect(config.registerAtOnce).toBe(true);
    expect(config.claimSettleSeconds).toBe(0);
    expect(config.maxSettleRecordBytes).toBe(50_000);
    expect(config.dryRunPreflight).toBe(true);
    expect(config.preparedInputExtraKeys).toEqual(["minCitations", "references"]);
    expect(config.urgentMaxFeePerGas).toBe(50n * 10n ** 9n);
    expect(config.urgentMaxTxCost).toBe(5n * 10n ** 16n);
    expect(config.logLevel).toBe("debug");
    expect(config.dailyCap).toBe(10n ** 19n);
    expect(config.orderCap).toBe(15n * 10n ** 17n);
    expect(config.maxBond).toBe(25n * 10n ** 16n);
    expect(config.minMargin).toBe(0n);
    expect(config.maxConcurrent).toBe(5);
    expect([...config.templates.values()]).toEqual(["skill:create-image", "audit"]);
    expect(config.arbiters.has(RUNNER)).toBe(true);
    expect(config.killSwitch).toBe(true);
    expect(config.receiptOnlyOrders).toBe("always");
    expect(config.receiptStallBlocks).toBe(300);
    expect(config.latchConditions).toBe(false);
    expect(config.stampAfterFinalize).toBe(false);
    expect(config.stampWatchSeconds).toBe(7 * 86_400);
    expect(config.disputeTimeoutAfter).toBe(0);
    expect(config.maxSettleGas).toBe(5_000_000n);
    expect(config.maxFeePerGas).toBe(15n * 10n ** 8n);
    expect(config.startBlock).toBe(26164000n);
  });

  it.each([
    [{ DAILY_CAP_IMD: "lots" }, "DAILY_CAP_IMD must be an IMD amount"],
    [{ DAILY_CAP_IMD: "-1" }, "DAILY_CAP_IMD must be an IMD amount"],
    [{ MAX_CONCURRENT: "0" }, "MAX_CONCURRENT must be between"],
    [{ TEMPLATES: "skill:anything" }, 'TEMPLATES names "skill:anything"'],
    [{ ARBITERS: "nobody" }, "ARBITERS holds something that is not an address"],
    [{ KILL_SWITCH: "maybe" }, "KILL_SWITCH must be 1 or 0"],
    [{ IMD_PAID_TOKEN: "short" }, "IMD_PAID_TOKEN must be 64 lowercase hex characters"],
    [{ RPC_URL: "http://rpc.example" }, "RPC_URL must use https"],
    [{ IMD_API: "not a url" }, "IMD_API is not a URL"],
    [{ CHAIN_ID: "8453" }, "CHAIN_ID must be 1"],
    [{ MAX_FEE_GWEI: "0.01", MAX_PRIORITY_FEE_GWEI: "1" }, "MAX_PRIORITY_FEE_GWEI is above MAX_FEE_GWEI"],
    [{ START_BLOCK: "latest" }, "START_BLOCK must be a block number"],
    [{ URGENT_MAX_FEE_GWEI: "1" }, "URGENT_MAX_FEE_GWEI is below MAX_FEE_GWEI"],
    [{ URGENT_MAX_TX_COST_ETH: "0.001" }, "URGENT_MAX_TX_COST_ETH is below MAX_TX_COST_ETH"],
    [{ MAX_BOND_IMD: "0.1" }, "below the desk's minimum bond"],
    [{ MAX_BONDS_AT_RISK_IMD: "0.1" }, "MAX_BONDS_AT_RISK_IMD is below MAX_BOND_IMD"],
    [{ EMPLOYERS: "the good ones" }, "EMPLOYERS holds something that is not an address"],
    [{ LOG_LEVEL: "loud" }, "LOG_LEVEL must be one of"],
    [{ DRY_RUN_PREFLIGHT: "yes" }, "DRY_RUN_PREFLIGHT must be 1 or 0"],
    [{ MAX_JOBS_PER_ORDER: "0" }, "MAX_JOBS_PER_ORDER must be between"],
    [{ MAX_SETTLE_RECORD_BYTES: "200000" }, "MAX_SETTLE_RECORD_BYTES must be between"],
    [{ PREPARED_INPUT_EXTRA_KEYS: "min citations" }, "not a field name"],
    // Two settings that could silently repoint what the runner approves and what it trusts.
    [{ IMD: "0x9efa934d9fad4ae28c998a40195646b965a97247" }, "IMD is no longer a setting"],
    [{ WORK_REGISTRY: "0x9efa934d9fad4ae28c998a40195646b965a97247" }, "WORK_REGISTRY is no longer a setting"],
  ])("refuses %j", (extra, message) => {
    expect(errorOf({ ...base, ...extra })).toContain(message);
  });

  it("allows a local RPC over http, for a fork", () => {
    expect(loadConfig({ ...base, RPC_URL: "http://127.0.0.1:8545" }).rpcUrl).toBe("http://127.0.0.1:8545");
  });

  it("documents every setting it reads, and reads every setting it documents", () => {
    const source = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
    const read = new Set(
      [...source.matchAll(/(?:read|imd|integer|flag|address|addressSet)\(env, "([A-Z0-9_]+)"/g)].map(
        (m) => m[1],
      ),
    );
    const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    const documented = new Set([...example.matchAll(/^#? ?([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
    // Read only to be refused: three settings that were removed, and a chain id that must be 1.
    for (const gone of ["IMD", "WORK_REGISTRY", "REQUIRE_CLAIMED_PATH", "CHAIN_ID"]) read.delete(gone);
    expect([...read].filter((name) => !documented.has(name))).toEqual([]);
    expect([...documented].filter((name) => !read.has(name))).toEqual([]);
    expect(read.size).toBeGreaterThan(30);
  });
});

describe("logging", () => {
  it("writes one JSON object per line", () => {
    const log = memoryLogger();
    log.info("hello", { order: "7", amount: 5n });
    const line = JSON.parse(log.lines[0] ?? "{}") as Record<string, unknown>;
    expect(line).toMatchObject({ level: "info", msg: "hello", order: "7", amount: "5" });
  });

  it("removes a secret wherever it appears, in any spelling", () => {
    const log = memoryLogger([SOME_KEY]);
    log.info("oops", {
      note: `key is ${SOME_KEY}`,
      bare: SOME_KEY.slice(2),
      upper: SOME_KEY.slice(2).toUpperCase(),
      nested: { deep: [SOME_KEY] },
    });
    log.error(`thrown: ${SOME_KEY}`, { error: new Error(`bad ${SOME_KEY.slice(2)}`) });
    const text = log.lines.join("\n");
    expect(text.toLowerCase()).not.toContain(SOME_KEY.slice(2));
    expect(text).toContain(REDACTED);
  });

  it("removes fields whose names say they are secret, whatever they hold", () => {
    const log = memoryLogger();
    log.info("request", {
      headers: { Authorization: "Bearer abc", "payment-signature": "eyJ4", accept: "application/json" },
      privateKey: "0x01",
      quoteSignature: "0x02",
      token: "t",
      paymentHeader: "h",
      order: "7",
    });
    const line = JSON.parse(log.lines[0] ?? "{}") as Record<string, unknown>;
    expect(line.headers).toEqual({
      Authorization: REDACTED,
      "payment-signature": REDACTED,
      accept: "application/json",
    });
    expect(line.privateKey).toBe(REDACTED);
    expect(line.quoteSignature).toBe(REDACTED);
    expect(line.token).toBe(REDACTED);
    expect(line.paymentHeader).toBe(REDACTED);
    expect(line.order).toBe("7");
  });

  it("prints an error as its name and message only", () => {
    const log = memoryLogger();
    const error = Object.assign(new Error("boom"), { request: { headers: { authorization: "Bearer zzz" } } });
    log.warn("failed", { error });
    expect(log.lines[0]).toContain('"error":{"name":"Error","message":"boom"}');
    expect(log.lines[0]).not.toContain("zzz");
  });

  it("respects the level, and ignores secrets too short to be secrets", () => {
    const lines: string[] = [];
    const log = createLogger({
      level: "warn",
      write: (l) => lines.push(l),
      secrets: ["abc", null, undefined],
    });
    log.info("quiet");
    log.warn("abc is fine");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("abc is fine");
    expect(redactText("nothing to hide", [])).toBe("nothing to hide");
  });
});

describe("the store", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "hw-runner-test-"));

  it("creates its file readable by the owner only, and reads it back", () => {
    const path = join(dir(), "nested", "runner.json");
    const store = openFileStore(path, DESK, RUNNER);
    store.data.cursor = "123";
    addSpend(store, NOW, 5n);
    store.save();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const again = openFileStore(path, DESK, RUNNER);
    expect(again.data.cursor).toBe("123");
    expect(spentToday(again, NOW)).toBe(5n);
  });

  it("never contains the wallet key", () => {
    const path = join(dir(), "runner.json");
    const store = openFileStore(path, DESK, RUNNER);
    paidToken(store, null);
    store.save();
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain(TEST_PRIVATE_KEY.slice(2));
    // A store that has held nothing but the token: no key, and none of the optional sections.
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual([
      "cursor",
      "orders",
      "runner",
      "spend",
      "token",
      "version",
      "workOrders",
    ]);
  });

  it("keeps one token, and prefers the operator's", () => {
    const store = memoryStore(DESK, RUNNER);
    const made = paidToken(store, null);
    expect(made).toMatch(/^[0-9a-f]{64}$/);
    expect(paidToken(store, null)).toBe(made);
    expect(paidToken(store, "b".repeat(64))).toBe("b".repeat(64));
    expect(store.data.token).toBe(made);
  });

  it("refuses a file that belongs to another desk or another runner", () => {
    const path = join(dir(), "runner.json");
    openFileStore(path, DESK, RUNNER).save();
    expect(() => openFileStore(path, "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512", RUNNER)).toThrow(
      StoreError,
    );
    expect(() => openFileStore(path, DESK, "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC")).toThrow(StoreError);
    expect(openFileStore(path, DESK.toLowerCase(), RUNNER.toLowerCase()).data.workOrders).toBe(DESK);
  });

  it("refuses a file it does not understand rather than overwrite it", () => {
    const path = join(dir(), "runner.json");
    writeFileSync(path, "not json");
    expect(() => openFileStore(path, DESK, RUNNER)).toThrow("is not JSON");
    // The message says what is at stake before it says how to start over.
    expect(() => openFileStore(path, DESK, RUNNER)).toThrow(/orders this runner has a bond on/);
    expect(() => openFileStore(path, DESK, RUNNER)).toThrow(/START_BLOCK and IMD_PAID_TOKEN/);
    writeFileSync(path, JSON.stringify({ version: 2 }));
    expect(() => openFileStore(path, DESK, RUNNER)).toThrow("is not a runner store");
    expect(readFileSync(path, "utf8")).toBe(JSON.stringify({ version: 2 }));
  });

  it("refuses to save a record that breaks the schema", () => {
    const store = memoryStore(DESK, RUNNER);
    (store.data.orders as Record<string, unknown>)["1"] = { id: "1", status: "unheard-of" };
    expect(() => store.save()).toThrow();
  });

  it("reads a store written before the newer fields existed, and writes the newer fields back", () => {
    const path = join(dir(), "runner.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        workOrders: DESK,
        runner: RUNNER,
        cursor: "10",
        token: null,
        orders: {
          "7": {
            id: "7",
            status: "claimed",
            employer: DESK,
            kindHash: kindHash("audit"),
            specHash: kindHash("x"),
            spec: "x",
            openedBlock: "1",
            spent: "0",
            updatedAt: NOW,
          },
        },
        spend: {},
      }),
    );
    const store = openFileStore(path, DESK, RUNNER);
    expect(store.data.orders["7"]?.status).toBe("claimed");
    store.data.breaker = { failures: 2, trippedAt: NOW, reason: "payment_failed" };
    store.data.employerLosses = { [DESK.toLowerCase()]: 1 };
    store.data.pendingTx = {
      key: "k",
      label: "claim order 7",
      hashes: [`0x${"ab".repeat(32)}`],
      nonce: 5,
      maxFeePerGas: "2000000000",
      maxPriorityFeePerGas: "10000000",
    };
    store.save();
    const again = openFileStore(path, DESK, RUNNER);
    expect(again.data.breaker?.trippedAt).toBe(NOW);
    expect(again.data.pendingTx?.nonce).toBe(5);
    expect(again.data.employerLosses).toEqual({ [DESK.toLowerCase()]: 1 });
  });

  it("books and gives back spending on a named day", () => {
    const store = memoryStore(DESK, RUNNER);
    addSpendOn(store, "2026-10-10", 5n);
    addSpendOn(store, "2026-10-11", 7n);
    addSpendOn(store, "2026-10-10", -5n);
    expect(store.data.spend).toEqual({ "2026-10-10": "0", "2026-10-11": "7" });
  });

  it("never lets the day's spending go below zero", () => {
    const store = memoryStore(DESK, RUNNER);
    addSpend(store, NOW, 3n);
    addSpend(store, NOW, -10n);
    expect(spentToday(store, NOW)).toBe(0n);
    expect(utcDay(NOW)).toBe("2026-10-10");
    expect(utcDay(NOW + 4 * 3600)).toBe("2026-10-11");
  });
});
