/**
 * The runner's memory: one small JSON file, rewritten atomically after every step.
 *
 * It holds what a restart needs to carry on in the middle of an order: the block the log scan has
 * reached, every order the runner has looked at and how far it got with it, the exact bytes of any
 * paid request that has been signed, and what has been spent today. It never holds the wallet key.
 *
 * It does hold the paid-request token (a random value the runner makes up; the protocol uses it to
 * tell whose orders are whose) and signed payment requests. Neither can move money on its own: a
 * signed payment pays one fixed amount to IdentityMD's payee before its deadline and nothing else.
 * The file is created readable by its owner only.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const addressText = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const amount = z.string().regex(/^[0-9]+$/);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** A signed paid request, kept byte for byte so a lost response is answered by the same bytes. */
export const SubmitRecord = z.strictObject({
  url: z.string(),
  /** The base64 `PAYMENT-SIGNATURE` header value. */
  paymentHeader: z.string(),
  /** The JSON request body, `{"quoteSignature":"0x…"}`. */
  body: z.string(),
  signedAt: z.number().int(),
  /** The Permit2 deadline, Unix seconds. After it the signed payment can no longer be settled. */
  deadline: z.number().int(),
  amount,
});
export type SubmitRecord = z.infer<typeof SubmitRecord>;

export const PAY_STAGES = ["new", "quoted", "signed", "submitted", "admitted", "failed"] as const;

export const PayState = z.strictObject({
  /** Counts quotes for this job of the claim, from 1. Part of the request key. */
  attempt: z.number().int().positive(),
  /**
   * Which job of the claim this payment buys, when it is not the first: 2 for the job bought to
   * replace one that ended blocked. Part of the request key, so no key is ever used for two jobs.
   */
  series: z.number().int().min(2).optional(),
  requestKey: uuid,
  stage: z.enum(PAY_STAGES),
  /** The objective this payment is for: the order header followed by the spec. */
  objective: z.string(),
  /** The paid order's id, once quoted. */
  requestId: uuid.optional(),
  quoteHash: z.string().optional(),
  /** The quote as it was first given, canonical JSON, to compare with the one in the challenge. */
  quoteJson: z.string().optional(),
  quoteExpiresAt: z.number().int().optional(),
  quoteAmount: amount.optional(),
  submit: SubmitRecord.optional(),
  jobId: uuid.optional(),
  paymentTx: z.string().optional(),
  /** IMD reserved against the caps for this attempt, in atomic units. */
  reserved: amount.optional(),
  /** The UTC day (`YYYY-MM-DD`) the reservation was booked on: a release is taken off that day. */
  reservedDay: z
    .string()
    .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)
    .optional(),
  /**
   * Set when the signed bytes ended with nothing taken (a failed settlement, a refusal for their
   * timing): they are not sent again, and a new quote follows once their permit has run out.
   */
  abandoned: z.boolean().optional(),
  /** How many times the signed bytes have been sent. Counted before each send. */
  sends: z.number().int().nonnegative().optional(),
  /** Status reads in a row that gave no usable answer (a 404, a 401, an unknown shape). */
  statusFailures: z.number().int().nonnegative().optional(),
  failure: z
    .strictObject({
      code: z.string(),
      detail: z.string().optional(),
      /** Whether the swarm's fee was taken: "no", "yes", or "maybe" when the outcome is not known. */
      charged: z.enum(["no", "maybe", "yes"]),
    })
    .optional(),
});
export type PayState = z.infer<typeof PayState>;

