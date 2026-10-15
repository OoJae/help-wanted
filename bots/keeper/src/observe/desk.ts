/**
 * Reads everything `decideDesk` needs: every order on the desk that can still change, at one
 * block, and, for the orders that name a job, what the WorkRegistry and IdentityMD's API say about
 * it. Sends nothing.
 *
 * The API is asked as little as possible, because it is rate limited and shared:
 * - a work record is fetched only when the registry holds a receipt for the job, by the hash the
 *   registry holds, and kept for the life of the process;
 * - a job and its list of records are read only for a delivery claim that nobody has challenged
 *   yet, that has no receipt on chain, and that was not already found true.
 */
import { getAbiItem, hexToBytes, type Abi, type AbiEvent, type Address, type Hex } from "viem";
import {
  ORDER_STATE,
  bytes16ToUuid,
  erc20Abi,
  isNotFound,
  judgeRecord,
  recordToHex,
  workProofAbi,
  workRegistryAbi,
} from "@help-wanted/shared";
import {
  DESK_ABI,
  judgeClaim,
  type ClaimEvidence,
  type DeskOrderView,
  type DeskSnapshot,
  type ReceiptView,
} from "../modules/desk.js";
import { challengedOn, claimKey, isDone, markDone, utcDay } from "../store.js";
import { messageOf, readAt, readOnce, type ObserveContext } from "./common.js";
import { big, num } from "./questions.js";

const ERC20_ABI = erc20Abi as unknown as Abi;
const PROOF_ABI = workProofAbi as unknown as Abi;
const REGISTRY_ABI = workRegistryAbi as unknown as Abi;
const WORK_RECORDED = getAbiItem({ abi: workRegistryAbi, name: "WorkRecorded" }) as AbiEvent;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = `0x${"00".repeat(32)}`;
const ZERO_JOB = `0x${"00".repeat(16)}`;

export interface DeskTargets {
  workOrders: Address;
  /** The most orders read in one pass. */
  maxOrders: number;
  /** Receipts count as stalled when the registry wrote none in this many blocks. */
  receiptStallBlocks: number;
  /** How long an order paid on a claim is watched for its receipt, in seconds. */
  stampWatchSeconds: number;
}

interface OrderStruct {
  employer: Address;
  expiresAt: unknown;
  state: unknown;
  flags: unknown;
  kindHash: Hex;
  specHash: Hex;
  deliverySecs: unknown;
  bond: unknown;
  arbiter: Address;
  condTarget: Address;
  condMet: boolean;
  proven: boolean;
  seq: unknown;
}

interface ClaimStruct {
  runner: Address;
  claimedAt: unknown;
  registeredAt: unknown;
  jobId: Hex;
  challenger: Address;
  assertedAt: unknown;
  recordHash: Hex;
}

/** The record the registry's hash names, read as the desk would read it. Kept once read. */
async function readReceipt(
  ctx: ObserveContext,
  registry: Address,
  order: Pick<DeskOrderView, "kindHash" | "specHash" | "ticket">,
  jobId: string,
  jobBytes16: Hex,
): Promise<ReceiptView> {
  const hash = (
    (await readAt(ctx, registry, REGISTRY_ABI, "latest", [jobBytes16])) as Hex
  ).toLowerCase() as Hex;
  if (hash === ZERO_HASH) return { kind: "none" };
  const key = `record:${hash}`;
  let record = ctx.cache.values.get(key) as Hex | undefined;
  if (record === undefined) {
    try {
      record = recordToHex((await ctx.api.workRecord(hash)).bytes);
      ctx.cache.values.set(key, record);
    } catch (error) {
      return { kind: "unread", hash, detail: messageOf(error) };
    }
  }
  const bytes = hexToBytes(record);
  const verdict = judgeRecord(
    { jobId, ticket: order.ticket, specHash: order.specHash, kindHash: order.kindHash },
    bytes,
  );
  return { kind: "read", hash, record, bytes: bytes.length, verdict };
}

