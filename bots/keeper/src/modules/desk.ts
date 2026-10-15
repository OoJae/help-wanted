/**
 * The desk module: the calls on the hire desk that nothing makes by itself, and the watch on
 * delivery claims.
 *
 * `decideDesk` is a pure function of a snapshot (what the chain says about every live order at one
 * block, and what IdentityMD's API and WorkRegistry say about the jobs they name) and a policy (the
 * operator's settings). Nothing here reads a clock, the chain or the network.
 *
 * THE RULES, per order, by the desk's own state.
 *
 * Open
 *   refund    once the order has expired with nobody holding it (`now >= expiresAt`).
 *   trigger   a conditional order whose condition holds now and was never latched, so that a
 *             runner can take it and its price starts to rise.
 *
 * Claimed (a runner holds it and has registered no job)
 *   evict     once the one-hour claim window is over. The runner's bond goes to the employer.
 *
 * Registered (a job is registered, no delivery claimed)
 *   settle        the registry holds a receipt for the job and its record settles the order.
 *   reportFailed  the receipt shows another objective than the claim's (the bond goes to the
 *                 employer) or the right objective under another kind (the bond returns to the
 *                 runner): either way the order is free again. A receipt that shows the claim's
 *                 own job ended without completing is the runner's alone to report.
 *   timeout       the delivery deadline has passed and no receipt settles the order.
 *
 * Asserted (the runner claimed delivery; the 24-hour challenge window is running or over)
 *   settle        a receipt settles the order: the receipt always wins.
 *   reportFailed  a receipt of the registered job does not settle the order: the claim is refuted
 *                 without anybody posting a bond.
 *   challenge     no receipt, and the claim fails the check below. Only within the float and the
 *                 daily cap for challenge bonds, only when the order's arbiter is one the operator
 *                 listed (or the order has none), and only once the failure has been seen on two
 *                 looks some minutes apart.
 *   finalize      the challenge window is over, nobody challenged, and the claim passed the check.
 *
 * Disputed (somebody challenged the claim)
 *   settle / reportFailed   as soon as a receipt decides it.
 *   timeout       the delivery deadline has passed with nothing decided: the employer is refunded,
 *                 the challenger gets its bond back.
 *
 * Delivered and not proven (paid on a claim)
 *   stamp     when the receipt lands and its record would have settled the order.
 *
 * THE CHECK OF A DELIVERY CLAIM. A claim names a job and a record hash, and until a receipt exists
 * both are the runner's word. The keeper holds them against what IdentityMD's API says:
 *   - the job exists, and it is completed;
 *   - its objective begins with the order's header for that claim (the ticket of the claim, as the
 *     desk computes it) and continues with exactly the order's spec;
 *   - its template is the order's kind (a work record's kind is the job's template);
 *   - `GET /jobs/<jobId>/records` lists the hash the claim named.
 * A claim that fails any of these is "untrue"; one the API could not be asked about is "unknown",
 * and the keeper never challenges, or finalizes, blind.
 *
 * A record hash that differs from the one the registry later holds is NOT a reason to challenge:
 * a job can be given a second record, and any receipt that settles the order pays the runner.
 */
import type { Abi, Address, Hex } from "viem";
import {
  DESK,
  HEADER_LENGTH,
  ORDER_STATE,
  erc20Abi,
  kindHash,
  orderHeader,
  orderStateName,
  proofGasNeeded,
  sameAddress,
  settleGasNeeded,
  specHash,
  workOrdersAbi,
  workProofAbi,
  type RecordVerdict,
} from "@help-wanted/shared";
import type { Action, Decision, Waiting } from "../actions.js";

/** The desk's ABI with WorkProof's errors beside it, so a refused simulation can name them. */
export const DESK_ABI = [
  ...workOrdersAbi,
  ...workProofAbi.filter((item) => item.type === "error"),
] as unknown as Abi;
const ERC20_ABI = erc20Abi as unknown as Abi;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** `trigger` insists on handing the condition target its whole 100,000 gas. */
export const TRIGGER_GAS_FLOOR = 200_000n;
/** The challenge is not sent this close to the end of its window: it would revert `TooLate`. */
export const CHALLENGE_MARGIN_SECONDS = 120n;