export const ORDER_STATUSES = [
  /** Seen on chain; not taken (yet). `skip` says why. */
  "seen",
  /** Claimed on chain; the job is not paid for yet. */
  "claimed",
  /** The job is admitted; its id is not registered on chain yet. */
  "paid",
  /** The job id is registered; the job is being watched. */
  "registered",
  /** Delivery was claimed without a receipt; the challenge window is running. */
  "asserted",
  /** The claim must be given back (the job could not be bought). */
  "releasing",
  /**
   * Paid out on a delivery claim nobody challenged, and not yet matched to a receipt. No bond is
   * at stake any more; the order is looked at now and then, and stamped when its receipt lands.
   */
  "unproven",
  // Terminal, except that a lost order is looked at again for a while (see `lostAt`):
  "delivered",
  "released",
  "lost",
  "skipped",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const TERMINAL_STATUSES: readonly OrderStatus[] = ["delivered", "released", "lost", "skipped"];

export const OrderRecord = z.strictObject({
  id: z.string().regex(/^[0-9]+$/),
  status: z.enum(ORDER_STATUSES),
  employer: addressText,
  kindHash: hex32,
  specHash: hex32,
  /**
   * The job text, from the `OrderOpened` event. Checked against `specHash` before use. Empty when
   * it is not known (an order found through this runner's own claim) or no longer needed (an order
   * that was skipped for good).
   */
  spec: z.string(),
  openedBlock: z.string().regex(/^[0-9]+$/),
  /** When the order expires, Unix seconds, once it has been read from the chain. */
  expiresAt: z.number().int().optional(),
  /** Set when a `Claimed` log names this runner: such an order is looked at before any other. */
  mine: z.boolean().optional(),
  /** When a waiting order is next worth a look, and how many looks it has had. */
  nextLookAt: z.number().int().optional(),
  looks: z.number().int().nonnegative().optional(),
  /** Why the order is not being taken. `permanent` reasons end the order for this runner. */
  skip: z.strictObject({ reason: z.string(), permanent: z.boolean() }).optional(),
  preflightedAt: z.number().int().optional(),
  claim: z
    .strictObject({
      seq: z.number().int().positive(),
      ticket: hex32,
      price: amount,
      bond: amount,
      claimedAt: z.number().int(),
      tx: z.string(),
    })
    .optional(),
  /** Job fees paid or reserved for this order over all attempts. */
  spent: amount,
  pay: PayState.optional(),
  /** The payment for a second job, bought to replace one that ended blocked. */
  retry: PayState.optional(),
  jobId: uuid.optional(),
  /** Jobs bought for this claim before the current one. */
  pastJobs: z.array(uuid).optional(),
  /** Attempts to buy a replacement job that ended without one. */
  retriesFailed: z.number().int().nonnegative().optional(),
  /** When the protocol was asked whether this wallet already paid for a job of this claim. */
  paidLookupAt: z.number().int().optional(),
  registeredAt: z.number().int().optional(),
  recordHash: hex32.optional(),
  assertedAt: z.number().int().optional(),
  /** When the order was first seen paid out without a receipt (an unproven delivery). */
  finalizedAt: z.number().int().optional(),
  /** Set once the desk's own `headerOf` was compared with the header this runner built for the claim. */
  headerChecked: z.boolean().optional(),
  /** The newest record the job listed, and when this runner first saw it there. */
  recordSeen: z.strictObject({ hash: hex32, at: z.number().int() }).optional(),
  /**
   * The highest block this runner has relied on for the order: the block of its last transaction,
   * or of the reading it last acted on. A later reading from a lower block is from a node that is
   * behind, and is not believed.
   */
  lastBlock: z
    .string()
    .regex(/^[0-9]+$/)
    .optional(),
  /** Readings in a row that say the order is no longer this runner's. One alone decides nothing. */
  suspect: z
    .strictObject({ reason: z.string(), count: z.number().int().positive(), since: z.number().int() })
    .optional(),
  /** When the order was given up as lost. It is still looked at for a while after. */
  lostAt: z.number().int().optional(),
  /**
   * What has been said about the order in its present status, so that each thing is said once and
   * not on every pass. Cleared when the status changes.
   */
  said: z.array(z.string()).optional(),
  outcome: z.string().optional(),
  lastError: z.string().optional(),
  updatedAt: z.number().int(),
});
export type OrderRecord = z.infer<typeof OrderRecord>;

export const StoreData = z.strictObject({
  version: z.literal(1),
  /** The desk this file belongs to. A store is never reused for another desk or another runner. */
  workOrders: addressText,
  runner: addressText.nullable(),
  /** The last block whose `OrderOpened` logs have been read. */
  cursor: z
    .string()
    .regex(/^[0-9]+$/)
    .nullable(),
  /** The paid-request Bearer token, when the operator did not supply one. */
  token: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  orders: z.record(z.string(), OrderRecord),
  /** IMD reserved or spent on swarm fees per UTC day (`YYYY-MM-DD`), in atomic units. */
  spend: z.record(z.string(), amount),
  /**
   * Payments in a row that ended without a job after a bond was posted. At the configured limit
   * the runner stops taking orders until an operator runs `resume`.
   */
  breaker: z
    .strictObject({
      failures: z.number().int().nonnegative(),
      trippedAt: z.number().int().nullable(),
      reason: z.string().optional(),
    })
    .optional(),
  /** Orders of each employer (lowercase address) that ended with this runner's bond forfeited. */
  employerLosses: z.record(z.string(), z.number().int().nonnegative()).optional(),
  /** How many passes in a row the log read has failed at the same block. */
  discoveryFailures: z.number().int().nonnegative().optional(),
  /**
   * The settings that decided which orders were taken when the store was last used. When they
   * change, orders that were skipped under the old ones are looked at again.
   */
  policy: z.string().optional(),
  /**
   * The transaction that was sent and not yet seen mined, so that a restart neither sends the same
   * step under the next nonce nor forgets which nonce to raise the fee on.
   */
  pendingTx: z
    .strictObject({
      key: z.string(),
      label: z.string(),
      hashes: z.array(hex32).min(1),
      nonce: z.number().int().nonnegative(),
      maxFeePerGas: amount,
      maxPriorityFeePerGas: amount,
    })
    .optional(),
});
export type StoreData = z.infer<typeof StoreData>;

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

export function utcDay(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export interface Store {
  readonly data: StoreData;
  save(): void;
}

function emptyData(workOrders: string, runner: string | null): StoreData {
  return { version: 1, workOrders, runner, cursor: null, token: null, orders: {}, spend: {} };
}

/** A store that lives only in memory, for tests. */
export function memoryStore(workOrders: string, runner: string | null): Store & { saves: number } {
  const store = {
    data: emptyData(workOrders, runner),
    saves: 0,
    save() {
      // Checked against the schema, as the file store does, so a test notices a record that could
      // not be written. The object itself is kept: callers hold references into it.
      StoreData.parse(JSON.parse(JSON.stringify(store.data)));
      store.saves++;
    },
  };
  return store;
}

/**
 * Opens the store file, creating it when it does not exist. Refuses a file written for another desk
 * or another runner: mixing them would let one runner resend another's payments.
 */
export function openFileStore(path: string, workOrders: string, runner: string | null): Store {
  let data: StoreData;
  if (existsSync(path)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new StoreError(
        `${path} is not JSON. It may hold orders this runner has a bond on and signed payments that ` +
          "must not be signed again: repair it or restore a copy if you can. If you move it aside, " +
          "keep START_BLOCK and IMD_PAID_TOKEN as they were, so that held orders are found on chain " +
          "again and paid jobs are found through the protocol",
      );
    }
    const parsed = StoreData.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new StoreError(`${path} is not a runner store: ${first?.path.join(".")} ${first?.message}`);
    }
    data = parsed.data;
    if (data.workOrders.toLowerCase() !== workOrders.toLowerCase()) {
      throw new StoreError(`${path} belongs to desk ${data.workOrders}, not ${workOrders}`);
    }
    if (data.runner !== null && runner !== null && data.runner.toLowerCase() !== runner.toLowerCase()) {
      throw new StoreError(`${path} belongs to runner ${data.runner}, not ${runner}`);
    }
    if (data.runner === null) data.runner = runner;
  } else {
    data = emptyData(workOrders, runner);
  }
  const store: Store = {
    data,
    save() {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(StoreData.parse(store.data), null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
      chmodSync(path, 0o600);
    },
  };
  return store;
}

/**
 * The paid-request token: the operator's, or the one kept in the store, or a new random one. The
 * protocol asks for exactly this: "a random 32-byte secret you generate", used to read your own
 * orders back. It is not a wallet key and cannot authorise a payment.
 */
export function paidToken(store: Store, supplied: string | null): string {
  if (supplied !== null) return supplied;
  if (store.data.token === null) {
    store.data.token = randomBytes(32).toString("hex");
    store.save();
  }
  return store.data.token;
}

/** What has been reserved or spent on swarm fees on the UTC day of `now`. */
export function spentToday(store: Store, now: number): bigint {
  return BigInt(store.data.spend[utcDay(now)] ?? "0");
}

/** Adds to (or, with a negative `delta`, takes off) what was spent on a UTC day. */
export function addSpendOn(store: Store, day: string, delta: bigint): void {
  const next = BigInt(store.data.spend[day] ?? "0") + delta;
  store.data.spend[day] = (next < 0n ? 0n : next).toString();
}

export function addSpend(store: Store, now: number, delta: bigint): void {
  addSpendOn(store, utcDay(now), delta);
}
