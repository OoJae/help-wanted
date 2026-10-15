/**
 * The keeper against the real launch A contracts, on a local node this test starts itself.
 *
 * Nothing here reaches the internet: `anvil` with no fork, launch A's three contracts deployed from
 * `launches/a-payroll/out`, stand-ins for IMD, sIMD, the seats, the Adapter and the Intake compiled
 * from `bots/keeper/contracts`, and a local HTTP server playing IdentityMD's service with an
 * oracle key from the public test mnemonic.
 *
 * The tests are one story and run in order: the first day (dry run, confirmation, the ten
 * transactions, a second run that sends nothing), then the days after it (an answer handed in
 * because the callback is late, a print, a crown, tips, a meter that is too low and topped up from
 * Payroll, a refused round closed by the two-call rule, the hourly drip, and a round the keeper
 * will not close while the service shows it completing).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAbiItem, getAddress, maxUint256, type Address, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOUSE_FEEDS, ImdClient, ROUND_STATUS, questionsAbi, unlaunchedBook } from "@help-wanted/shared";
import { loadConfig } from "../../src/config.js";
import { runFirstDay } from "../../src/firstDayRun.js";
import { memoryLogger } from "../../src/log.js";
import { runLoop, runPass, type Runtime } from "../../src/pass.js";
import { buildRuntime } from "../../src/runtime.js";
import type { StatusFile } from "../../src/status.js";
import {
  ABI,
  IMD,
  StandInService,
  WHO,
  buildStandIns,
  cannotRun,
  deployWorld,
  send,
  startNode,
  type Node,
  type World,
} from "./harness.js";

const reason = cannotRun();
/**
 * The contract's silence deadline for a house feed, in seconds after the request: twelve hours for
 * the oracle to sign, the day of validity the feed asks of an answer, five minutes of clock
 * tolerance and one second.
 */
const SILENCE = 43_200n + 86_400n + 300n + 1n;
const { payrolls, hires, employers } = HOUSE_FEEDS;
const TOP_THREE: Address[] = [
  "0x21919137e69ed667ac404c7fcb71b8179b645f46",
  "0x9fadab91f6fa03dbd7f4f8a08a338704baacf63f",
  "0x7b8c742f2e1eeb3fb2c10d72967fa6d4a22f0479",
].map((address) => getAddress(address));