/** What IdentityMD's API says about the job a delivery claim names. */
async function readEvidence(ctx: ObserveContext, jobId: string): Promise<ClaimEvidence> {
  let job: ClaimEvidence["job"];
  try {
    const read = await ctx.api.job(jobId);
    job = { kind: "read", state: read.state, template: read.template, objective: read.objective };
  } catch (error) {
    job = isNotFound(error) ? { kind: "missing" } : { kind: "unreadable", detail: messageOf(error) };
  }
  if (job.kind === "missing") return { job, records: { kind: "read", hashes: [] } };
  let records: ClaimEvidence["records"];
  try {
    const read = await ctx.api.jobRecords(jobId);
    records = { kind: "read", hashes: read.records.map((r) => `0x${r.hash.toLowerCase()}` as Hex) };
  } catch (error) {
    records = { kind: "unreadable", detail: messageOf(error) };
  }
  return { job, records };
}

/** Whether the WorkRegistry wrote a receipt in the last `blocks` blocks; null when that cannot be read. */
async function receiptsFlowing(
  ctx: ObserveContext,
  registry: Address,
  blocks: number,
): Promise<boolean | null> {
  try {
    const head = ctx.block.number;
    const fromBlock = head > BigInt(blocks) ? head - BigInt(blocks) : 0n;
    const logs = await ctx.reader.getLogs({
      address: registry,
      event: WORK_RECORDED,
      fromBlock,
      toBlock: head,
    });
    return logs.length > 0;
  } catch (error) {
    ctx.log.debug("could not read the registry's receipts", { error: messageOf(error) });
    return null;
  }
}