export interface DeskPolicy {
  /** The keeper's own address, when one is known. Challenges need it. */
  keeper: Address | null;
  /**
   * The most IMD the keeper has posted as challenge bonds at one time. Zero (the default) means it
   * never challenges: it then only reports what it saw.
   */
  challengeFloat: bigint;
  /** The most IMD the keeper posts as challenge bonds in one UTC day. */
  challengeDailyCap: bigint;
  /**
   * Arbiters the keeper accepts on an order it challenges (lowercase addresses). An order with any
   * other arbiter is never challenged: that arbiter could decide against the challenge and the
   * bond would be lost. An order with no arbiter can only be decided by a receipt or the deadline.
   */
  challengeArbiters: ReadonlySet<string>;
  /**
   * Employers whose orders the keeper puts its own IMD behind (lowercase addresses). Empty means
   * any employer. A challenge bond stays posted until the order's delivery deadline, which can be
   * ninety days away, and an order's employer and its runner can be one party: such a party can
   * open orders, claim them untruly and so tie up a keeper's whole float at no cost to itself.
   * Naming the employers the keeper serves (the Doorbell, CrowdPots, Rules, its own wallets) keeps
   * the float for them.
   */
  challengeEmployers: ReadonlySet<string>;
  /** How long a claim must have been seen failing the check before it is challenged, in seconds. */
  challengeConfirmSeconds: number;
  /** Runners (lowercase addresses) the keeper never evicts and never times out: the operator's own. */
  ownRunners: ReadonlySet<string>;
  /** The largest record the keeper carries in a `settle`, `stamp` or `reportFailed`, in bytes. */
  maxRecordBytes: number;
  /** Whether the keeper sends `finalize` for claims that passed the check. */
  finalizeClaims: boolean;
  /** Whether the keeper sends `settle` for other people's orders when a receipt exists. */
  settleReceipts: boolean;
}

/** What the WorkRegistry and the API say about the receipt of an order's registered job. */
export type ReceiptView =
  /** The registry holds nothing for the job. */
  | { kind: "none" }
  /** The registry holds a hash whose record could not be fetched. */
  | { kind: "unread"; hash: Hex; detail: string }
  /** The record the registry's hash names, read as the desk would read it. */
  | { kind: "read"; hash: Hex; record: Hex; bytes: number; verdict: RecordVerdict };

/** What IdentityMD's API says about the job a delivery claim names. */
export interface ClaimEvidence {
  job:
    | {
        kind: "read";
        state: string;
        template: string | null;
        objective: string;
      }
    /** The API answered that there is no such job. */
    | { kind: "missing" }
    | { kind: "unreadable"; detail: string };
  records:
    /** The hashes `GET /jobs/<jobId>/records` lists, `0x` and lowercase. */
    { kind: "read"; hashes: Hex[] } | { kind: "unreadable"; detail: string };
}

export interface DeskOrderView {
  id: bigint;
  state: number;
  employer: Address;
  expiresAt: bigint;
  flags: number;
  kindHash: Hex;
  specHash: Hex;
  deliverySecs: bigint;
  bond: bigint;
  arbiter: Address;
  seq: number;
  proven: boolean;
  /** Whether the order has a condition, whether it was latched, and whether it holds now. */
  conditional: boolean;
  condMet: boolean;
  condHoldsNow: boolean;
  claim: {
    runner: Address;
    claimedAt: bigint;
    registeredAt: bigint;
    /** The registered job as a UUID, or null while none is registered. */
    jobId: string | null;
    challenger: Address;
    assertedAt: bigint;
    recordHash: Hex;
  };
  /** `ticketOf(id)`: the ticket of the order's current claim. */
  ticket: Hex;
  /**
   * `orderOfJob(jobId)`: the order the registered job's receipt was already matched for, or zero.
   * A job proves one order: when this is another order, no receipt of the job can settle or stamp
   * this one.
   */
  jobUsedBy?: bigint;
  /** Read for an order with a registered job; null when it was not read. */
  receipt: ReceiptView | null;
  /** Read for an order whose delivery claim can still be challenged or finalized; null otherwise. */
  evidence: ClaimEvidence | null;
  /** When this keeper first saw the claim fail the check, in the chain's seconds; null if never. */
  failingSince: bigint | null;
  /** A verdict kept from an earlier look, when the claim was found true then (it cannot become untrue). */
  knownTrue: boolean;
  /**
   * What an earlier look made of the claim, when it could be judged then. It is what the record
   * of a claim says once the API is no longer asked about it (after a challenge, say).
   */
  remembered?: { verdict: ClaimVerdict; reasons: string[] } | null;
}