describe.skipIf(reason !== null)("a full day against the real launch A contracts", () => {
  let node: Node;
  let world: World;
  let service: StandInService;
  let dir: string;
  let digest: Hex;
  const logs: string[] = [];

  /** A keeper built the way the command line builds it, from environment variables. */
  async function keeper(env: Record<string, string | undefined> = {}): Promise<Runtime> {
    const config = loadConfig(
      {
        RPC_URL: node.url,
        IMD_API: service.url,
        API_MIN_INTERVAL_MS: "0",
        QUESTIONS: world.questions,
        JOBS_REPORT: world.jobsReport,
        PAYROLL: world.payroll,
        STATE_PATH: join(dir, "keeper.json"),
        STATUS_PATH: join(dir, "status.json"),
        LIVE: "1",
        KEEPER_PRIVATE_KEY: WHO.keeper.privateKey,
        TIP_COLLECT_MIN_IMD: "0.15",
        ...env,
        // A local chain holds none of our launches: only the addresses given above exist.
      },
      unlaunchedBook(),
    );
    // The stand-ins are not at the mainnet addresses the first-day check expects.
    config.expected = { intake: world.intake, imd: world.imd, oracleSigner: WHO.oracle.address };
    const log = memoryLogger([WHO.keeper.privateKey]);
    logs.length = 0;
    const rt = await buildRuntime(config, {
      log,
      pollingIntervalMs: 20,
      receiptTimeoutMs: 20_000,
      // The real client, pointed at the local server; one try, so a server that is down is quick.
      api: new ImdClient({ baseUrl: service.url, minIntervalMs: 0, maxAttempts: 1 }),
    });
    logs.push(...log.lines);
    (rt as Runtime & { lines: string[] }).lines = log.lines;
    return rt;
  }

  const pass = async (env: Record<string, string | undefined> = {}): Promise<StatusFile> => {
    const status = await runPass(await keeper(env), { command: "once" });
    // HW_PRINT_GAS=1 prints what each transaction used, for the figures in the README.
    if (process.env.HW_PRINT_GAS) {
      for (const r of status.done)
        if (r.outcome === "sent") console.log(`gas ${r.kind}:${r.subject} ${r.gasUsed}`);
    }
    return status;
  };
  const nonce = () => node.public.getTransactionCount({ address: WHO.keeper.address });
  const read = (address: Address, abi: typeof ABI.questions, functionName: string, args: unknown[] = []) =>
    node.public.readContract({ address, abi, functionName, args });
  const sent = (status: StatusFile) =>
    status.done.filter((r) => r.outcome === "sent").map((r) => `${r.kind}:${r.subject}`);
  const feedState = async (feedId: Hex) =>
    (await read(world.questions, ABI.questions, "feedState", [feedId])) as {
      rounds: bigint;
      latestRound: bigint;
      pending: boolean;
      pendingRequestId: Hex;
      failStreak: number;
      meterBalance: bigint;
    };
  const roundOf = async (feedId: Hex, round: bigint) =>
    (await read(world.questions, ABI.questions, "roundOf", [feedId, round])) as readonly [
      number,
      bigint,
      bigint,
      bigint,
      bigint,
    ];
  const requestedAt = async (feedId: Hex, round: bigint) =>
    (
      (await read(world.questions, ABI.questions, "roundRequest", [feedId, round])) as readonly unknown[]
    )[3] as bigint;
  const tips = async () =>
    (await read(world.questions, ABI.questions, "tipsOf", [WHO.keeper.address])) as readonly [bigint, bigint];
  const imdOf = async (who: Address) =>
    (await read(world.imd, world.abis.imd as never, "balanceOf", [who])) as bigint;
  /** The transaction that opened a feed's newest round, from the chain's own log. */
  const requestTx = async (feedId: Hex, round: bigint): Promise<Hex> => {
    const found = await node.public.getLogs({
      address: world.questions,
      event: getAbiItem({ abi: questionsAbi, name: "RoundOpened" }),
      args: { feedId, round },
      fromBlock: 0n,
    });
    const hash = found[0]?.transactionHash;
    if (!hash) throw new Error("no RoundOpened log");
    return hash;
  };

  beforeAll(async () => {
    buildStandIns();
    node = await startNode();
    world = await deployWorld(node);
    service = new StandInService(node, world);
    await service.start();
    dir = mkdtempSync(join(tmpdir(), "hw-keeper-"));
    // A chain with some history behind it: the weekly feed's first window is 50,400 blocks.
    await node.mine(60_000);
  });

  afterAll(() => {
    service?.stop();
    node?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("deployed launch A as the manifest orders it, bound to the three feed ids", async () => {
    expect(await read(world.questions, ABI.questions, "INTAKE")).toBe(world.intake);
    expect(await read(world.jobsReport, ABI.jobsReport, "QUESTIONS")).toBe(world.questions);
    expect(await read(world.payroll, ABI.payroll, "FEED_A")).toBe(payrolls.id);
    expect(await read(world.payroll, ABI.payroll, "FEED_C")).toBe(employers.id);
    // The waits the keeper reads from the contract are the ones the launch fixes.
    expect(await read(world.questions, ABI.questions, "SUBMIT_AFTER_SILENCE")).toBe(1800n);
    expect(await read(world.questions, ABI.questions, "ABANDON_AFTER_SILENCE")).toBe(43_200n);
    expect(await read(world.questions, ABI.questions, "feedCount")).toBe(0n);
  });

  // -------------------------------------------------------------------------------------------
  // The first day
  // -------------------------------------------------------------------------------------------

  it("first day, dry run with no key: prints every step, simulates what can be, sends nothing", async () => {
    const before = await nonce();
    const rt = await keeper({
      LIVE: undefined,
      KEEPER_PRIVATE_KEY: undefined,
      KEEPER_ADDRESS: WHO.keeper.address,
    });
    expect(rt.config.mode).toBe("dry-run");
    const result = await runFirstDay(rt);
    expect(result.plan.steps.map((s) => `${s.id}=${s.status}`)).toEqual([
      "check=done",
      "create:payrolls=todo",
      "create:hires=todo",
      "create:employers=todo",
      "approve=todo",
      "fund:payrolls=later",
      "fund:hires=later",
      "fund:employers=later",
      "request:payrolls=later",
      "request:hires=later",
      "request:employers=later",
    ]);
    expect(result.complete).toBe(false);
    expect(await nonce()).toBe(before);
    expect(await read(world.questions, ABI.questions, "feedCount")).toBe(0n);

    const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as StatusFile;
    expect(status.mode).toBe("dry-run");
    expect(status.command).toBe("first-day");
    // The four steps that can run now were simulated and would succeed; the six that follow are listed.
    expect(status.done.filter((r) => r.outcome === "dry-run").map((r) => [r.kind, r.wouldSucceed])).toEqual([
      ["createFeed", true],
      ["createFeed", true],
      ["createFeed", true],
      ["approve", true],
    ]);
    expect(status.done.filter((r) => r.outcome === "planned").map((r) => r.kind)).toEqual([
      "fund",
      "fund",
      "fund",
      "request",
      "request",
      "request",
    ]);
    digest = result.plan.digest;
    expect((status.firstDay as { digest: string }).digest).toBe(digest);
    // The meters get one runway each at the live cost: 14, 14 and 4 requests of 0.55 IMD.
    expect(result.plan.steps.find((s) => s.id === "approve")?.title).toContain(IMD("17.6").toString());
  });

  it("first day, live: sends nothing without the digest of the plan, or with another one", async () => {
    const before = await nonce();
    const unconfirmed = await runFirstDay(await keeper());
    expect(unconfirmed.stopped).toContain(`FIRST_DAY_CONFIRM=${digest}`);
    const wrong = await runFirstDay(await keeper({ FIRST_DAY_CONFIRM: `0x${"11".repeat(32)}` }));
    expect(wrong.stopped).toContain("is not the digest of this plan");
    expect(await nonce()).toBe(before);
    expect(await read(world.questions, ABI.questions, "feedCount")).toBe(0n);
  });

  it("first day, live and confirmed: creates the feeds, funds the meters, makes the first requests", async () => {
    const before = await nonce();
    const result = await runFirstDay(await keeper({ FIRST_DAY_CONFIRM: digest }));
    expect(result.stopped).toBeNull();
    expect(result.complete).toBe(true);
    // Three feeds, one approval, three fundings, three requests: ten transactions, one at a time.
    expect((await nonce()) - before).toBe(10);

    expect(await read(world.questions, ABI.questions, "feedCount")).toBe(3n);
    // Created from the fixtures on a chain with id 1, the feeds have the launch's own ids.
    expect(await read(world.questions, ABI.questions, "feedAt", [0n])).toBe(payrolls.id);
    expect(await read(world.questions, ABI.questions, "feedAt", [1n])).toBe(hires.id);
    expect(await read(world.questions, ABI.questions, "feedAt", [2n])).toBe(employers.id);

    for (const [feed, left] of [
      [payrolls, IMD("7.15")],
      [hires, IMD("7.15")],
      [employers, IMD("1.65")],
    ] as const) {
      const state = await feedState(feed.id);
      expect(state.rounds, feed.name).toBe(1n);
      expect(state.pending, feed.name).toBe(true);
      // One runway went on, and the first request took the price and set the tip aside.
      expect(state.meterBalance, feed.name).toBe(left);
    }
    expect(await tips()).toEqual([0n, IMD("0.15")]);
    expect(await imdOf(WHO.feePayee.address)).toBe(IMD("1.5"));
    expect(
      await read(world.imd, world.abis.imd as never, "allowance", [WHO.keeper.address, world.questions]),
    ).toBe(0n);

    // Each request went as a transaction of its own: three transactions, one Intake request in each.
    const txs = await Promise.all([payrolls, hires, employers].map((feed) => requestTx(feed.id, 1n)));
    expect(new Set(txs).size).toBe(3);
    for (const tx of txs) {
      const receipt = await node.public.getTransactionReceipt({ hash: tx });
      const requests = receipt.logs.filter((log) => log.address.toLowerCase() === world.intake.toLowerCase());
      expect(requests).toHaveLength(1);
    }
    // The keeper noted which transaction opened which round, and what it spent.
    const state = JSON.parse(readFileSync(join(dir, "keeper.json"), "utf8")) as {
      rounds: Record<string, { requestTx: string }>;
      spend: Record<string, string>;
      pendingTx?: unknown;
    };
    expect(state.rounds[`${payrolls.id}:1`]?.requestTx).toBe(txs[0]);
    expect(BigInt(Object.values(state.spend)[0] ?? "0")).toBeGreaterThan(0n);
    expect(state.pendingTx).toBeUndefined();
    // The key is nowhere in what was logged or written.
    const bare = WHO.keeper.privateKey.slice(2);
    expect(readFileSync(join(dir, "keeper.json"), "utf8")).not.toContain(bare);
    expect(readFileSync(join(dir, "status.json"), "utf8")).not.toContain(bare);
  });

  it("first day, again: every step is done and nothing is sent", async () => {
    const before = await nonce();
    const result = await runFirstDay(await keeper({ FIRST_DAY_CONFIRM: digest }));
    expect(result.complete).toBe(true);
    expect(result.plan.steps.every((s) => s.status === "done")).toBe(true);
    expect(await nonce()).toBe(before);
  });

  // -------------------------------------------------------------------------------------------
  // The first answers: the callback is late, so the keeper hands them in itself
  // -------------------------------------------------------------------------------------------

  let tPayrolls: bigint;
  const ids: Record<string, Hex> = {};

  it("waits while the service is still working on the requests", async () => {
    for (const feed of [payrolls, hires, employers]) {
      const [id] = await service.see(await requestTx(feed.id, 1n));
      ids[`${feed.name}1`] = id as Hex;
      expect(id).toBe((await feedState(feed.id)).pendingRequestId);
    }
    tPayrolls = await requestedAt(payrolls.id, 1n);
    const before = await nonce();
    const status = await pass();
    expect(await nonce()).toBe(before);
    expect(sent(status)).toEqual([]);
    expect(status.waiting.filter((w) => w.module === "questions")).toHaveLength(3);
    expect(
      status.waiting.every((w) => !w.module.startsWith("questions") || w.reason.includes("admitted")),
    ).toBe(true);
    // One polite read per pending round, and no attestation asked for before it could be used.
    expect(service.hits).toEqual({ intake: 3, attestation: 0, oracle: 0 });
    expect(status.nextDue.map((d) => d.block)).toEqual([null, null, null]);
    expect(status.balances.tipsPending).toBe(IMD("0.15").toString());
  });

  it("does not hand an answer in one second before submit opens", async () => {
    // The oracle signs within minutes; the Intake's writer does not come.
    await node.mine(10);
    await service.attest(ids.payrolls1 as Hex, { type: "uint256", value: IMD("114") });
    await service.attest(ids.hires1 as Hex, { type: "uint256", value: 228n });
    await node.mine(15);
    await service.attest(ids.employers1 as Hex, { type: "address[]", value: TOP_THREE });

    await node.mineAt(tPayrolls + 1799n);
    expect(await read(world.questions, ABI.questions, "canSubmit", [payrolls.id])).toBe(false);
    const before = await nonce();
    const status = await pass();
    expect(await nonce()).toBe(before);
    const waiting = status.waiting.find((w) => w.subject === "payrolls round 1");
    expect(waiting?.reason).toContain("completing");
    expect(waiting?.until).toBe(Number(tPayrolls + 1800n));
    expect(service.hits.attestation).toBe(0);
  });

  it("hands the payrolls answer in at the second submit opens, and the hires answer at its own", async () => {
    await node.mineAt(tPayrolls + 1800n);
    expect(await read(world.questions, ABI.questions, "canSubmit", [payrolls.id])).toBe(true);
    // The hires request was made one block later, so its half hour ends one block later.
    expect(await read(world.questions, ABI.questions, "canSubmit", [hires.id])).toBe(false);
    const first = await pass({ MAX_ROUNDS: "1" });
    expect(sent(first)).toEqual(["submit:payrolls"]);
    const answered = await roundOf(payrolls.id, 1n);
    expect(answered[0]).toBe(ROUND_STATUS.Answered);
    expect(answered[1]).toBe(IMD("114"));
    // Whoever hands the answer in earns the round's tip.
    expect(await tips()).toEqual([IMD("0.05"), IMD("0.1")]);
    expect((await feedState(hires.id)).pending).toBe(true);
    // What the pass could not get to is listed, not lost.
    expect(first.done.filter((r) => r.outcome === "left").map((r) => r.kind)).toEqual(["submit", "print"]);

    const second = await pass();
    expect(sent(second)).toEqual(["submit:hires", "print:report"]);
    expect((await roundOf(hires.id, 1n))[1]).toBe(228n);
    expect(await tips()).toEqual([IMD("0.1"), IMD("0.05")]);

    // The report printed the day, with the count attached to it.
    expect(await read(world.jobsReport, ABI.jobsReport, "printCount")).toBe(1n);
    const latest = (await read(world.jobsReport, ABI.jobsReport, "latestPrint")) as readonly [
      boolean,
      bigint,
      { amount: bigint; count: bigint; payrollsRound: bigint; hiresRound: bigint },
    ];
    expect(latest[2]).toMatchObject({ amount: IMD("114"), count: 228n, payrollsRound: 1n, hiresRound: 1n });
    // The employers round is the panel's: nobody can hand it in, and the keeper does not try.
    expect(second.waiting.find((w) => w.subject === "employers round 1")?.reason).toContain(
      "only the Intake's callback can answer this feed",
    );
  });

  it("a callback that comes hours after the answer was handed in changes nothing", async () => {
    await node.mine(1200);
    const before = await roundOf(payrolls.id, 1n);
    // The writer writes at last. The round is settled, so the callback reverts inside the Intake.
    expect(await service.complete(ids.payrolls1 as Hex)).toBe(false);
    expect(await service.complete(ids.hires1 as Hex)).toBe(false);
    expect(await roundOf(payrolls.id, 1n)).toEqual(before);
    expect(await tips()).toEqual([IMD("0.1"), IMD("0.05")]);
  });

  it("crowns the employers round once the Intake's callback has answered it, and collects the tips", async () => {
    // Four hours after the request the writer delivers the panel's answer: only it can.
    expect(await service.complete(ids.employers1 as Hex)).toBe(true);
    expect((await roundOf(employers.id, 1n))[0]).toBe(ROUND_STATUS.Answered);
    const held = await imdOf(WHO.keeper.address);
    const status = await pass();
    // The keeper opened that round, so its tip is the keeper's: 0.15 IMD earned in all.
    expect(sent(status)).toEqual(["collectTips:tips", "crown:employers"]);
    expect(await tips()).toEqual([0n, 0n]);
    expect((await imdOf(WHO.keeper.address)) - held).toBe(IMD("0.15"));
    const crown = (await read(world.jobsReport, ABI.jobsReport, "crownOf", [1n])) as {
      first: Address;
      second: Address;
      third: Address;
      places: number;
    };
    expect([crown.first, crown.second, crown.third]).toEqual(TOP_THREE);
    expect(crown.places).toBe(3);
    // Nothing left to do: a second pass sends nothing.
    const before = await nonce();
    expect(sent(await pass())).toEqual([]);
    expect(await nonce()).toBe(before);
  });

  // -------------------------------------------------------------------------------------------
  // The second day: a meter that is too low, Payroll's first fees, a refused round
  // -------------------------------------------------------------------------------------------

  it("asks what it can when a meter is too low and Payroll has nothing to place on it", async () => {
    // The wallet that funded the payrolls meter takes its IMD back, as any funder may.
    await send(node, WHO.keeper, world.questions, ABI.questions, "defund", [payrolls.id, maxUint256]);
    expect((await feedState(payrolls.id)).meterBalance).toBe(0n);
    await node.mine(7000);
    const status = await pass();
    // Hires is due and asked. Employers is weekly. Payrolls cannot pay for a request.
    expect(sent(status)).toEqual(["request:hires"]);
    expect(status.attention.some((a) => a.startsWith("payrolls") && a.includes("fund the meter"))).toBe(true);
    expect(status.nextDue.find((d) => d.feed === "employers")?.note).toContain("due in about");
    ids.hires2 = (await feedState(hires.id)).pendingRequestId;
  });

  let bookedAt: bigint;

  it("books Payroll's first fees, tops the meters up from them, and then asks", async () => {
    // Fees reach Payroll by plain transfer, as the desk sends them when `pay` cannot go through.
    await send(node, WHO.deployer, world.imd, world.abis.imd as never, "mint", [world.payroll, IMD("100")]);
    const vault = await imdOf(world.simd);
    const status = await pass();
    // One pass: book; then the top-up the low meter needs (the same call Payroll's own shortfall
    // rule asks for, sent once); then the request the top-up made possible.
    expect(sent(status)).toEqual(["book:payroll", "fundFeeds:payrolls", "request:payrolls"]);
    const ledger = (await read(world.payroll, ABI.payroll, "ledger")) as {
      received: bigint;
      feedsFunded: bigint;
    };
    expect(ledger.received).toBe(IMD("100"));
    // Payroll put its own runway on each meter: 14, 14 and 4 requests of 0.55 IMD.
    expect(ledger.feedsFunded).toBe(IMD("17.6"));
    // The request that followed has already spent one request's worth of Payroll's position on
    // the payrolls meter. Half an IMD short of a runway is under the keeper's threshold for a
    // top-up, so it does not call again for it.
    expect(await read(world.payroll, ABI.payroll, "feedShortfalls")).toEqual([IMD("0.55"), 0n, 0n]);
    expect((await feedState(payrolls.id)).pending).toBe(true);
    expect((await feedState(payrolls.id)).meterBalance).toBe(IMD("7.15"));
    ids.payrolls2 = (await feedState(payrolls.id)).pendingRequestId;
    const record = status.done.find((r) => r.kind === "fundFeeds");
    expect(record?.reason).toContain("the meter of payrolls holds 0");
    // The top-up was sent with gas to spare: an estimate alone can starve the calls inside it.
    expect(BigInt(record?.gasUsed ?? "0")).toBeGreaterThan(300_000n);
    // A few seconds of the stream have vested. That is not worth a transaction: no drip yet.
    expect(await imdOf(world.simd)).toBe(vault);
    const waiting = status.waiting.find((w) => w.subject === "drip");
    expect(waiting?.reason).toContain("less than a whole drip");
    const booked = status.done.find((r) => r.kind === "book");
    bookedAt = (await node.public.getBlock({ blockNumber: BigInt(booked?.block ?? "0") })).timestamp;
  });

  it("drips a whole hour of the stream, stops at the kill switch, and drips again exactly an hour later", async () => {
    // The stakers' half of 100 IMD vests over seven days: an hour of it is about 0.2976 IMD.
    await node.mineAt(bookedAt + 3600n);
    const vault = await imdOf(world.simd);
    const first = await pass();
    expect(sent(first)).toEqual(["drip:payroll"]);
    const hour = (await imdOf(world.simd)) - vault;
    expect(hour).toBeGreaterThan(IMD("0.29"));
    expect(hour).toBeLessThan(IMD("0.31"));

    const clock = (await read(world.payroll, ABI.payroll, "clock")) as readonly bigint[];
    const lastDripAt = clock[2] as bigint;
    await node.mineAt(lastDripAt + 3599n);
    const early = await pass();
    expect(sent(early)).toEqual([]);
    expect(early.waiting.find((w) => w.subject === "drip")?.until).toBe(Number(lastDripAt + 3600n));

    await node.mineAt(lastDripAt + 3600n);
    const killFile = join(dir, "keeper.json.KILL");
    writeFileSync(killFile, "");
    const killed = await pass();
    expect(killed.killed).toBe(true);
    expect(sent(killed)).toEqual([]);
    expect(killed.done.map((r) => [r.kind, r.outcome, r.code])).toEqual([["drip", "failed", "killed"]]);
    expect(killed.attention[0]).toBe("the kill switch is on: nothing is sent");
    rmSync(killFile);

    const before = await imdOf(world.simd);
    const status = await pass();
    expect(sent(status)).toEqual(["drip:payroll"]);
    const dripped = (await imdOf(world.simd)) - before;
    expect(dripped).toBeGreaterThan(IMD("0.29"));
    expect(dripped).toBeLessThan(IMD("0.31"));
  });

  it("hands in the payrolls answer, and closes the refused hires round by the two-call rule", async () => {
    await service.see(await requestTx(payrolls.id, 2n));
    await service.see(await requestTx(hires.id, 2n));
    await service.attest(ids.payrolls2 as Hex, { type: "uint256", value: IMD("120") });
    service.fail(ids.hires2 as Hex, 1, "body_refused");

    const opens = (await requestedAt(payrolls.id, 2n)) + 1800n;
    if ((await node.latest()).timestamp < opens) await node.mineAt(opens);
    const first = await pass();
    expect(sent(first)).toEqual(["submit:payrolls", "print:report"]);
    expect(await read(world.jobsReport, ABI.jobsReport, "printCount")).toBe(2n);
    // The service calls the hires request refused; the Intake has not written it, so nothing can
    // be closed before the silence deadline, which the keeper reads from the contract.
    const waiting = first.waiting.find((w) => w.subject === "hires round 2");
    expect(waiting?.reason).toContain("refused");
    expect(waiting?.until).toBe(Number((await requestedAt(hires.id, 2n)) + SILENCE));
    expect(
      ((await read(world.questions, ABI.questions, "canAbandon", [hires.id])) as [number, bigint])[1],
    ).toBe((await requestedAt(hires.id, 2n)) + SILENCE);

    // The writer writes the refusal: no callback. The first abandon only starts thirty minutes.
    expect(await service.complete(ids.hires2 as Hex)).toBe(false);
    const start = await pass();
    expect(sent(start)).toEqual(["abandon-start:hires"]);
    expect((await feedState(hires.id)).pending).toBe(true);
    const [step, closableAt] = (await read(world.questions, ABI.questions, "canAbandon", [hires.id])) as [
      number,
      bigint,
    ];
    expect(step).toBe(0);

    await node.mineAt(closableAt - 1n);
    expect(sent(await pass())).toEqual([]);
    await node.mineAt(closableAt);
    const close = await pass();
    expect(sent(close)).toEqual(["abandon:hires"]);
    expect((await roundOf(hires.id, 2n))[0]).toBe(ROUND_STATUS.Failed);
    const state = await feedState(hires.id);
    expect(state.pending).toBe(false);
    expect(state.failStreak).toBe(1);
    // The oracle's own record of the refusal was read once, to say why in the status file.
    expect(service.hits.oracle).toBe(1);
    expect(close.done[0]?.reason).toContain("body_refused");
  });

  // -------------------------------------------------------------------------------------------
  // A week later: a round the service shows as completing is not closed
  // -------------------------------------------------------------------------------------------

  it("does not close a round the service shows as completing, even after its silence deadline, unless told to", async () => {
    // The payroll module is switched off for this part: a week of the stream is waiting, and its
    // hourly drips would be mixed in with what is being watched here.
    const only = { MODULES: "questions,jobsReport" };
    await node.mine(49_000);
    const asked = await pass(only);
    expect(sent(asked).filter((s) => s.startsWith("request"))).toEqual([
      "request:payrolls",
      "request:hires",
      "request:employers",
    ]);
    for (const feed of [payrolls, hires, employers]) {
      const round = (await feedState(feed.id)).rounds;
      const [id] = await service.see(await requestTx(feed.id, round));
      ids[`${feed.name}Late`] = id as Hex;
    }
    await service.attest(ids.payrollsLate as Hex, { type: "uint256", value: IMD("700") });
    await service.attest(ids.hiresLate as Hex, { type: "uint256", value: 1400n });
    await service.attest(ids.employersLate as Hex, { type: "address[]", value: TOP_THREE });

    const tEmployers = await requestedAt(employers.id, 2n);
    await node.mineAt(tEmployers + 1800n);
    const handed = await pass(only);
    // Both answers in the first look; in the second, the report prints them and the three tips
    // earned since the last collection (0.15 IMD) reach the threshold.
    expect(sent(handed)).toEqual(["submit:payrolls", "submit:hires", "collectTips:tips", "print:report"]);
    // An answered round puts the hires cadence back.
    expect((await feedState(hires.id)).failStreak).toBe(0);

    // From here only the employers feed is kept: a day and a half on, the daily feeds are due
    // again, and their requests would move the clock past the second being tested.
    const employersOnly = { MODULES: "questions", FEEDS: "employers" };

    // Twelve hours after the request the round could be closed before launch A was adapted. Now
    // the contract says wait, and the keeper sends nothing even when told to close.
    await node.mineAt(tEmployers + 43_200n);
    const [stepAtTwelve, closableAt] = (await read(world.questions, ABI.questions, "canAbandon", [
      employers.id,
    ])) as [number, bigint];
    expect(stepAtTwelve).toBe(0);
    expect(closableAt).toBe(tEmployers + SILENCE);
    expect(sent(await pass({ ...employersOnly, CLOSE_ROUNDS_IN_PROGRESS: "1" }))).toEqual([]);

    // One second before the silence deadline: the contract would refuse, and nothing is sent.
    await node.mineAt(tEmployers + SILENCE - 1n);
    expect(
      ((await read(world.questions, ABI.questions, "canAbandon", [employers.id])) as [number, bigint])[0],
    ).toBe(0);
    expect(sent(await pass({ ...employersOnly, CLOSE_ROUNDS_IN_PROGRESS: "1" }))).toEqual([]);

    // At the deadline anyone may close it. The service still shows the request as completing: the
    // panel's answer exists and the writer has not delivered it. The keeper leaves the round open.
    await node.mineAt(tEmployers + SILENCE);
    expect(
      ((await read(world.questions, ABI.questions, "canAbandon", [employers.id])) as [number, bigint])[0],
    ).toBe(2);
    const before = await nonce();
    const held = await pass(employersOnly);
    expect(sent(held)).toEqual([]);
    expect(await nonce()).toBe(before);
    expect(held.attention.some((a) => a.startsWith("employers round 2") && a.includes("completing"))).toBe(
      true,
    );
    expect((await feedState(employers.id)).pending).toBe(true);

    // A service that cannot be read is no reason to close either.
    service.down = true;
    const blind = await pass(employersOnly);
    expect(sent(blind)).toEqual([]);
    expect(blind.attention.some((a) => a.includes("could not be read"))).toBe(true);
    service.down = false;

    // Told to, it closes the round. The answer that comes afterwards is refused by the contract.
    const closed = await pass({ ...employersOnly, CLOSE_ROUNDS_IN_PROGRESS: "1" });
    expect(sent(closed)).toEqual(["abandon:employers"]);
    expect((await roundOf(employers.id, 2n))[0]).toBe(ROUND_STATUS.Failed);
    expect(await service.complete(ids.employersLate as Hex)).toBe(false);
  });

  it("runs as a loop, and leaves a status file a page can read", async () => {
    const rt = await keeper({ LIVE: "0" });
    const stop = new AbortController();
    let passes = 0;
    await runLoop(rt, {
      signal: stop.signal,
      sleep: async () => {
        passes += 1;
        if (passes === 2) stop.abort();
      },
    });
    expect(passes).toBe(2);
    expect(existsSync(join(dir, "status.json"))).toBe(true);
    const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as StatusFile;
    expect(status.v).toBe(1);
    expect(status.command).toBe("run");
    expect(status.mode).toBe("dry-run");
    expect(status.keeper).toBe(WHO.keeper.address);
    expect(status.modules.enabled).toEqual(["questions", "jobsReport", "payroll"]);
    expect(status.modules.payroll).toBeDefined();
    // The modules of launches B and C are built; with no address of theirs given, none of them runs.
    expect(status.modules.later).toEqual({});
    expect(status.modules.desk).toBeUndefined();
    expect(status.nextDue.map((d) => d.feed)).toEqual(["payrolls", "hires", "employers"]);
    expect(status.checked.length).toBeGreaterThanOrEqual(5);
    expect(BigInt(status.spend.spentWei)).toBeGreaterThan(0n);
    expect(BigInt(status.balances.eth ?? "0")).toBeGreaterThan(0n);
  });
});

// When the test cannot run, say why once, instead of a silent row of skips.
if (reason !== null) {
  it(`the integration test is skipped: ${reason}`, (ctx) => {
    ctx.skip(reason);
  });
}