/** Reads the snapshot `decideDesk` takes. Sends nothing. */
export async function observeDesk(ctx: ObserveContext, targets: DeskTargets): Promise<DeskSnapshot> {
  const { workOrders } = targets;
  const state = ctx.store.data;
  const now = ctx.block.timestamp;
  const [imd, proof] = await Promise.all([
    readOnce<Address>(ctx, workOrders, DESK_ABI, "IMD"),
    readOnce<Address>(ctx, workOrders, DESK_ABI, "WORK_PROOF"),
  ]);
  const registry = await readOnce<Address>(ctx, proof, PROOF_ABI, "WORK_REGISTRY");
  const orderCount = big(await readAt(ctx, workOrders, DESK_ABI, "orderCount"));

  const live: bigint[] = [];
  for (let id = 1n; id <= orderCount && live.length < targets.maxOrders; id++) {
    if (!isDone(state, "desk", id)) live.push(id);
  }
  const pairs = (await Promise.all(
    live.flatMap((id) => [
      readAt(ctx, workOrders, DESK_ABI, "orderOf", [id]),
      readAt(ctx, workOrders, DESK_ABI, "claimOf", [id]),
    ]),
  )) as (OrderStruct | ClaimStruct)[];

  const orders: DeskOrderView[] = [];
  let changed = false;
  for (let i = 0; i < live.length; i++) {
    const id = live[i] as bigint;
    const o = pairs[2 * i] as OrderStruct;
    const c = pairs[2 * i + 1] as ClaimStruct;
    const orderState = num(o.state);
    const assertedAt = big(c.assertedAt);
    // What can no longer change is never read again: a cancelled or refunded order, a proven
    // delivery, and a delivery paid on a claim whose receipt was looked for long enough.
    const settledForGood =
      orderState === ORDER_STATE.Cancelled ||
      orderState === ORDER_STATE.Refunded ||
      (orderState === ORDER_STATE.Delivered &&
        (o.proven || (assertedAt !== 0n && now > assertedAt + BigInt(targets.stampWatchSeconds))));
    if (settledForGood) {
      changed = markDone(state, "desk", id) || changed;
      continue;
    }
    const jobBytes = c.jobId.toLowerCase() as Hex;
    const jobId = jobBytes === ZERO_JOB ? null : bytes16ToUuid(jobBytes);
    const conditional = o.condTarget.toLowerCase() !== ZERO_ADDRESS;
    const view: DeskOrderView = {
      id,
      state: orderState,
      employer: o.employer,
      expiresAt: big(o.expiresAt),
      flags: num(o.flags),
      kindHash: o.kindHash,
      specHash: o.specHash,
      deliverySecs: big(o.deliverySecs),
      bond: big(o.bond),
      arbiter: o.arbiter,
      seq: num(o.seq),
      proven: o.proven,
      conditional,
      condMet: o.condMet,
      condHoldsNow: false,
      claim: {
        runner: c.runner,
        claimedAt: big(c.claimedAt),
        registeredAt: big(c.registeredAt),
        jobId,
        challenger: c.challenger,
        assertedAt,
        recordHash: c.recordHash.toLowerCase() as Hex,
      },
      ticket: ZERO_HASH as Hex,
      receipt: null,
      evidence: null,
      failingSince: null,
      knownTrue: false,
    };

    if (orderState === ORDER_STATE.Open && conditional && !o.condMet && now < view.expiresAt) {
      const condition = (await readAt(ctx, workOrders, DESK_ABI, "conditionOf", [id])) as readonly unknown[];
      view.condHoldsNow = condition[1] === true;
    }

    const hasJob =
      jobId !== null &&
      (orderState === ORDER_STATE.Registered ||
        orderState === ORDER_STATE.Asserted ||
        orderState === ORDER_STATE.Disputed ||
        orderState === ORDER_STATE.Delivered);
    if (hasJob && jobId !== null) {
      const [ticket, usedBy] = await Promise.all([
        readAt(ctx, workOrders, DESK_ABI, "ticketOf", [id]),
        readAt(ctx, workOrders, DESK_ABI, "orderOfJob", [jobBytes]),
      ]);
      view.ticket = ticket as Hex;
      view.jobUsedBy = big(usedBy);
      view.receipt = await readReceipt(ctx, registry, view, jobId, jobBytes);
    }

    if ((orderState === ORDER_STATE.Asserted || orderState === ORDER_STATE.Disputed) && jobId !== null) {
      const key = claimKey(id, view.seq);
      const note = state.claims?.[key];
      view.knownTrue = note?.verdict === "true";
      view.failingSince = note?.failingSince === undefined ? null : BigInt(note.failingSince);
      view.remembered =
        note !== undefined && note.verdict !== "unknown"
          ? { verdict: note.verdict, reasons: note.reasons }
          : null;
      // The API is asked only where its answer can change what is done: an unchallenged claim
      // with no receipt on chain that was not already found true.
      const undecided = orderState === ORDER_STATE.Asserted && view.receipt?.kind !== "read";
      if (undecided && !view.knownTrue) {
        view.evidence = await readEvidence(ctx, jobId);
        // When the claim was first seen to fail: a challenge waits for a second look.
        const judged = judgeClaim(view, view.evidence);
        if (judged.verdict === "untrue") {
          if (view.failingSince === null) view.failingSince = now;
        } else {
          view.failingSince = null;
        }
      }
    }
    orders.push(view);
  }
  if (changed) {
    try {
      ctx.store.save();
    } catch (error) {
      ctx.log.debug("the state file could not be written", { error: messageOf(error) });
    }
  }

  let keeperImd: bigint | null = null;
  let keeperAllowance: bigint | null = null;
  if (ctx.keeper !== null) {
    const [balance, allowance] = await Promise.all([
      readAt(ctx, imd, ERC20_ABI, "balanceOf", [ctx.keeper]),
      readAt(ctx, imd, ERC20_ABI, "allowance", [ctx.keeper, workOrders]),
    ]);
    keeperImd = big(balance);
    keeperAllowance = big(allowance);
  }

  return {
    now,
    block: ctx.block.number,
    chainId: ctx.chainId,
    workOrders,
    imd,
    orderCount,
    orders,
    keeperImd,
    keeperAllowance,
    challengedToday: challengedOn(state, utcDay(Number(now))),
    receiptsFlowing: await receiptsFlowing(ctx, registry, targets.receiptStallBlocks),
  };
}