export interface DeskSnapshot {
  /** The time and number of the block everything was read at. */
  now: bigint;
  block: bigint;
  chainId: number;
  workOrders: Address;
  imd: Address;
  orderCount: bigint;
  orders: DeskOrderView[];
  /** The keeper's IMD, its allowance to the desk, and what it has posted as challenge bonds. */
  keeperImd: bigint | null;
  keeperAllowance: bigint | null;
  /** IMD posted as challenge bonds today, from the keeper's own ledger. */
  challengedToday: bigint;
  /** Whether the WorkRegistry wrote a receipt lately; null when that could not be read. */
  receiptsFlowing: boolean | null;
}

export type ClaimVerdict = "true" | "untrue" | "unknown";

/** One delivery claim the keeper looked at, and what it made of it. Goes into the status file. */
export interface ClaimRecord {
  order: string;
  seq: number;
  runner: Address;
  jobId: string | null;
  namedHash: Hex;
  assertedAt: number;
  challengeEndsAt: number;
  state: string;
  verdict: ClaimVerdict;
  /** Why: each thing the check found. */
  reasons: string[];
  /** What the keeper does about it on this pass, in a word. */
  action: "challenge" | "finalize" | "settle" | "reportFailed" | "timeout" | "none";
  /** Why it does that, or why it does nothing. */
  why: string;
}

export interface DeskDecision extends Decision {
  claims: ClaimRecord[];
}

/** Holds a delivery claim against what the API says about the job it names. */
export function judgeClaim(
  order: Pick<DeskOrderView, "kindHash" | "specHash" | "ticket" | "claim">,
  evidence: ClaimEvidence | null,
): { verdict: ClaimVerdict; reasons: string[] } {
  if (evidence === null) return { verdict: "unknown", reasons: ["IdentityMD's API was not asked"] };
  const reasons: string[] = [];
  const { job, records } = evidence;
  if (job.kind === "missing") {
    return { verdict: "untrue", reasons: ["IdentityMD knows no job with the registered id"] };
  }
  if (job.kind === "unreadable") {
    return { verdict: "unknown", reasons: [`the job could not be read (${job.detail})`] };
  }
  const header = orderHeader(order.ticket);
  if (!job.objective.startsWith(header)) {
    reasons.push("the job's objective does not begin with the order's header for this claim");
  } else if (specHash(job.objective.slice(HEADER_LENGTH)).toLowerCase() !== order.specHash.toLowerCase()) {
    reasons.push("after the header, the job's objective is not the order's spec");
  }
  if (job.template === null) {
    reasons.push("the job names no template, so its record cannot be of the order's kind");
  } else if (kindHash(job.template).toLowerCase() !== order.kindHash.toLowerCase()) {
    reasons.push(`the job's template is "${job.template}", which is not the order's kind`);
  }
  if (job.state !== "completed") reasons.push(`the job is ${job.state}, not completed`);
  if (records.kind === "unreadable") {
    // What is already known may be enough to call the claim untrue; if not, it stays unknown.
    if (reasons.length > 0) return { verdict: "untrue", reasons };
    return { verdict: "unknown", reasons: [`the job's records could not be read (${records.detail})`] };
  }
  const named = order.claim.recordHash.toLowerCase();
  if (!records.hashes.some((hash) => hash.toLowerCase() === named)) {
    reasons.push(
      records.hashes.length === 0
        ? "IdentityMD lists no record for the job"
        : "the record hash the claim names is not one IdentityMD lists for the job",
    );
  }
  if (reasons.length > 0) return { verdict: "untrue", reasons };
  return {
    verdict: "true",
    reasons: [
      "the job is completed under the order's kind, its objective is the claim's header and the order's spec, and the named record is listed",
    ],
  };
}

function act(
  snapshot: DeskSnapshot,
  order: DeskOrderView,
  kind: string,
  args: readonly unknown[],
  label: string,
  reason: string,
  gasFloor?: bigint,
): Action {
  return {
    module: "desk",
    kind,
    subject: `order ${order.id}`,
    label,
    reason,
    call: { address: snapshot.workOrders, abi: DESK_ABI, functionName: kind, args },
    ...(gasFloor === undefined ? {} : { gasFloor }),
  };
}

