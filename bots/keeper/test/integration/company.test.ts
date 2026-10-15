/**
 * The runner and the keeper together, against the real contracts of all three launches, on a local
 * node this test starts itself.
 *
 * Nothing here reaches the internet: `anvil` with no fork; launches A, B and C deployed from the
 * launch projects' own build output, in launch order; stand-ins for IMD, sIMD, the seats, the
 * Adapter, the Intake and the WorkRegistry (whose writer the test plays); and a local HTTP server
 * that plays IdentityMD: the routes the bots read, and the paid-action routes the runner calls,
 * where both of the runner's signatures are checked the way IdentityMD's guide describes before a
 * job is admitted. The keys are the ones every local node prints.
 *
 * The tests are one story and run in order. Balances and states are read from the chain at each
 * step.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeEventLog,
  getAbiItem,
  keccak256,
  stringToHex,
  toFunctionSelector,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  HOUSE_FEEDS,
  ImdClient,
  MAINNET,
  ORDER_FLAG,
  ORDER_STATE,
  bytes16ToUuid,
  kindHash,
  orderHeader,
  questionsAbi,
  releaseCut,
  splitPrice,
  uuidToBytes16,
  workOrdersAbi,
} from "@help-wanted/shared";
import { bootstrap } from "../../../runner/src/commands.js";
import { loadConfig as loadRunnerConfig } from "../../../runner/src/config.js";
import { memoryLogger as runnerLogger } from "../../../runner/src/log.js";
import { buildRuntime as buildRunner, type Runtime as RunnerRuntime } from "../../../runner/src/runtime.js";
import type { OrderRecord } from "../../../runner/src/store.js";
import { loadConfig } from "../../src/config.js";
import { memoryLogger } from "../../src/log.js";
import { runPass, type Runtime } from "../../src/pass.js";
import { buildRuntime } from "../../src/runtime.js";
import type { StatusFile } from "../../src/status.js";
import { ABI, WHO, buildStandIns, send, startNode, type Node, type TestAccount } from "./harness.js";
import { StandInPlane } from "./plane.js";
import { ABIS, CAST, IMD, approve, cannotRunAll, deployCompany, imdOf, mint, type Company } from "./world.js";

const reason = cannotRunAll();
const HOUR = 3_600n;
const DAY = 86_400n;
const REPORT = "skill:research-report";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

interface OrderOnChain {
  employer: Address;
  expiresAt: number;
  state: number;
  flags: number;
  bond: bigint;
  condMet: boolean;
  proven: boolean;
  seq: number;
  escrow: bigint;
}
interface ClaimOnChain {
  runner: Address;
  claimedAt: number;
  registeredAt: number;
  price: bigint;
  jobId: Hex;
  challenger: Address;
  assertedAt: number;
  recordHash: Hex;
}

describe.skipIf(reason !== null)(
  "the runner and the keeper on the real contracts of all three launches",
  () => {
    let node: Node;
    let co: Company;
    let plane: StandInPlane;
    let dir: string;
    let startBlock: bigint;
    const DESK_ABI = workOrdersAbi as unknown as Abi;

    /** The bots' clock is the chain's: the wall clock is set to the newest block's time. */
    const sync = async (): Promise<bigint> => {
      const { timestamp } = await node.latest();
      vi.setSystemTime(Number(timestamp) * 1000);
      return timestamp;
    };
    /** Mines one block at a time of day and brings the bots' clock there. */
    const warpTo = async (timestamp: bigint): Promise<void> => {
      await node.mineAt(timestamp);
      await sync();
    };

    // -------------------------------------------------------------------------------------------
    // The two bots, built the way their command lines build them
    // -------------------------------------------------------------------------------------------

    const runnerLines: string[] = [];
    async function runner(env: Record<string, string | undefined> = {}): Promise<RunnerRuntime> {
      const config = loadRunnerConfig({
        RPC_URL: node.url,
        IMD_API: plane.url,
        WORK_ORDERS: co.workOrders,
        LIVE: "1",
        RUNNER_PRIVATE_KEY: CAST.runner.privateKey,
        START_BLOCK: startBlock.toString(),
        STORE_PATH: join(dir, "runner.json"),
        IMD_PAID_TOKEN: "ab".repeat(32),
        CONFIRMATIONS: "0",
        LOG_CHUNK_BLOCKS: "50000",
        // The local node's blocks are twelve seconds apart, so fifty of them are ten minutes.
        RECEIPT_STALL_BLOCKS: "50",
        CLAIM_SETTLE_SECONDS: "0",
        MAX_FEE_GWEI: "10",
        MAX_TX_COST_ETH: "0.05",
        URGENT_MAX_FEE_GWEI: "30",
        URGENT_MAX_TX_COST_ETH: "0.1",
        MAX_CONCURRENT: "3",
        ...env,
      });
      const log = runnerLogger([CAST.runner.privateKey]);
      const rt = await buildRunner(config, {
        log,
        pollingIntervalMs: 20,
        receiptTimeoutMs: 20_000,
        // The real client, pointed at the local server, with no pause between requests.
        api: new ImdClient({ baseUrl: plane.url, minIntervalMs: 0, maxAttempts: 1 }),
      });
      runnerLines.length = 0;
      (rt as RunnerRuntime & { lines: string[] }).lines = log.lines;
      return rt;
    }
    /** One pass of the runner, from a fresh process each time: the store carries it over. */
    const tick = async (env: Record<string, string | undefined> = {}): Promise<string[]> => {
      await sync();
      const rt = await runner(env);
      await rt.machine.tick();
      const lines = (rt as RunnerRuntime & { lines: string[] }).lines;
      runnerLines.push(...lines);
      // HW_PRINT_LOGS=1 prints what the runner said at warn and error, pass by pass.
      if (process.env.HW_PRINT_LOGS) {
        for (const line of lines) if (/"level":"(warn|error)"/.test(line)) console.log(`runner ${line}`);
      }
      return lines;
    };
    const runnerOrder = (id: bigint): OrderRecord | undefined =>
      (JSON.parse(readFileSync(join(dir, "runner.json"), "utf8")) as { orders: Record<string, OrderRecord> })
        .orders[id.toString()];

    async function keeper(env: Record<string, string | undefined> = {}): Promise<Runtime> {
      const config = loadConfig({
        RPC_URL: node.url,
        IMD_API: plane.url,
        API_MIN_INTERVAL_MS: "0",
        QUESTIONS: co.questions,
        JOBS_REPORT: co.jobsReport,
        PAYROLL: co.payroll,
        WORK_ORDERS: co.workOrders,
        CROWD_POTS: co.crowdPots,
        DOORBELL: co.doorbell,
        RULES: co.rules,
        ENDOWMENTS: co.endowments,
        START_BLOCK_B: startBlock.toString(),
        START_BLOCK_C: startBlock.toString(),
        MODULES: "desk,pots,doorbell,rules,endowments",
        STATE_PATH: join(dir, "keeper.json"),
        STATUS_PATH: join(dir, "status.json"),
        LIVE: "1",
        KEEPER_PRIVATE_KEY: WHO.keeper.privateKey,
        RECEIPT_STALL_BLOCKS: "50",
        DAILY_SPEND_CAP_ETH: "5",
        MAX_TX_COST_ETH: "0.05",
        ...env,
      });
      config.expected = { intake: co.intake, imd: co.imd, oracleSigner: WHO.oracle.address };
      return buildRuntime(config, {
        log: memoryLogger([WHO.keeper.privateKey]),
        pollingIntervalMs: 20,
        receiptTimeoutMs: 20_000,
        api: new ImdClient({ baseUrl: plane.url, minIntervalMs: 0, maxAttempts: 1 }),
      });
    }
    const pass = async (env: Record<string, string | undefined> = {}): Promise<StatusFile> => {
      await sync();
      const status = await runPass(await keeper(env), { command: "once" });
      // HW_PRINT_GAS=1 prints what each of the keeper's transactions used, for the README.
      if (process.env.HW_PRINT_GAS) {
        for (const r of status.done)
          if (r.outcome === "sent") console.log(`gas ${r.kind}:${r.subject} ${r.gasUsed}`);
      }
      if (process.env.HW_PRINT_LOGS) {
        for (const r of status.done)
          if (r.outcome === "failed") console.log(`keeper failed ${r.label}: ${r.error}`);
        for (const a of status.attention) console.log(`keeper attention: ${a}`);
      }
      return status;
    };
    const sent = (status: StatusFile) =>
      status.done.filter((r) => r.outcome === "sent").map((r) => `${r.kind}:${r.subject}`);
    const sentFor = (status: StatusFile, subject: string) =>
      status.done.filter((r) => r.outcome === "sent" && r.subject === subject).map((r) => r.kind);
    const failed = (status: StatusFile) => status.done.filter((r) => r.outcome === "failed");
    const claimsOf = (status: StatusFile) =>
      (status.modules.desk as { claims: { order: string; verdict: string; action: string; why: string }[] })
        .claims;

    // -------------------------------------------------------------------------------------------
    // Reading the chain
    // -------------------------------------------------------------------------------------------

    const read = (address: Address, abi: Abi, functionName: string, args: unknown[] = []) =>
      node.public.readContract({ address, abi, functionName, args });
    const orderOf = async (id: bigint) =>
      (await read(co.workOrders, DESK_ABI, "orderOf", [id])) as OrderOnChain;
    const claimOf = async (id: bigint) =>
      (await read(co.workOrders, DESK_ABI, "claimOf", [id])) as ClaimOnChain;
    const accountOf = async (id: bigint) => {
      const [state, employer, escrow, spent, returned] = (await read(co.workOrders, DESK_ABI, "accountOf", [
        id,
      ])) as [number, Address, bigint, bigint, bigint];
      return { state, employer, escrow, spent, returned };
    };
    const balance = (who: Address) => imdOf(node, co, who);
    const ledger = async () =>
      (await read(co.payroll, ABI.payroll, "ledger")) as {
        received: bigint;
        tipsIn: bigint;
        tipsToSeats: bigint;
      };
    const orderCount = async () => (await read(co.workOrders, DESK_ABI, "orderCount")) as bigint;
    const eventsOf = async (tx: Hex, abi: Abi, name: string) => {
      const receipt = await node.public.getTransactionReceipt({ hash: tx });
      const out: Record<string, unknown>[] = [];
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics });
          if (decoded.eventName === name) out.push(decoded.args as unknown as Record<string, unknown>);
        } catch {
          // Another contract's log.
        }
      }
      return out;
    };

    // -------------------------------------------------------------------------------------------
    // What people do
    // -------------------------------------------------------------------------------------------

    /** An employer opens an order on the desk and escrows its top price. */
    async function openOrder(
      spec: string,
      over: Partial<{
        from: TestAccount;
        kind: string;
        minPay: bigint;
        maxPay: bigint;
        rampSecs: number;
        deliverySecs: number;
        lifetime: bigint;
        bond: bigint;
        flags: number;
        condTarget: Address;
        condSelector: Hex;
        condArg: Hex;
        condCmp: number;
        condThreshold: bigint;
      }> = {},
    ): Promise<bigint> {
      const from = over.from ?? CAST.employer;
      const maxPay = over.maxPay ?? IMD("3");
      const { timestamp } = await node.latest();
      await approve(node, co, from, co.workOrders, maxPay);
      await send(node, from, co.workOrders, DESK_ABI, "createOrder", [
        {
          kindHash: kindHash(over.kind ?? REPORT),
          minPay: over.minPay ?? maxPay,
          maxPay,
          rampSecs: over.rampSecs ?? 0,
          deliverySecs: over.deliverySecs ?? 3 * 86_400,
          expiresAt: Number(timestamp + (over.lifetime ?? 7n * DAY)),
          bond: over.bond ?? IMD("0.25"),
          flags: over.flags ?? ORDER_FLAG.ALLOW_CLAIMED,
          runnerOnly: ZERO,
          arbiter: ZERO,
          condTarget: over.condTarget ?? ZERO,
          condSelector: over.condSelector ?? "0x00000000",
          condArg: over.condArg ?? ZERO_HASH,
          condCmp: over.condCmp ?? 0,
          condThreshold: over.condThreshold ?? 0n,
        },
        stringToHex(spec),
      ]);
      return orderCount();
    }

    /**
     * The runner takes an order as far as a registered job: it claims, pays the plane, the swarm
     * finishes the job, and the runner registers it. Returns the job and its record.
     */
    async function takeToRegistered(id: bigint, env: Record<string, string | undefined> = {}) {
      await tick(env);
      expect(runnerOrder(id)?.status, runnerLines.join("\n")).toBe("claimed");
      await tick(env);
      expect(runnerOrder(id)?.status, runnerLines.join("\n")).toBe("paid");
      const jobId = runnerOrder(id)?.jobId as string;
      // The job is running: the runner holds its registration back while it can still give the
      // order back for a tenth of the bond.
      await tick(env);
      expect((await orderOf(id)).state).toBe(ORDER_STATE.Claimed);
      const record = plane.finishJob(jobId);
      await tick(env);
      expect(runnerOrder(id)?.status, runnerLines.join("\n")).toBe("registered");
      expect((await orderOf(id)).state).toBe(ORDER_STATE.Registered);
      expect((await claimOf(id)).jobId).toBe(uuidToBytes16(jobId));
      return { jobId, ...record };
    }

    beforeAll(async () => {
      vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
      buildStandIns();
      node = await startNode();
      startBlock = (await node.latest()).number;
      co = await deployCompany(node);
      plane = new StandInPlane(node, co);
      await plane.start();
      dir = mkdtempSync(join(tmpdir(), "hw-company-"));
      for (const [who, amount] of [
        [CAST.runner, "5"],
        [CAST.employer, "100"],
        [CAST.alice, "20"],
        [CAST.bob, "20"],
        [CAST.rogue, "5"],
        [CAST.creator, "20"],
        [CAST.depositor, "200"],
      ] as const) {
        await mint(node, co, who.address, IMD(amount));
      }
      // Some history behind the chain: a feed's first window covers 7,000 blocks.
      await node.mine(8_000);
      await sync();
    });

    afterAll(() => {
      vi.useRealTimers();
      plane?.stop();
      node?.stop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("deployed the three launches in order, each bound to the one before", async () => {
      expect(await read(co.workProof, ABIS.workProof, "WORK_REGISTRY")).toBe(co.registry);
      expect(co.registry).toBe(MAINNET.WORK_REGISTRY);
      expect(co.imd).toBe(MAINNET.IMD);
      expect(await read(co.workOrders, DESK_ABI, "IMD")).toBe(co.imd);
      expect(await read(co.workOrders, DESK_ABI, "WORK_PROOF")).toBe(co.workProof);
      // Launch B pays its fees into launch A's Payroll.
      expect(await read(co.workOrders, DESK_ABI, "PAYROLL")).toBe(co.payroll);
      expect(await read(co.crowdPots, ABIS.crowdPots, "WORK_ORDERS")).toBe(co.workOrders);
      expect(await read(co.doorbell, ABIS.doorbell, "WORK_ORDERS")).toBe(co.workOrders);
      expect(await read(co.rules, ABIS.rules, "WORK_ORDERS")).toBe(co.workOrders);
      expect(await read(co.endowments, ABIS.endowments, "QUESTIONS")).toBe(co.questions);
      expect(await read(co.endowments, ABIS.endowments, "CROWD_POTS")).toBe(co.crowdPots);
      // The figures the bots' arithmetic mirrors, read from the deployed desk.
      expect(await read(co.workOrders, DESK_ABI, "CLAIM_WINDOW")).toBe(3_600n);
      expect(await read(co.workOrders, DESK_ABI, "CHALLENGE_WINDOW")).toBe(86_400n);
      expect(await read(co.workOrders, DESK_ABI, "DISPUTE_WINDOW")).toBe(86_400n);
      expect(await read(co.workOrders, DESK_ABI, "PAYROLL_GAS")).toBe(1_000_000n);
    });

    it("serves a work record the real WorkProof reads as the runner's scanner does", async () => {
      // A job nobody ordered, finished and receipted: it also makes the registry's receipts recent.
      const job = plane.openJob({
        objective: `${orderHeader(keccak256("0x01"))}Say hello.`,
        template: REPORT,
        paidBy: CAST.alice.address,
      });
      const { hash, bytes } = plane.finishJob(job.id);
      await plane.writeReceipt(job.id);
      expect(await read(co.registry, ABIS.registry, "latest", [uuidToBytes16(job.id)])).toBe(hash);
      const proof = (await read(co.workProof, ABIS.workProof, "prove", [
        uuidToBytes16(job.id),
        `0x${Buffer.from(bytes).toString("hex")}`,
        85n,
      ])) as { recordHash: Hex; kindHash: Hex; stateHash: Hex; agentIds: bigint[] };
      expect(proof.recordHash).toBe(hash);
      expect(proof.kindHash).toBe(kindHash(REPORT));
      expect(proof.stateHash).toBe(keccak256(stringToHex("completed")));
      expect(proof.agentIds).toEqual([52715n]);
    });

    // -------------------------------------------------------------------------------------------
    // 1. The proven path
    // -------------------------------------------------------------------------------------------

    it("1. an order is taken, paid for, registered and settled on its receipt", async () => {
      const SPEC = "Write a one-page plain-language summary of who paid the swarm this week, with sources.";
      // The runner's one-time approval of Permit2, as its bootstrap command sends it.
      await sync();
      await bootstrap(await runner());
      expect(await read(co.imd, ABIS.imd, "allowance", [CAST.runner.address, MAINNET.PERMIT2])).toBe(
        IMD("5"),
      );

      // An order only a receipt can pay, with a price that rises from 2 to 4 IMD over an hour.
      const id = await openOrder(SPEC, { minPay: IMD("2"), maxPay: IMD("4"), rampSecs: 3_600, flags: 0 });
      const before = {
        runner: await balance(CAST.runner.address),
        employer: await balance(CAST.employer.address),
        payee: await balance(MAINNET.FEE_PAYEE),
        payroll: await balance(co.payroll),
        ledger: await ledger(),
      };
      expect((await accountOf(id)).escrow).toBe(IMD("4"));

      // The registry wrote a receipt a few blocks ago, so a receipt-only order is worth a bond.
      const { jobId, hash, bytes } = await takeToRegistered(id);
      const claim = await claimOf(id);
      const order = await orderOf(id);
      expect(claim.runner).toBe(CAST.runner.address);
      expect(claim.price).toBeGreaterThan(IMD("2"));
      expect(claim.price).toBeLessThan(IMD("2.2"));

      // What the plane was asked, and what it checked before it admitted the job.
      expect(plane.checks).toHaveLength(1);
      expect(plane.payments).toHaveLength(1);
      expect(plane.payments[0]).toMatchObject({ payer: CAST.runner.address, amount: IMD("0.5"), jobId });
      expect(plane.refusals).toEqual([]);
      // The job's objective is the desk's own header for this claim, then the spec, byte for byte.
      const header = Buffer.from(
        ((await read(co.workOrders, DESK_ABI, "headerOf", [id])) as Hex).slice(2),
        "hex",
      ).toString("utf8");
      expect(plane.job(jobId).objective).toBe(header + SPEC);
      expect(plane.job(jobId).template).toBe(REPORT);
      // The fee went to IdentityMD's payee, out of the runner's allowance to Permit2.
      expect(await balance(MAINNET.FEE_PAYEE)).toBe(before.payee + IMD("0.5"));
      expect(await balance(CAST.runner.address)).toBe(before.runner - IMD("0.5") - order.bond);

      // The job is completed and its record listed; this order allows no claim, so the runner waits.
      await tick();
      expect((await orderOf(id)).state).toBe(ORDER_STATE.Registered);
      expect(runnerLines.some((l) => l.includes("waiting for its receipt"))).toBe(true);

      // The receipt is recorded, and the runner settles with the bytes the plane serves.
      await plane.writeReceipt(jobId);
      await tick();
      expect(runnerOrder(id)?.status, runnerLines.join("\n")).toBe("delivered");
      const settleTx = /settled against the receipt in (0x[0-9a-f]{64})/.exec(
        runnerOrder(id)?.outcome ?? "",
      )?.[1];
      expect(settleTx).toBeDefined();

      const { runnerPay, fee, tip } = splitPrice(claim.price);
      const after = await orderOf(id);
      expect(after.state).toBe(ORDER_STATE.Delivered);
      expect(after.proven).toBe(true);
      expect((await claimOf(id)).recordHash).toBe(hash);
      expect(keccak256(bytes)).toBe(hash);
      // The runner: the price less the fee and the tip, and its bond back.
      expect(await balance(CAST.runner.address)).toBe(before.runner - IMD("0.5") + runnerPay);
      // The employer: the escrow above the fixed price, back in the same transaction. (Its balance
      // was read after it escrowed the top price of 4 IMD.)
      expect(await balance(CAST.employer.address)).toBe(before.employer + IMD("4") - claim.price);
      expect(await accountOf(id)).toMatchObject({
        escrow: 0n,
        spent: claim.price,
        returned: IMD("4") - claim.price,
      });
      // The real Payroll took the fee and the tip, and credited the tip to the agent that worked.
      expect(await balance(co.payroll)).toBe(before.payroll + fee + tip);
      const booked = await ledger();
      expect(booked.received).toBe(before.ledger.received + fee);
      expect(booked.tipsIn).toBe(before.ledger.tipsIn + tip);
      expect(booked.tipsToSeats).toBe(before.ledger.tipsToSeats);
      expect(await read(co.payroll, ABI.payroll, "tipOwed", [52715n])).toBe(tip);
      // Nothing fell back to a plain transfer, and the desk holds nothing for the order.
      expect(await eventsOf(settleTx as Hex, DESK_ABI, "PayrollFallback")).toEqual([]);
      const delivered = await eventsOf(settleTx as Hex, DESK_ABI, "Delivered");
      expect(delivered[0]).toMatchObject({ id, runnerPay, fee, tip, proven: true, agentIds: [52715n] });
      // A settlement uses far less gas than it must be offered.
      const receipt = await node.public.getTransactionReceipt({ hash: settleTx as Hex });
      expect(receipt.gasUsed).toBeLessThan(1_300_000n);
      const tx = await node.public.getTransaction({ hash: settleTx as Hex });
      expect(tx.gas).toBeGreaterThan(1_300_000n);
      expect(tx.gas).toBeLessThanOrEqual(3_000_000n);
      if (process.env.HW_PRINT_GAS) {
        console.log(
          `gas settle:order ${id} used ${receipt.gasUsed} of a limit of ${tx.gas}, record ${bytes.length} bytes`,
        );
      }
    });

    // -------------------------------------------------------------------------------------------
    // 2. The claimed path, while receipts are stalled
    // -------------------------------------------------------------------------------------------

    let stalledReceiptOnly = 0n;
    it("2. with receipts stalled: delivery is claimed, checked, finalized, and later stamped", async () => {
      const SPEC = "Write a short sourced note on how the swarm's receipts reach the WorkRegistry.";
      // An hour with no receipt written: more than the fifty blocks the bots count as stalled.
      await warpTo((await node.latest()).timestamp + HOUR);
      await node.mine(60);

      // An order only a receipt can pay is not taken now.
      stalledReceiptOnly = await openOrder("Summarise the last day of the registry.", {
        flags: 0,
        lifetime: 3n * HOUR,
      });
      const id = await openOrder(SPEC);
      const before = {
        runner: await balance(CAST.runner.address),
        employer: await balance(CAST.employer.address),
        payroll: await balance(co.payroll),
        ledger: await ledger(),
      };
      const { jobId, hash } = await takeToRegistered(id);
      expect(runnerOrder(stalledReceiptOnly)?.status).toBe("seen");
      expect(runnerOrder(stalledReceiptOnly)?.skip?.reason).toContain(
        "has written no receipt in the last 50 blocks",
      );
      expect((await orderOf(stalledReceiptOnly)).state).toBe(ORDER_STATE.Open);

      // No receipt on chain: the runner claims delivery with the hash the API lists.
      await tick();
      expect(runnerOrder(id)?.status, runnerLines.join("\n")).toBe("asserted");
      expect((await orderOf(id)).state).toBe(ORDER_STATE.Asserted);
      const asserted = await claimOf(id);
      expect(asserted.recordHash).toBe(hash);
      expect(await read(co.registry, ABIS.registry, "latest", [uuidToBytes16(jobId)])).toBe(ZERO_HASH);

      // The keeper checks the claim against the API and leaves it: it is true.
      const challenging = { CHALLENGE_FLOAT_IMD: "1", CHALLENGE_DAILY_CAP_IMD: "1" };
      const looked = await pass(challenging);
      expect(sentFor(looked, `order ${id}`)).toEqual([]);
      const judged = claimsOf(looked).find((c) => c.order === id.toString());
      expect(judged).toMatchObject({ verdict: "true", action: "none" });
      expect(judged?.why).toContain("passed the check");
      expect((await orderOf(id)).state).toBe(ORDER_STATE.Asserted);
      expect(await balance(WHO.keeper.address)).toBe(IMD("100"));

      // One block before the challenge window ends nothing can be finalized. The receipt-only
      // order nobody took has expired by now, and the keeper returns its escrow.
      const windowEnds = BigInt(asserted.assertedAt) + DAY;
      await warpTo(windowEnds - 13n);
      const early = await pass(challenging);
      expect(sentFor(early, `order ${id}`)).toEqual([]);
      expect(sentFor(early, `order ${stalledReceiptOnly}`)).toEqual(["refund"]);
      // The window passes; the keeper finalizes.
      await warpTo(windowEnds);
      const finalized = await pass(challenging);
      expect(sentFor(finalized, `order ${id}`)).toEqual(["finalize"]);
      expect(failed(finalized)).toEqual([]);

      const { runnerPay, fee, tip } = splitPrice(IMD("3"));
      const paid = await orderOf(id);
      expect(paid.state).toBe(ORDER_STATE.Delivered);
      expect(paid.proven).toBe(false);
      expect(await balance(CAST.runner.address)).toBe(before.runner - IMD("0.5") + runnerPay);
      // Two orders were escrowed before the balance was read: one was paid at its full price, the
      // other refunded in full.
      expect(await balance(CAST.employer.address)).toBe(before.employer + IMD("3"));
      expect((await accountOf(stalledReceiptOnly)).state).toBe(ORDER_STATE.Refunded);
      expect(await balance(co.payroll)).toBe(before.payroll + fee + tip);
      // No record was read, so the tip names no agent and goes to the seat pool.
      const booked = await ledger();
      expect(booked.tipsIn).toBe(before.ledger.tipsIn + tip);
      expect(booked.tipsToSeats).toBe(before.ledger.tipsToSeats + tip);

      // The runner sees it was paid on the claim, and goes on watching for the receipt.
      await tick();
      expect(runnerOrder(id)?.status).toBe("unproven");

      // Days later the receipt lands. The keeper stamps the order: an event and a flag, no money.
      await warpTo((await node.latest()).timestamp + 2n * DAY);
      await plane.writeReceipt(jobId);
      const balances = [
        await balance(CAST.runner.address),
        await balance(CAST.employer.address),
        await balance(co.payroll),
        await balance(co.workOrders),
      ];
      const stamped = await pass(challenging);
      expect(sentFor(stamped, `order ${id}`)).toEqual(["stamp"]);
      expect((await orderOf(id)).proven).toBe(true);
      expect((await claimOf(id)).recordHash).toBe(hash);
      expect(await read(co.workOrders, DESK_ABI, "orderOfJob", [uuidToBytes16(jobId)])).toBe(id);
      expect([
        await balance(CAST.runner.address),
        await balance(CAST.employer.address),
        await balance(co.payroll),
        await balance(co.workOrders),
      ]).toEqual(balances);
      // The runner finds it proven on its next look and is done with it.
      await warpTo((await node.latest()).timestamp + 700n);
      await tick();
      expect(runnerOrder(id)?.status).toBe("delivered");
      expect(runnerOrder(id)?.outcome).toContain("matched to its receipt on chain");
    });

    // -------------------------------------------------------------------------------------------
    // 3. An untrue delivery claim
    // -------------------------------------------------------------------------------------------

    it("3. an untrue delivery claim is challenged, and with no receipt the employer is refunded", async () => {
      const SPEC = "Write a sourced page on the three largest employers of the swarm this month.";
      const id = await openOrder(SPEC);
      const before = {
        employer: await balance(CAST.employer.address),
        rogue: await balance(CAST.rogue.address),
        keeper: await balance(WHO.keeper.address),
      };
      // A runner that misreports takes the order, opens the right job, and names a record hash
      // IdentityMD does not list for it.
      await approve(node, co, CAST.rogue, co.workOrders, IMD("0.25"));
      await send(node, CAST.rogue, co.workOrders, DESK_ABI, "claim", [id]);
      const header = Buffer.from(
        ((await read(co.workOrders, DESK_ABI, "headerOf", [id])) as Hex).slice(2),
        "hex",
      ).toString("utf8");
      const job = plane.openJob({ objective: header + SPEC, template: REPORT, paidBy: CAST.rogue.address });
      plane.finishJob(job.id);
      await send(node, CAST.rogue, co.workOrders, DESK_ABI, "register", [id, uuidToBytes16(job.id)]);
      const named = keccak256(stringToHex("a record nobody wrote"));
      await send(node, CAST.rogue, co.workOrders, DESK_ABI, "claimDelivered", [id, named]);
      const claim = await claimOf(id);
      expect((await orderOf(id)).state).toBe(ORDER_STATE.Asserted);

      // With challenges off the keeper only reports what it found.
      const reported = await pass();
      expect(sentFor(reported, `order ${id}`)).toEqual([]);
      expect(claimsOf(reported).find((c) => c.order === id.toString())).toMatchObject({
        verdict: "untrue",
        action: "none",
      });
      expect(reported.attention.some((a) => a.includes("challenges are off"))).toBe(true);

      // With a float and a daily cap it still waits for a second look some minutes after the first.
      const challenging = {
        CHALLENGE_FLOAT_IMD: "1",
        CHALLENGE_DAILY_CAP_IMD: "1",
        CHALLENGE_CONFIRM_SECONDS: "600",
      };
      const first = await pass(challenging);
      expect(sentFor(first, `order ${id}`)).toEqual([]);
      expect(claimsOf(first).find((c) => c.order === id.toString())?.why).toContain("if it still fails");

      await warpTo((await node.latest()).timestamp + 700n);
      const second = await pass(challenging);
      expect(sentFor(second, `order ${id}`)).toEqual(["approve", "challenge"]);
      const challenge = second.done.find((r) => r.kind === "challenge");
      expect(challenge?.reason).toContain("is not one IdentityMD lists");
      expect(challenge?.reason).toContain("No receipt is on chain");
      // The status file's last look shows the claim as disputed, by this keeper.
      expect(claimsOf(second).find((c) => c.order === id.toString())?.why).toContain(
        `challenged by ${WHO.keeper.address}`,
      );
      expect((await orderOf(id)).state).toBe(ORDER_STATE.Disputed);
      expect((await claimOf(id)).challenger).toBe(WHO.keeper.address);
      expect(await balance(WHO.keeper.address)).toBe(before.keeper - IMD("0.25"));
      // The desk holds the escrow and both bonds.
      expect((await accountOf(id)).escrow).toBe(IMD("3"));

      // The same day a second untrue claim would exceed neither limit; the ledger shows the first.
      // The keeper's own record of the claim: what it found, what it did, and the day's bonds.
      const state = JSON.parse(readFileSync(join(dir, "keeper.json"), "utf8")) as {
        challenges: Record<string, string>;
        claims: Record<string, { verdict: string; reasons: string[]; did?: string; tx?: string }>;
      };
      expect(Object.values(state.challenges)).toEqual([IMD("0.25").toString()]);
      expect(state.claims[`${id}:1`]).toMatchObject({ verdict: "untrue", did: "challenge" });
      expect(state.claims[`${id}:1`]?.reasons.join(" ")).toContain("is not one IdentityMD lists");
      expect(state.claims[`${id}:1`]?.tx).toMatch(/^0x[0-9a-f]{64}$/);
      // The verdict of the status file is still the one that was found, now that nobody asks the API.
      expect(claimsOf(second).find((c) => c.order === id.toString())).toMatchObject({ verdict: "untrue" });

      // No receipt ever lands. One block before the delivery deadline nothing can end the dispute.
      const deadline = BigInt(claim.registeredAt) + 3n * DAY;
      await warpTo(deadline - 13n);
      expect(sentFor(await pass(challenging), `order ${id}`)).toEqual([]);
      await warpTo(deadline);
      const ended = await pass(challenging);
      expect(sentFor(ended, `order ${id}`)).toEqual(["timeout"]);

      // The employer is refunded with a tenth of the rogue's bond on top; the keeper has its bond
      // back; the rogue keeps nine tenths of its own.
      const cut = releaseCut(IMD("0.25"));
      expect((await orderOf(id)).state).toBe(ORDER_STATE.Refunded);
      // (The employer's balance was read after it escrowed the 3 IMD.)
      expect(await balance(CAST.employer.address)).toBe(before.employer + IMD("3") + cut);
      expect(await accountOf(id)).toMatchObject({ escrow: 0n, spent: 0n, returned: IMD("3") + cut });
      expect(await balance(WHO.keeper.address)).toBe(before.keeper);
      expect(await balance(CAST.rogue.address)).toBe(before.rogue - cut);
      expect(await balance(co.workOrders)).toBe(0n);
    });

    // -------------------------------------------------------------------------------------------
    // 4. Crowd pots
    // -------------------------------------------------------------------------------------------

    const POT_SPEC = "Write a two-page plain-language report on who paid the swarm in the last seven days.";
    const potTerms = {
      kind: REPORT,
      target: IMD("5"),
      minPay: IMD("3"),
      rampSecs: 86_400,
      bond: IMD("0.25"),
      deliverySecs: 3 * 86_400,
      hireSecs: 86_400,
      fundSecs: 3_600,
      allowClaimed: true,
    };
    const potOf = async (potId: bigint) =>
      (await read(co.crowdPots, ABIS.crowdPots, "potOf", [potId])) as {
        stage: number;
        orderId: bigint;
        raised: bigint;
        pool: bigint;
        jobId: Hex;
      };

    it("4a. a full crowd pot is launched by the keeper, delivered, and its change shared pro rata", async () => {
      // Alice opens the pot with 3 IMD; Bob brings it to its target of 5.
      await approve(node, co, CAST.alice, co.crowdPots, IMD("3"));
      await send(node, CAST.alice, co.crowdPots, ABIS.crowdPots, "openPot", [
        potTerms,
        stringToHex(POT_SPEC),
        IMD("3"),
      ]);
      const potId = (await read(co.crowdPots, ABIS.crowdPots, "potCount")) as bigint;
      await approve(node, co, CAST.bob, co.crowdPots, IMD("2"));
      await send(node, CAST.bob, co.crowdPots, ABIS.crowdPots, "chipIn", [potId, IMD("2")]);
      expect((await potOf(potId)).raised).toBe(IMD("5"));
      const before = { alice: await balance(CAST.alice.address), bob: await balance(CAST.bob.address) };

      // The keeper launches it with the spec it read from the pot's SpecPinned log.
      const keeperImd = await balance(WHO.keeper.address);
      const launched = await pass();
      expect(sentFor(launched, `pot ${potId}`)).toEqual(["launch"]);
      const pot = await potOf(potId);
      expect(pot.stage).toBe(2); // Hiring
      const id = pot.orderId;
      expect(await accountOf(id)).toMatchObject({ employer: co.crowdPots, escrow: IMD("5") });
      // Launching cost the keeper gas and no IMD.
      expect(await balance(WHO.keeper.address)).toBe(keeperImd);

      // The runner takes the pot's order like any other, and claims delivery.
      const { jobId } = await takeToRegistered(id);
      const price = (await claimOf(id)).price;
      expect(price).toBeGreaterThan(IMD("3"));
      await tick();
      expect((await orderOf(id)).state).toBe(ORDER_STATE.Asserted);
      const asserted = await claimOf(id);
      // The keeper checks the claim, waits out the window, and finalizes.
      expect(claimsOf(await pass()).find((c) => c.order === id.toString())?.verdict).toBe("true");
      await warpTo(BigInt(asserted.assertedAt) + DAY);
      const finalized = await pass();
      expect(sentFor(finalized, `order ${id}`)).toEqual(["finalize"]);
      // The desk told the pot, and the keeper paid the contributors their change in the same pass.
      expect(sentFor(finalized, `pot ${potId}`)).toEqual(["claimRefunds"]);
      const settled = await potOf(potId);
      expect(settled.stage).toBe(3); // Delivered
      expect(settled.jobId).toBe(uuidToBytes16(jobId));
      expect(settled.pool).toBe(0n);
      // What the price left of the 5 IMD, shared 3 to 2; the last claimer takes the remainder.
      const change = IMD("5") - price;
      const aliceShare = (change * 3n) / 5n;
      expect(await balance(CAST.alice.address)).toBe(before.alice + aliceShare);
      expect(await balance(CAST.bob.address)).toBe(before.bob + (change - aliceShare));
      expect(await balance(co.crowdPots)).toBe(0n);
    });

    it("4b. a second pot whose order is never delivered is refunded pro rata, forfeited bond included", async () => {
      await approve(node, co, CAST.bob, co.crowdPots, IMD("2"));
      await send(node, CAST.bob, co.crowdPots, ABIS.crowdPots, "openPot", [
        potTerms,
        stringToHex(POT_SPEC),
        IMD("2"),
      ]);
      const potId = (await read(co.crowdPots, ABIS.crowdPots, "potCount")) as bigint;
      await approve(node, co, CAST.alice, co.crowdPots, IMD("3"));
      await send(node, CAST.alice, co.crowdPots, ABIS.crowdPots, "chipIn", [potId, IMD("3")]);
      const before = { alice: await balance(CAST.alice.address), bob: await balance(CAST.bob.address) };
      expect(sentFor(await pass(), `pot ${potId}`)).toEqual(["launch"]);
      const id = (await potOf(potId)).orderId;

      // A runner takes the pot's order and registers nothing.
      await approve(node, co, CAST.rogue, co.workOrders, IMD("0.25"));
      await send(node, CAST.rogue, co.workOrders, DESK_ABI, "claim", [id]);
      const claimedAt = BigInt((await claimOf(id)).claimedAt);
      // One block before the claim window ends the keeper leaves it; at its end it evicts.
      await warpTo(claimedAt + HOUR - 13n);
      expect(sentFor(await pass(), `order ${id}`)).toEqual([]);
      await warpTo(claimedAt + HOUR);
      expect(sentFor(await pass(), `order ${id}`)).toEqual(["evict"]);
      // The bond went to the pot, as the order's employer, and the order is open again.
      expect(await accountOf(id)).toMatchObject({ state: ORDER_STATE.Open, returned: IMD("0.25") });

      // Nobody else takes it. A day after the launch it expires; the keeper refunds it on the
      // desk and pays the pot's contributors in the same pass.
      const expiresAt = BigInt((await orderOf(id)).expiresAt);
      await warpTo(expiresAt);
      const ended = await pass();
      expect(sentFor(ended, `order ${id}`)).toEqual(["refund"]);
      expect(sentFor(ended, `pot ${potId}`)).toEqual(["claimRefunds"]);
      expect(await accountOf(id)).toMatchObject({ state: ORDER_STATE.Refunded, returned: IMD("5.25") });
      // 5.25 IMD shared 3 to 2: 3.15 and 2.10.
      expect(await balance(CAST.alice.address)).toBe(before.alice + IMD("3.15"));
      expect(await balance(CAST.bob.address)).toBe(before.bob + IMD("2.1"));
      expect((await potOf(potId)).stage).toBe(4); // Refundable
      expect(await balance(co.crowdPots)).toBe(0n);
      expect(await balance(co.workOrders)).toBe(0n);
    });

    // -------------------------------------------------------------------------------------------
    // 5. A rule
    // -------------------------------------------------------------------------------------------

    it("5. a rule whose view condition becomes true is fired by the keeper and hires through the desk", async () => {
      const SPEC = "Write a two-page report on what moved the gauge past its line, with sources.";
      // WHEN gauge.level() >= 100, THEN hire a report for 2 to 3 IMD. The tip is 0.05 IMD.
      await approve(node, co, CAST.creator, co.rules, IMD("3.05"));
      await send(node, CAST.creator, co.rules, ABIS.rules, "createRule", [
        {
          when: {
            kind: 1,
            cmp: 1,
            maxAge: 0,
            target: co.gauge,
            threshold: 100n,
            feedId: ZERO_HASH,
            data: toFunctionSelector("level()"),
          },
          action: 1,
          hire: {
            kindHash: kindHash(REPORT),
            minPay: IMD("2"),
            maxPay: IMD("3"),
            rampSecs: 86_400,
            deliverySecs: 3 * 86_400,
            bond: IMD("0.25"),
            runnerOnly: ZERO,
            arbiter: ZERO,
            // The claimed path, and no callback: the change comes back through `reconcile`.
            flags: ORDER_FLAG.ALLOW_CLAIMED,
            orderTtl: 7 * 86_400,
          },
          pay: { recipient: ZERO, amount: 0n },
          tip: IMD("0.05"),
          cooldown: 0,
          maxFires: 1,
        },
        stringToHex(SPEC),
        IMD("3.05"),
      ]);
      const ruleId = (await read(co.rules, ABIS.rules, "ruleCount")) as bigint;
      const escrowOf = async () =>
        ((await read(co.rules, ABIS.rules, "getRule", [ruleId])) as { escrow: bigint }).escrow;

      // The line is not crossed: nothing fires.
      expect(sentFor(await pass({ RULES_HOUSE: ruleId.toString() }), `rule ${ruleId}`)).toEqual([]);
      await send(node, CAST.creator, co.gauge, ABIS.gauge, "set", [150n]);
      expect(await read(co.rules, ABIS.rules, "canFire", [ruleId])).toBe(true);
      // Not a house rule, and no rate to hold its tip against the gas: not fired.
      const unpriced = await pass();
      expect(sentFor(unpriced, `rule ${ruleId}`)).toEqual([]);
      expect(
        unpriced.waiting.some(
          (w) => w.subject === `rule ${ruleId}` && w.reason.includes("RULES_IMD_PER_ETH"),
        ),
      ).toBe(true);
      // At a rate where the gas of a fire is worth far more than the tip: not fired.
      const dear = await pass({ RULES_IMD_PER_ETH: "1000000000" });
      expect(sentFor(dear, `rule ${ruleId}`)).toEqual([]);
      expect(dear.waiting.some((w) => w.reason.includes("does not cover the gas"))).toBe(true);

      // On the house list it is always fired. The keeper is paid the tip.
      const keeperImd = await balance(WHO.keeper.address);
      const orders = await orderCount();
      const fired = await pass({ RULES_HOUSE: ruleId.toString() });
      expect(sentFor(fired, `rule ${ruleId}`)).toEqual(["fire"]);
      expect(await balance(WHO.keeper.address)).toBe(keeperImd + IMD("0.05"));
      const id = orders + 1n;
      expect(await orderCount()).toBe(id);
      expect(await accountOf(id)).toMatchObject({
        employer: co.rules,
        escrow: IMD("3"),
        state: ORDER_STATE.Open,
      });
      expect(await escrowOf()).toBe(0n);
      expect(await read(co.rules, ABIS.rules, "statusOf", [ruleId])).toBe(2); // Exhausted

      // The order is an ordinary order: the runner takes it and is paid on its claim.
      await takeToRegistered(id);
      const price = (await claimOf(id)).price;
      await tick();
      const asserted = await claimOf(id);
      await warpTo(BigInt(asserted.assertedAt) + DAY);
      const finalized = await pass({ RULES_HOUSE: ruleId.toString() });
      expect(sentFor(finalized, `order ${id}`)).toEqual(["finalize"]);
      // The order has ended and returned its change: the keeper hands it back to the rule.
      expect(sentFor(finalized, `rule ${ruleId} order ${id}`)).toEqual(["reconcile"]);
      expect(await escrowOf()).toBe(IMD("3") - price);
      const [linked, sentToDesk, credited] = (await read(co.rules, ABIS.rules, "orderOf", [id])) as [
        bigint,
        bigint,
        bigint,
      ];
      expect([linked, sentToDesk, credited]).toEqual([ruleId, IMD("3"), IMD("3") - price]);
      // Nothing more to do for it on the next pass.
      expect(sent(await pass({ RULES_HOUSE: ruleId.toString() })).filter((s) => s.includes("rule"))).toEqual(
        [],
      );
    });

    // -------------------------------------------------------------------------------------------
    // 6. An order with a condition on a Standing Question's answer
    // -------------------------------------------------------------------------------------------

    it("6. an order waits for a Standing Question's answer to cross a line, then becomes takeable", async () => {
      const hires = HOUSE_FEEDS.hires;
      const QUESTIONS = questionsAbi as unknown as Abi;
      // The hires feed, created and funded as on launch A's first day.
      await send(node, WHO.deployer, co.questions, QUESTIONS, "createFeed", [
        hires.params,
        hires.qPrefix,
        hires.tail,
      ]);
      await approve(node, co, CAST.depositor, co.questions, IMD("10"));
      await send(node, CAST.depositor, co.questions, QUESTIONS, "fund", [hires.id, IMD("10")]);
      const questionsOnly = { MODULES: "questions", FEEDS: "hires", TIP_COLLECT_MIN_IMD: "100" };
      const feedState = async () =>
        (await read(co.questions, QUESTIONS, "feedState", [hires.id])) as {
          rounds: bigint;
          pending: boolean;
        };
      const requestTx = async (round: bigint): Promise<Hex> => {
        const logs = await node.public.getLogs({
          address: co.questions,
          event: getAbiItem({ abi: questionsAbi, name: "RoundOpened" }),
          args: { feedId: hires.id, round },
          fromBlock: 0n,
        });
        return logs[0]?.transactionHash as Hex;
      };
      const tips = async (who: Address) =>
        (await read(co.questions, QUESTIONS, "tipsOf", [who])) as readonly [bigint, bigint];

      // WHEN the day's hires reach 1,000, THEN hire a report: `latest(feedId)` at least 1,000.
      const SPEC = "Write a one-page report on the day the swarm was hired a thousand times.";
      const id = await openOrder(SPEC, {
        flags: ORDER_FLAG.ALLOW_CLAIMED | ORDER_FLAG.COND_ARG,
        condTarget: co.questions,
        condSelector: toFunctionSelector("latest(bytes32)"),
        condArg: hires.id,
        condCmp: 1,
        condThreshold: 1_000n,
        lifetime: 30n * DAY,
      });
      expect(await read(co.workOrders, DESK_ABI, "conditionOf", [id])).toEqual([false, false, 0n]);

      // The first answer is under the line. The keeper asks; the Intake's writer delivers.
      const asked = await pass(questionsOnly);
      expect(sent(asked)).toEqual(["request:hires"]);
      const [first] = await plane.see(await requestTx(1n));
      await plane.attest(first as Hex, { type: "uint256", value: 400n });
      expect(await plane.complete(first as Hex)).toBe(true);
      expect(((await read(co.questions, QUESTIONS, "latest", [hires.id])) as bigint[])[0]).toBe(400n);
      // Neither bot touches the order: its condition does not hold.
      expect(sentFor(await pass(), `order ${id}`)).toEqual([]);
      await tick();
      expect(runnerOrder(id)?.skip?.reason).toBe("its condition does not hold yet");
      expect((await orderOf(id)).state).toBe(ORDER_STATE.Open);
      expect((await orderOf(id)).condMet).toBe(false);

      // A day later the keeper asks again, and this time the writer is late: somebody else hands
      // the signed answer in after thirty minutes. The tip is the opener's, not the submitter's.
      await node.mine(7_000);
      const keeperTips = await tips(WHO.keeper.address);
      expect(sent(await pass(questionsOnly))).toEqual(["request:hires"]);
      expect((await feedState()).rounds).toBe(2n);
      const [second] = await plane.see(await requestTx(2n));
      await plane.attest(second as Hex, { type: "uint256", value: 1_400n });
      const requestedAt = (
        (await read(co.questions, QUESTIONS, "roundRequest", [hires.id, 2n])) as readonly unknown[]
      )[3] as bigint;
      await warpTo(requestedAt + 1_800n);
      const entry = plane.entry(second as Hex);
      await send(node, WHO.other, co.questions, QUESTIONS, "submit", [
        hires.id,
        entry.attestation?.message,
        entry.attestation?.signature,
      ]);
      expect(((await read(co.questions, QUESTIONS, "latest", [hires.id])) as bigint[])[0]).toBe(1_400n);
      expect(await tips(WHO.other.address)).toEqual([0n, 0n]);
      expect((await tips(WHO.keeper.address))[0]).toBe(keeperTips[0] + IMD("0.05"));

      // The line is crossed. The keeper latches the order's condition, which starts it for good.
      expect(await read(co.workOrders, DESK_ABI, "conditionOf", [id])).toEqual([false, true, 1_400n]);
      const latched = await pass();
      expect(sentFor(latched, `order ${id}`)).toEqual(["trigger"]);
      expect((await orderOf(id)).condMet).toBe(true);
      // And the runner takes it.
      await tick();
      expect(runnerOrder(id)?.status, runnerLines.join("\n")).toBe("claimed");
      expect((await orderOf(id)).state).toBe(ORDER_STATE.Claimed);
      expect((await claimOf(id)).runner).toBe(CAST.runner.address);
      // It gives the order back inside the hour rather than leave a claim behind: a tenth of the bond.
      const held = await balance(CAST.runner.address);
      await send(node, CAST.runner, co.workOrders, DESK_ABI, "release", [id]);
      expect(await balance(CAST.runner.address)).toBe(held + IMD("0.25") - releaseCut(IMD("0.25")));
    });

    // -------------------------------------------------------------------------------------------
    // The Doorbell and the endowments
    // -------------------------------------------------------------------------------------------

    it("reports the Doorbell's state and never rings it", async () => {
      await mint(node, co, co.doorbell, IMD("3"));
      for (let i = 0; i < 25; i++) await send(node, CAST.alice, co.doorbell, ABIS.doorbell, "ring", []);
      const id = (await read(co.doorbell, ABIS.doorbell, "lastOrderId")) as bigint;
      expect(await accountOf(id)).toMatchObject({ employer: co.doorbell, escrow: IMD("3") });
      const status = await pass();
      expect(await read(co.doorbell, ABIS.doorbell, "rings")).toBe(25n);
      expect(sent(status).filter((s) => s.includes("doorbell"))).toEqual([]);
      expect(status.modules.doorbell).toMatchObject({
        rings: "25",
        hires: "1",
        receipts: "0",
        ringsUntilHire: "25",
        funded: false,
        allowClaimed: true,
        lastOrderId: id.toString(),
        lastOrderState: "Open",
      });
      expect(status.checked.some((line) => line.startsWith("doorbell: 25 rings, 1 hires"))).toBe(true);
      // The Doorbell orders a picture: a runner set to write reports leaves it.
      await tick();
      expect(runnerOrder(id)?.status).toBe("skipped");
      expect(runnerOrder(id)?.skip?.reason).toContain(
        "its kind (skill:create-image) is not on this runner's allow-list",
      );
      // Its operator adds pictures to the allow-list: the order is looked at again, and taken.
      const drawing = { TEMPLATES: "skill:research-report,skill:create-image" };
      await tick(drawing);
      expect(runnerOrder(id)?.status, runnerLines.join("\n")).toBe("claimed");
      expect((await claimOf(id)).runner).toBe(CAST.runner.address);
      await tick(drawing);
      const jobId = runnerOrder(id)?.jobId as string;
      // The job it bought is a picture job, with the Doorbell's own spec after the header.
      expect(plane.job(jobId).template).toBe("skill:create-image");
      expect(plane.job(jobId).objective.slice(85)).toBe(await read(co.doorbell, ABIS.doorbell, "SPEC"));
    });

    it("stakes an endowment's buffer when the gap has passed, and harvests its yield into the meter", async () => {
      const hires = HOUSE_FEEDS.hires;
      const QUESTIONS = questionsAbi as unknown as Abi;
      // An endowment whose yield tops up the hires meter, with 100 IMD of principal.
      await approve(node, co, CAST.depositor, co.endowments, IMD("150"));
      await send(node, CAST.depositor, co.endowments, ABIS.endowments, "createForMeter", [hires.id]);
      const id = (await read(co.endowments, ABIS.endowments, "endowmentCount")) as bigint;
      await send(node, CAST.depositor, co.endowments, ABIS.endowments, "deposit", [id, IMD("100")]);
      expect(await read(co.endowments, ABIS.endowments, "pendingTotal")).toBeGreaterThan(IMD("100"));

      const keeperImd = await balance(WHO.keeper.address);
      const staked = await pass({ MODULES: "endowments" });
      expect(sent(staked)).toEqual(["stake:stake"]);
      expect(await read(co.endowments, ABIS.endowments, "pendingTotal")).toBe(0n);
      // The gap: the next stake is fifty blocks away, and nothing is harvestable yet.
      await send(node, CAST.depositor, co.endowments, ABIS.endowments, "deposit", [id, IMD("1")]);
      const waiting = await pass({ MODULES: "endowments" });
      expect(sent(waiting)).toEqual([]);
      expect(waiting.waiting.some((w) => w.subject === "stake" && w.reason.includes("from block"))).toBe(
        true,
      );

      // Yield arrives in the vault (a plain transfer pays every staker), and the meter has room.
      await mint(node, co, co.simd, IMD("30"));
      const harvestable = (await read(co.endowments, ABIS.endowments, "harvestable", [id])) as bigint;
      expect(harvestable).toBeGreaterThan(IMD("0.5"));
      const [meterBefore] = (await read(co.questions, QUESTIONS, "meterOf", [hires.id])) as [bigint, bigint];
      await node.mine(50);
      const harvested = await pass({ MODULES: "endowments" });
      expect(sent(harvested)).toEqual(["harvest:endowment 1", "stake:stake"]);
      const [meterAfter] = (await read(co.questions, QUESTIONS, "meterOf", [hires.id])) as [bigint, bigint];
      expect(meterAfter - meterBefore).toBe(harvestable);
      // The principal is untouched, and none of this spent the keeper's IMD.
      expect(await read(co.endowments, ABIS.endowments, "principalOf", [id, CAST.depositor.address])).toBe(
        IMD("101"),
      );
      expect(await balance(WHO.keeper.address)).toBe(keeperImd);
    });

    it("leaves a status file that says what each module saw and did", async () => {
      const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as StatusFile;
      expect(status.modules.enabled).toEqual(["endowments"]);
      const whole = await pass();
      expect(whole.modules.enabled).toEqual(["desk", "pots", "doorbell", "rules", "endowments"]);
      expect(whole.modules.later).toEqual({});
      for (const name of ["desk", "pots", "doorbell", "rules", "endowments"] as const) {
        expect(whole.modules[name], name).toBeDefined();
        expect(
          whole.checked.some((line) => line.startsWith(`${name}:`)),
          name,
        ).toBe(true);
      }
      expect(whole.errors).toEqual([]);
      expect(bytes16ToUuid(uuidToBytes16("8d2f6c1e-4b3a-4f5d-9c7e-1a2b3c4d5e6f"))).toBe(
        "8d2f6c1e-4b3a-4f5d-9c7e-1a2b3c4d5e6f",
      );
    });
  },
);

// When the test cannot run, say why once, instead of a silent row of skips.
if (reason !== null) {
  it(`the joint integration test is skipped: ${reason}`, (ctx) => {
    ctx.skip(reason);
  });
}