/** The delivery deadline of a claim: zero while no job is registered. */
export function deadlineOf(order: Pick<DeskOrderView, "claim" | "deliverySecs">): bigint {
  return order.claim.registeredAt === 0n ? 0n : order.claim.registeredAt + order.deliverySecs;
}

/** State in, actions with reasons out. Pure. */
export function decideDesk(snapshot: DeskSnapshot, policy: DeskPolicy): DeskDecision {
  const actions: Action[] = [];
  const waiting: Waiting[] = [];
  const claims: ClaimRecord[] = [];
  const { now } = snapshot;
  const wait = (order: DeskOrderView, reason: string, extra: Partial<Waiting> = {}) =>
    waiting.push({ module: "desk", subject: `order ${order.id}`, reason, ...extra });

  // What is posted as challenge bonds now, read from the chain: the bond of every disputed order
  // this keeper challenged. Each challenge decided on this pass is added as it is decided.
  let outstanding = 0n;
  if (policy.keeper !== null) {
    for (const order of snapshot.orders) {
      if (order.state === ORDER_STATE.Disputed && sameAddress(order.claim.challenger, policy.keeper)) {
        outstanding += order.bond;
      }
    }
  }
  let today = snapshot.challengedToday;
  let allowance = snapshot.keeperAllowance ?? 0n;
  let balance = snapshot.keeperImd ?? 0n;

  /**
   * What a receipt of the registered job asks for, if anything: `settle`, `reportFailed`, or
   * nothing. Returns true when an action was added or the receipt is one to wait on.
   */
  const receiptAction = (order: DeskOrderView, record: ClaimRecord | null): boolean => {
    const receipt = order.receipt;
    if (receipt === null || receipt.kind === "none") return false;
    if (order.jobUsedBy !== undefined && order.jobUsedBy !== 0n && order.jobUsedBy !== order.id) {
      // The desk would answer `JobUsed`: neither a settlement nor a failure report is possible.
      wait(
        order,
        `the receipt of its job ${order.claim.jobId} was already matched for order ${order.jobUsedBy}: a job proves one order, so this claim can only end at its deadline`,
        { attention: true },
      );
      return false;
    }
    if (receipt.kind === "unread") {
      wait(
        order,
        `the registry holds receipt ${receipt.hash} for its job; its record could not be read (${receipt.detail})`,
        {
          attention: true,
        },
      );
      return false;
    }
    const verdict = receipt.verdict;
    const tooLarge = receipt.bytes > policy.maxRecordBytes;
    if (verdict.kind === "settles") {
      if (!policy.settleReceipts) {
        wait(order, `receipt ${receipt.hash} settles it; settling is left to its runner (DESK_SETTLE=0)`);
        return true;
      }
      if (tooLarge) {
        wait(
          order,
          `receipt ${receipt.hash} settles it, but its record is ${receipt.bytes} bytes: above the ${policy.maxRecordBytes} this keeper carries in one transaction. It takes the chunked proof (WorkProof.proveChunks)`,
          { attention: true },
        );
        return true;
      }
      actions.push(
        act(
          snapshot,
          order,
          "settle",
          [order.id, receipt.record, []],
          `settle order ${order.id} with its ${receipt.bytes}-byte record`,
          `the WorkRegistry holds receipt ${receipt.hash} for job ${order.claim.jobId}, and its record settles the order: completed, of the order's kind, with this claim's header and the order's spec`,
          settleGasNeeded(receipt.bytes),
        ),
      );
      if (record !== null) {
        record.action = "settle";
        record.why = `a receipt (${receipt.hash}) settles the order, whatever hash the claim named`;
      }
      return true;
    }
    if (verdict.kind === "unreadable") {
      wait(
        order,
        `the registry holds receipt ${receipt.hash}, which cannot be read as a work record of the job (${verdict.why}); it decides nothing, and the claim ends at its deadline`,
        { attention: true },
      );
      return false;
    }
    // A receipt of the registered job that does not settle the order.
    const claimed = order.state === ORDER_STATE.Asserted || order.state === ORDER_STATE.Disputed;
    if (!claimed && verdict.kind === "not_completed") {
      wait(
        order,
        `receipt ${receipt.hash} shows the job ended ${verdict.state}; only its runner may report that (it gets its bond back), or register another job`,
      );
      return false;
    }
    if (tooLarge) {
      wait(
        order,
        `receipt ${receipt.hash} does not settle the order, but its record is ${receipt.bytes} bytes: too large for this keeper to report`,
        { attention: true },
      );
      return false;
    }
    const what =
      verdict.kind === "not_completed"
        ? `the job ended ${verdict.state}`
        : verdict.kind === "wrong_kind"
          ? `the record's kind is "${verdict.recordKind}", not the order's`
          : "its objective is not this claim's header followed by the order's spec";
    const consequence = claimed
      ? order.state === ORDER_STATE.Disputed
        ? "the delivery claim is refuted: a tenth of the runner's bond goes to the employer, the rest to the challenger with its own bond"
        : "the delivery claim is refuted: the runner's bond goes to the employer"
      : verdict.kind === "wrong_kind"
        ? "the order is free again and the bond returns to the runner"
        : "the registered job is not this claim's: the bond goes to the employer and the order is free again";
    actions.push(
      act(
        snapshot,
        order,
        "reportFailed",
        [order.id, receipt.record, []],
        `report the receipt that does not settle order ${order.id}`,
        `the WorkRegistry holds receipt ${receipt.hash} for job ${order.claim.jobId}: ${what}; ${consequence}`,
        proofGasNeeded(receipt.bytes),
      ),
    );
    if (record !== null) {
      record.action = "reportFailed";
      record.why = `a receipt (${receipt.hash}) contradicts the claim: ${what}`;
    }
    return true;
  };

  for (const order of snapshot.orders) {
    const ownRunner = policy.ownRunners.has(order.claim.runner.toLowerCase());

    if (order.state === ORDER_STATE.Open) {
      if (now >= order.expiresAt) {
        actions.push(
          act(
            snapshot,
            order,
            "refund",
            [order.id],
            `refund expired order ${order.id}`,
            `the order expired at ${order.expiresAt} with nobody holding it: its escrow goes back to its employer ${order.employer}`,
          ),
        );
      } else if (order.conditional && !order.condMet) {
        if (order.condHoldsNow) {
          actions.push(
            act(
              snapshot,
              order,
              "trigger",
              [order.id],
              `latch the condition of order ${order.id}`,
              "the order's condition holds now and was never latched: once latched a runner can take it and its price starts to rise",
              TRIGGER_GAS_FLOOR,
            ),
          );
        } else {
          wait(order, "its condition does not hold yet");
        }
      }
      continue;
    }

    if (order.state === ORDER_STATE.Claimed) {
      const windowEnds = order.claim.claimedAt + BigInt(DESK.CLAIM_WINDOW);
      if (now < windowEnds) {
        wait(order, `runner ${order.claim.runner} holds it and has until ${windowEnds} to register a job`, {
          until: Number(windowEnds),
        });
      } else if (ownRunner) {
        wait(
          order,
          `the claim window is over; runner ${order.claim.runner} is one this keeper does not evict`,
          {
            attention: true,
          },
        );
      } else {
        actions.push(
          act(
            snapshot,
            order,
            "evict",
            [order.id],
            `evict the runner of order ${order.id}`,
            `runner ${order.claim.runner} claimed at ${order.claim.claimedAt} and registered no job within the hour: its bond goes to the employer and the order is free again`,
          ),
        );
      }
      continue;
    }

    if (order.state === ORDER_STATE.Registered) {
      if (receiptAction(order, null)) continue;
      const deadline = deadlineOf(order);
      if (now >= deadline) {
        if (ownRunner) {
          wait(
            order,
            `the delivery deadline passed at ${deadline}; runner ${order.claim.runner} is one this keeper does not time out`,
            {
              attention: true,
            },
          );
        } else {
          actions.push(
            act(
              snapshot,
              order,
              "timeout",
              [order.id],
              `time out order ${order.id}`,
              `job ${order.claim.jobId} was registered at ${order.claim.registeredAt} and no receipt settled the order by its delivery deadline ${deadline}: the runner's bond goes to the employer`,
            ),
          );
        }
      } else {
        wait(
          order,
          `job ${order.claim.jobId} is registered; a receipt or a delivery claim is awaited until ${deadline}`,
          {
            until: Number(deadline),
          },
        );
      }
      continue;
    }

    if (order.state === ORDER_STATE.Asserted || order.state === ORDER_STATE.Disputed) {
      // A fresh reading of the API when there is one; otherwise what an earlier look found.
      const remembered = order.remembered ?? null;
      const judged = order.knownTrue
        ? { verdict: "true" as const, reasons: remembered?.reasons ?? ["found true on an earlier look"] }
        : order.evidence === null && remembered !== null
          ? remembered
          : judgeClaim(order, order.evidence);
      const challengeEnds = order.claim.assertedAt + BigInt(DESK.CHALLENGE_WINDOW);
      const record: ClaimRecord = {
        order: order.id.toString(),
        seq: order.seq,
        runner: order.claim.runner,
        jobId: order.claim.jobId,
        namedHash: order.claim.recordHash,
        assertedAt: Number(order.claim.assertedAt),
        challengeEndsAt: Number(challengeEnds),
        state: orderStateName(order.state),
        verdict: judged.verdict,
        reasons: judged.reasons,
        action: "none",
        why: "",
      };
      claims.push(record);

      // The receipt always wins, whatever the check says and whatever hash the claim named.
      if (receiptAction(order, record)) continue;

      const deadline = deadlineOf(order);
      if (order.state === ORDER_STATE.Disputed) {
        if (now >= deadline) {
          actions.push(
            act(
              snapshot,
              order,
              "timeout",
              [order.id],
              `end the undecided dispute of order ${order.id}`,
              `the delivery claim was challenged by ${order.claim.challenger} and neither a receipt nor the arbiter decided it by the delivery deadline ${deadline}: the employer is refunded and the challenger's bond returned`,
            ),
          );
          record.action = "timeout";
          record.why = "challenged and undecided at the delivery deadline";
        } else {
          record.why = `challenged by ${order.claim.challenger}; a receipt or the arbiter decides it, or the deadline at ${deadline} refunds the employer`;
          wait(order, record.why, { until: Number(deadline) });
        }
        continue;
      }

      // Asserted: nobody has challenged.
      if (now >= challengeEnds) {
        if (judged.verdict === "true" && policy.finalizeClaims) {
          actions.push(
            act(
              snapshot,
              order,
              "finalize",
              [order.id],
              `finalize the delivery claim of order ${order.id}`,
              `the delivery claim of ${order.claim.runner} stood unchallenged for 24 hours (until ${challengeEnds}) and passed the check: ${judged.reasons.join("; ")}`,
            ),
          );
          record.action = "finalize";
          record.why = "unchallenged for 24 hours, and the claim passed the check";
        } else {
          record.why =
            judged.verdict === "true"
              ? "the challenge window is over; finalizing is left to the runner (DESK_FINALIZE=0)"
              : `the challenge window is over and the claim is ${judged.verdict} (${judged.reasons.join("; ")}): this keeper does not pay it out; its runner can`;
          wait(order, record.why, { attention: judged.verdict !== "true" });
        }
        continue;
      }

      if (judged.verdict === "true") {
        record.why = `the claim passed the check; it can be finalized at ${challengeEnds}`;
        wait(order, record.why, { until: Number(challengeEnds) });
        continue;
      }
      if (judged.verdict === "unknown") {
        record.why = `not challenged: ${judged.reasons.join("; ")}. A claim is not challenged blind`;
        wait(order, record.why, { attention: true, until: Number(challengeEnds) });
        continue;
      }

      // Untrue, inside the challenge window, and no receipt on chain: challenge, if allowed.
      const failing = judged.reasons.join("; ");
      const refuse = (why: string, attention = true) => {
        record.why = `the claim fails the check (${failing}); not challenged: ${why}`;
        wait(order, record.why, { attention, until: Number(challengeEnds) });
      };
      if (policy.keeper === null) {
        refuse("no keeper address is configured");
        continue;
      }
      if (policy.challengeFloat === 0n || policy.challengeDailyCap === 0n) {
        refuse("challenges are off (CHALLENGE_FLOAT_IMD and CHALLENGE_DAILY_CAP_IMD are not both set)");
        continue;
      }
      if (
        order.arbiter.toLowerCase() !== ZERO_ADDRESS &&
        !policy.challengeArbiters.has(order.arbiter.toLowerCase())
      ) {
        refuse(`the order's arbiter ${order.arbiter} is not on this keeper's list (CHALLENGE_ARBITERS)`);
        continue;
      }
      if (sameAddress(order.claim.runner, policy.keeper)) {
        refuse("the claim is this keeper's own");
        continue;
      }
      if (
        policy.challengeEmployers.size > 0 &&
        !policy.challengeEmployers.has(order.employer.toLowerCase())
      ) {
        refuse(
          `its employer ${order.employer} is not one this keeper posts bonds for (CHALLENGE_EMPLOYERS)`,
          false,
        );
        continue;
      }
      if (now + CHALLENGE_MARGIN_SECONDS >= challengeEnds) {
        refuse(`the challenge window ends at ${challengeEnds}, too close to send a challenge`);
        continue;
      }
      const since = order.failingSince;
      const confirmAt = (since ?? now) + BigInt(policy.challengeConfirmSeconds);
      if (since === null || now < confirmAt) {
        // The window may end before the second look: then the first one must do.
        if (confirmAt + CHALLENGE_MARGIN_SECONDS < challengeEnds) {
          refuse(
            `it is challenged if it still fails at ${confirmAt}: one reading of the API does not cost a runner its bond`,
            false,
          );
          continue;
        }
      }
      if (outstanding + order.bond > policy.challengeFloat) {
        refuse(
          `its bond of ${order.bond} would take the challenge bonds this keeper has posted (${outstanding}) above the float of ${policy.challengeFloat}`,
        );
        continue;
      }
      if (today + order.bond > policy.challengeDailyCap) {
        refuse(
          `its bond of ${order.bond} would take today's challenge bonds (${today}) above the daily cap of ${policy.challengeDailyCap}`,
        );
        continue;
      }
      if (snapshot.keeperImd === null || balance < order.bond) {
        refuse(`the keeper holds ${balance} IMD, less than the bond of ${order.bond}`);
        continue;
      }
      if (allowance < order.bond) {
        actions.push({
          module: "desk",
          kind: "approve",
          subject: `order ${order.id}`,
          label: `approve the desk for the challenge bond of order ${order.id}`,
          reason: `a challenge posts a bond of ${order.bond} IMD, which the desk pulls from the keeper`,
          call: {
            address: snapshot.imd,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [snapshot.workOrders, order.bond],
          },
        });
        allowance = order.bond;
      }
      actions.push({
        ...act(
          snapshot,
          order,
          "challenge",
          [order.id],
          `challenge the delivery claim of order ${order.id}`,
          `runner ${order.claim.runner} claimed delivery of job ${order.claim.jobId} as record ${order.claim.recordHash}, and the claim fails the check: ${failing}. No receipt is on chain. The keeper posts ${order.bond} IMD; it comes back unless a receipt settles the order`,
        ),
        postsImd: order.bond,
      });
      outstanding += order.bond;
      today += order.bond;
      balance -= order.bond;
      allowance -= order.bond;
      record.action = "challenge";
      record.why = `the claim fails the check: ${failing}`;
      continue;
    }

    if (order.state === ORDER_STATE.Delivered && !order.proven) {
      const receipt = order.receipt;
      if (order.jobUsedBy !== undefined && order.jobUsedBy !== 0n && order.jobUsedBy !== order.id) {
        wait(
          order,
          `it was paid on a delivery claim, and the receipt of its job was matched for order ${order.jobUsedBy}: it cannot be stamped and stays unproven`,
        );
      } else if (receipt !== null && receipt.kind === "read" && receipt.verdict.kind === "settles") {
        if (receipt.bytes > policy.maxRecordBytes) {
          wait(
            order,
            `its receipt has landed; the record is ${receipt.bytes} bytes, too large for this keeper to stamp`,
          );
        } else {
          actions.push(
            act(
              snapshot,
              order,
              "stamp",
              [order.id, receipt.record, []],
              `stamp order ${order.id} as proven`,
              `the order was paid on a delivery claim, and the WorkRegistry now holds receipt ${receipt.hash} for job ${order.claim.jobId}, whose record would have settled it. No money moves`,
              proofGasNeeded(receipt.bytes),
            ),
          );
        }
      } else if (receipt !== null && receipt.kind === "read") {
        wait(
          order,
          `it was paid on a delivery claim, and receipt ${receipt.hash} does not prove it (${receipt.verdict.kind}); it stays unproven`,
          {
            attention: true,
          },
        );
      } else {
        wait(
          order,
          "it was paid on a delivery claim and is not proven yet: it is stamped when its receipt lands",
        );
      }
      continue;
    }
  }

  if (snapshot.receiptsFlowing === false) {
    waiting.push({
      module: "desk",
      subject: "receipts",
      reason:
        "the WorkRegistry has written no receipt lately: orders can only be paid on delivery claims for now, and each claim is checked above",
    });
  }
  return { actions, waiting, claims };
}
