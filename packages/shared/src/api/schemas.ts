/**
 * zod schemas for the IdentityMD control-plane routes HELP WANTED reads.
 *
 * The protocol's own guide says: "Responses on this page are excerpts. Expect extra fields." So every
 * object here is loose: the fields the product depends on are checked, anything else passes through
 * untouched. A schema failing means the protocol changed something we rely on, and the caller should
 * stop rather than guess.
 *
 * Each schema was written against a real response saved under `fixtures/api` or `fixtures/oracle`.
 */
import { z } from "zod";

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, "64 lowercase hex characters");
const hex0x64 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "0x and 64 hex characters");
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "an address");
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "a UUID");
const isoTime = z.string().min(1);
const atomicAmount = z.string().regex(/^(0|[1-9][0-9]{0,77})$/, "an amount in atomic units");
const caip2 = z.string().regex(/^eip155:[1-9][0-9]*$/, "an eip155 network");

export const primitives = { hex64, hex0x64, address, uuid, isoTime, atomicAmount, caip2 };

/** `{"error": "...", "detail"?, "reason"?, "problems"?}`: the body of every refusal. */
export const ApiErrorBody = z.looseObject({
  error: z.string(),
  detail: z.string().optional(),
  reason: z.string().optional(),
  problems: z.array(z.unknown()).optional(),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

// ---------------------------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------------------------

export const Health = z.looseObject({
  status: z.string(),
  version: z.string(),
  connectedDaemons: z.number().int().nonnegative(),
  workingNow: z.number().int().nonnegative(),
  /** Receipts waiting to be written to the WorkRegistry: the number to watch while receipts lag. */
  pendingFeedback: z.number().int().nonnegative().optional(),
  pendingOracle: z.number().int().nonnegative().optional(),
  identity: z.looseObject({ chainId: z.number().int(), collection: address, adapter: address }).optional(),
  payments: z
    .looseObject({
      enabled: z.boolean(),
      network: caip2.optional(),
      actions: z.array(z.string()).optional(),
      gasWallet: z
        .looseObject({ address, balanceEth: z.string().optional(), low: z.boolean().optional() })
        .optional(),
    })
    .optional(),
});
export type Health = z.infer<typeof Health>;

// ---------------------------------------------------------------------------------------------
// GET /requests/capabilities
// ---------------------------------------------------------------------------------------------

export const ActionPolicy = z.looseObject({
  action: z.string(),
  version: z.string(),
  payment: z.looseObject({
    network: caip2,
    asset: address,
    amount: atomicAmount,
    payTo: address,
    decimals: z.number().int().min(0).max(255),
  }),
  quoteTtlSeconds: z.number().int().positive(),
});
export type ActionPolicy = z.infer<typeof ActionPolicy>;

export const Capabilities = z.looseObject({
  actions: z.array(ActionPolicy),
  limits: z.record(z.string(), z.unknown()),
  authentication: z.looseObject({}),
  payment: z.looseObject({
    x402Version: z.number().int().optional(),
    scheme: z.string().optional(),
    assetTransferMethod: z.string().optional(),
    quoteApproval: z.string().optional(),
  }),
  onchain: z
    .looseObject({
      quoteSigner: address.optional(),
      chains: z
        .array(
          z.looseObject({
            chainId: z.number().int(),
            intake: address,
            asset: address,
            payTo: address,
            confirmations: z.number().int().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});
export type Capabilities = z.infer<typeof Capabilities>;

// ---------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------

/** States seen on real jobs. Others exist while a job is being planned; treat unknown ones as running. */
export const JOB_STATE = { completed: "completed", blocked: "blocked", executing: "executing" } as const;

const JobDelivery = z.looseObject({
  repoUrl: z.string().nullable().optional(),
  pullRequestUrl: z.string().nullable().optional(),
  commit: z.string().nullable().optional(),
  deliveredAt: isoTime.nullable().optional(),
  media: z
    .looseObject({
      cid: z.string().nullable().optional(),
      files: z.array(z.looseObject({ name: z.string(), path: z.string() })).optional(),
    })
    .nullable()
    .optional(),
});

const JobProjectRef = z.looseObject({ id: uuid });

/** One row of `GET /jobs`. The objective is truncated with an ellipsis here; read the job for all of it. */
export const JobSummary = z.looseObject({
  id: uuid,
  state: z.string(),
  template: z.string().nullable(),
  objective: z.string(),
  blockedReason: z.string().nullable().optional(),
  launchKind: z.string().nullable().optional(),
  delivery: JobDelivery.nullable().optional(),
  createdAt: isoTime,
  updatedAt: isoTime,
  project: JobProjectRef.nullable().optional(),
});
export type JobSummary = z.infer<typeof JobSummary>;

export const JobsList = z.looseObject({ count: z.number().int().nonnegative(), jobs: z.array(JobSummary) });
export type JobsList = z.infer<typeof JobsList>;

const JobSeat = z.looseObject({ tokenId: z.string(), agentId: z.string() });

export const JobNode = z.looseObject({
  key: z.string(),
  role: z.string().optional(),
  state: z.string(),
  attempt: z.number().int().optional(),
  failureReason: z.string().nullable().optional(),
  seat: JobSeat.nullable().optional(),
});
export type JobNode = z.infer<typeof JobNode>;

/** `GET /jobs/:id`. `paidBy` is the wallet that paid, lowercase, or null when nobody did. */
export const Job = z.looseObject({
  id: uuid,
  state: z.string(),
  template: z.string().nullable(),
  objective: z.string(),
  blockedReason: z.string().nullable().optional(),
  createdAt: isoTime,
  updatedAt: isoTime,
  paidBy: address.nullable().optional(),
  parentJobId: uuid.nullable().optional(),
  oracleRequestId: uuid.nullable().optional(),
  delivery: JobDelivery.nullable().optional(),
  nodes: z.array(JobNode).optional(),
  project: z
    .looseObject({
      id: uuid,
      head: uuid.nullable().optional(),
      versions: z
        .array(
          z.looseObject({ jobId: uuid, baseCommit: z.string().nullable().optional(), state: z.string() }),
        )
        .optional(),
    })
    .nullable()
    .optional(),
});
export type Job = z.infer<typeof Job>;

export const JobFile = z.looseObject({
  name: z.string(),
  path: z.string(),
  hash: hex64,
  mediaType: z.string(),
  bytes: z.number().int().nonnegative(),
  submissionHash: hex64,
  url: z.string(),
});
export type JobFile = z.infer<typeof JobFile>;

/** `GET /jobs/:id/result`. `files[].url` is `https://api.imd.fun/artifacts/<sha256>`. */
export const JobResult = z.looseObject({
  jobId: uuid,
  projectId: uuid.nullable().optional(),
  state: z.string(),
  complete: z.boolean(),
  source: z.array(z.unknown()).optional(),
  files: z.array(JobFile),
  delivery: z.looseObject({ requested: z.boolean().optional() }).nullable().optional(),
});
export type JobResult = z.infer<typeof JobResult>;

/** Statuses of a work-record receipt, as the feedback queue reports them. */
export const RECORD_STATUS = { sent: "sent", queued: "queued", failed: "failed" } as const;

export const JobRecord = z.looseObject({
  id: uuid,
  /** keccak256 of the work record, lowercase hex without `0x`. */
  hash: hex64,
  chainId: z.number().int(),
  registry: address,
  status: z.string(),
  txHash: hex0x64.nullable().optional(),
  failure: z.string().nullable().optional(),
});
export type JobRecord = z.infer<typeof JobRecord>;

/** `GET /jobs/:id/records`. */
export const JobRecords = z.looseObject({
  records: z.array(JobRecord),
  oracleBatches: z.array(z.unknown()).optional(),
});
export type JobRecords = z.infer<typeof JobRecords>;

// ---------------------------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------------------------

export const ORACLE_STATUS = {
  assessing: "assessing",
  reproducing: "reproducing",
  attested: "attested",
  disagreed: "disagreed",
  blocked: "blocked",
  mismatch: "mismatch",
  refused: "refused",
  failed: "failed",
} as const;

const PinnedWindow = z.looseObject({
  fromBlock: z.number().int().nonnegative(),
  toBlock: z.number().int().nonnegative(),
  toBlockHash: hex0x64.nullable().optional(),
});

export const OracleRequestSummary = z.looseObject({
  id: uuid,
  status: z.string(),
  question: z.string(),
  chainId: z.number().int().positive(),
  window: PinnedWindow,
  answerType: z.string(),
  jobId: uuid.nullable().optional(),
  signer: address.nullable().optional(),
  attestedAt: isoTime.nullable().optional(),
  createdAt: isoTime,
  updatedAt: isoTime,
});
export type OracleRequestSummary = z.infer<typeof OracleRequestSummary>;

/** `GET /oracle/requests`. `attester` is the oracle signer the API reports. */
export const OracleRequestsList = z.looseObject({
  count: z.number().int().nonnegative(),
  attester: address.optional(),
  requests: z.array(OracleRequestSummary),
});
export type OracleRequestsList = z.infer<typeof OracleRequestsList>;

export const OracleAttestationBody = z.looseObject({
  requestId: hex0x64,
  chainId: z.number().int().positive(),
  questionHash: hex0x64,
  answerType: z.union([z.string(), z.number().int()]),
  answer: z.string().regex(/^0x([0-9a-fA-F]{2})*$/),
  figure: z.union([z.string(), z.number()]),
  fromBlock: z.number().int().nonnegative(),
  toBlock: z.number().int().nonnegative(),
  blockHash: hex0x64,
  panelJobId: hex0x64,
  // Version 2 attestations carry the panel's numbers. Requests attested before it (September
  // 2026) are still served, without these three.
  panelSize: z.number().int().optional(),
  quorum: z.number().int().optional(),
  agreed: z.number().int().optional(),
  issuedAt: z.number().int(),
  expiresAt: z.number().int(),
});
export type OracleAttestationBody = z.infer<typeof OracleAttestationBody>;

/** `GET /oracle/requests/:id`. `definitions`, `guards`, `consumer` and `toleranceBps` are absent when unset. */
export const OracleRequest = z.looseObject({
  id: uuid,
  status: z.string(),
  question: z.string(),
  questionHash: hex0x64,
  chainId: z.number().int().positive(),
  window: PinnedWindow,
  answerType: z.string(),
  evidence: z.string().optional(),
  definitions: z.record(z.string(), z.string()).optional(),
  panelSize: z.number().int(),
  quorum: z.number().int(),
  validForSeconds: z.number().int(),
  toleranceBps: z.number().int().optional(),
  head: z.number().int().optional(),
  consumer: z.looseObject({ chainId: z.number().int(), verifyingContract: address }).optional(),
  jobId: uuid.nullable().optional(),
  attestation: OracleAttestationBody.nullable().optional(),
  signature: z.string().nullable().optional(),
  signer: address.nullable().optional(),
  failure: z.string().nullable().optional(),
  attestedAt: isoTime.nullable().optional(),
  createdAt: isoTime,
  updatedAt: isoTime,
});
export type OracleRequest = z.infer<typeof OracleRequest>;

/** `GET /oracle/requests/:id/attestation`: the typed data and signature a consumer contract checks. */
export const OracleAttestationDocument = z.looseObject({
  requestId: uuid,
  primaryType: z.string(),
  domain: z.looseObject({
    name: z.string(),
    version: z.string(),
    chainId: z.number().int(),
    verifyingContract: address,
  }),
  types: z.record(z.string(), z.array(z.looseObject({ name: z.string(), type: z.string() }))),
  message: OracleAttestationBody,
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  signer: address,
  attestedAt: isoTime.nullable().optional(),
});
export type OracleAttestationDocument = z.infer<typeof OracleAttestationDocument>;

// ---------------------------------------------------------------------------------------------
// GET /intake/:chainId/:transactionHash
// ---------------------------------------------------------------------------------------------

/**
 * The states of an Intake entry, in the order the guide lists them. `completing` means the plane
 * has decided the request (an answer is signed, or a refusal or a failure is recorded) and its
 * writer has not yet sent `complete` on chain: the callback has not been made. On 13 October 2026
 * requests were seen in that state for more than seven hours.
 */
export const INTAKE_STATE = {
  received: "received",
  paid: "paid",
  admitted: "admitted",
  completing: "completing",
  completed: "completed",
  refused: "refused",
  failed: "failed",
} as const;
export type IntakeStateName = keyof typeof INTAKE_STATE;

/** `Completed.status`, and `completion.status` of an entry: 0 an answer, 1 refused, 2 no answer. */
export const INTAKE_COMPLETION_STATUS = { answered: 0, refused: 1, noAnswer: 2 } as const;

const selector = z.string().regex(/^0x[0-9a-fA-F]{8}$/, "a four-byte selector");

/**
 * What the plane will write, or has written, on chain for a request. `state` is `queued` until the
 * writer's transaction is sent and `confirmed` once it is mined; `txHash` and `delivered` are null
 * until then. `delivered` is whether the callback ran without reverting.
 */
export const IntakeCompletion = z.looseObject({
  state: z.string().nullable().optional(),
  status: z.number().int().min(0).max(255).nullable().optional(),
  resultHash: hex0x64.nullable().optional(),
  uri: z.string().nullable().optional(),
  txHash: hex0x64.nullable().optional(),
  delivered: z.boolean().nullable().optional(),
  attempts: z.number().int().nonnegative().nullable().optional(),
  detail: z.string().nullable().optional(),
});
export type IntakeCompletion = z.infer<typeof IntakeCompletion>;

/**
 * One Intake event of a transaction. For an oracle request, `admission.result.requestId` is the
 * oracle request's UUID (not the Intake's `requestId`, which is the bytes32 `request` returned),
 * and `admission.result.attestationUrl` is where its signed answer is served.
 */
export const IntakeEntry = z.looseObject({
  logIndex: z.number().int().nonnegative(),
  blockNumber: z.number().int().nonnegative(),
  kind: z.string(),
  /** The Intake contract that logged the event: version 2, or the legacy version 1. */
  intake: address.nullable().optional(),
  state: z.string(),
  reason: z.string().nullable().optional(),
  detail: z.string().nullable().optional(),
  payer: address.nullable().optional(),
  asset: address.nullable().optional(),
  amount: atomicAmount.nullable().optional(),
  /** The Intake's id of the request. Null for an entry that is not a request (a paid quote). */
  requestId: hex0x64.nullable().optional(),
  action: z.string().nullable().optional(),
  actionVersion: z.string().nullable().optional(),
  /** keccak256 of the body bytes the plane read from the `Requested` event. */
  bodyHash: hex0x64.nullable().optional(),
  callback: z.looseObject({ target: address, selector }).nullable().optional(),
  admission: z
    .looseObject({
      result: z
        .looseObject({
          kind: z.string().optional(),
          requestId: uuid.optional(),
          jobId: uuid.optional(),
          statusUrl: z.string().optional(),
          attestationUrl: z.string().optional(),
        })
        .nullable()
        .optional(),
      createdAt: isoTime.nullable().optional(),
    })
    .nullable()
    .optional(),
  completion: IntakeCompletion.nullable().optional(),
  receivedAt: isoTime.nullable().optional(),
  updatedAt: isoTime.nullable().optional(),
});
export type IntakeEntry = z.infer<typeof IntakeEntry>;

/**
 * `GET /intake/:chainId/:transactionHash`: one entry per Intake event in the transaction. A
 * transaction can hold more than one request, so find yours by its `requestId`. The route answers
 * `404 unknown_transaction` until the plane has seen the transaction.
 */
export const IntakeRead = z.looseObject({
  chainId: z.number().int().positive(),
  transactionHash: hex0x64,
  entries: z.array(IntakeEntry),
});
export type IntakeRead = z.infer<typeof IntakeRead>;

// ---------------------------------------------------------------------------------------------
// Launches
// ---------------------------------------------------------------------------------------------

export const LaunchArtifact = z.looseObject({
  role: z.string().optional(),
  name: z.string(),
  address,
  txHash: hex0x64.nullable().optional(),
  blockNumber: z.number().int().nullable().optional(),
});

export const LaunchSummary = z.looseObject({
  id: uuid,
  launchNumber: z.number().int().positive().nullable(),
  kind: z.string().nullable().optional(),
  status: z.string(),
  chainId: z.number().int().nullable().optional(),
  sourceRepoUrl: z.string().nullable().optional(),
  sourceCommit: z.string().nullable().optional(),
  parkedReason: z.string().nullable().optional(),
  artifacts: z.array(LaunchArtifact).optional(),
  createdAt: isoTime.optional(),
  updatedAt: isoTime.optional(),
});
export type LaunchSummary = z.infer<typeof LaunchSummary>;

/** `GET /launches`. */
export const LaunchesList = z.looseObject({
  count: z.number().int().nonnegative(),
  launches: z.array(LaunchSummary),
});
export type LaunchesList = z.infer<typeof LaunchesList>;

/** `GET /launches/:id`: only the fields common with the list row are checked. */
export const Launch = LaunchSummary;
export type Launch = z.infer<typeof Launch>;

// ---------------------------------------------------------------------------------------------
// POST /requests/check (free preflight)
// ---------------------------------------------------------------------------------------------

/**
 * What a quote would say, with no token and no price held. `blockers` must be empty before a runner
 * spends anything. A job adds `kind`, `plan`, `facts` and `judged`.
 */
export const CheckResult = z.looseObject({
  action: z.string(),
  blockers: z.array(z.unknown()),
  suggestions: z.array(z.unknown()).optional(),
  kind: z.string().optional(),
  plan: z.unknown().optional(),
});
export type CheckResult = z.infer<typeof CheckResult>;

// ---------------------------------------------------------------------------------------------
// GET /requests/paid-by/:address (public)
// ---------------------------------------------------------------------------------------------

/**
 * One order a wallet paid, or tried to pay, for. `result` is the admission result: for a job it
 * names the `jobId`. The input and the signatures are never listed, so which order a job belongs
 * to has to be told from the job itself (`GET /jobs/:id` gives its objective).
 */
export const PaidByOrder = z.looseObject({
  orderId: uuid,
  action: z.string(),
  status: z.string(),
  createdAt: isoTime,
  paidAt: isoTime.nullable().optional(),
  payment: z
    .looseObject({
      status: z.string().nullable().optional(),
      transactionHash: z.string().nullable().optional(),
      reason: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  result: z.looseObject({ kind: z.string().optional(), jobId: uuid.optional() }).nullable().optional(),
});
export type PaidByOrder = z.infer<typeof PaidByOrder>;

/** `GET /requests/paid-by/:address`: newest first, at most 100. Meant for a caller who lost its token. */
export const PaidByList = z.looseObject({
  payer: address,
  count: z.number().int().nonnegative(),
  orders: z.array(PaidByOrder),
});
export type PaidByList = z.infer<typeof PaidByList>;

// ---------------------------------------------------------------------------------------------
// Paid requests: quote, challenge, status (see openapi.json `components.schemas`)
// ---------------------------------------------------------------------------------------------

export const PAID_ACTIONS = [
  "job.open",
  "job.continue",
  "launch.open",
  "oracle.request",
  "workflow.open",
  "schedule.create",
  "schedule.topup",
] as const;
export type PaidAction = (typeof PAID_ACTIONS)[number];

/**
 * The priced terms a wallet approves. Strict, unlike the read schemas: this object is hashed into
 * `quoteHash` by the server and its fields go into the signed `QuoteApproval`, so a field we do not
 * know is a reason to stop, not to carry on.
 */
export const Quote = z.strictObject({
  v: z.literal(1),
  id: uuid,
  action: z.string().min(1).max(64),
  policyVersion: z.string().min(1).max(64),
  inputHash: hex64,
  issuedAt: z.number().int().nonnegative(),
  /** Unix seconds. */
  expiresAt: z.number().int().nonnegative(),
  payment: z.strictObject({
    network: caip2,
    asset: z.string().regex(/^0x[0-9a-f]{40}$/),
    amount: atomicAmount,
    payTo: z.string().regex(/^0x[0-9a-f]{40}$/),
    decimals: z.number().int().min(0).max(255),
    scheme: z.literal("exact"),
  }),
  unitAmount: atomicAmount.optional(),
  runs: z.number().int().positive().optional(),
  payer: z
    .string()
    .regex(/^0x[0-9a-f]{40}$/)
    .optional(),
  terms: z.strictObject({
    purchase: z.literal("action-admission"),
    resultGuaranteed: z.literal(false),
  }),
  quoteHash: hex64,
});
export type Quote = z.infer<typeof Quote>;

export const ORDER_STATUS = ["quoted", "expired", "payment_pending", "payment_failed", "paid"] as const;

export const PaidOrder = z.looseObject({
  id: uuid,
  requestKey: uuid,
  status: z.enum(ORDER_STATUS),
  quote: Quote,
  /** The prepared input as the server saved it. It may differ from what was sent. */
  inputJson: z.string(),
  createdAt: z.string(),
  paidAt: z.string().nullable(),
});
export type PaidOrder = z.infer<typeof PaidOrder>;

/** `POST /requests/quote`: 201 for a new order, 200 for the same key and input again. */
export const QuoteResponse = z.looseObject({ created: z.boolean(), order: PaidOrder });
export type QuoteResponse = z.infer<typeof QuoteResponse>;

/** One entry of an x402 v2 challenge's `accepts`. */
export const PaymentRequirements = z.looseObject({
  scheme: z.string(),
  network: z.string(),
  asset: z.string(),
  amount: z.string().regex(/^[0-9]+$/),
  payTo: z.string(),
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type PaymentRequirements = z.infer<typeof PaymentRequirements>;

/** The JSON body of the 402 answer to an empty `POST /requests/:id/submit`. */
export const Challenge = z.looseObject({
  x402Version: z.literal(2),
  resource: z.looseObject({
    url: z.string(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
  }),
  accepts: z.array(PaymentRequirements).min(1),
  quote: Quote,
  requesterScopeHash: hex64,
  resourceUrl: z.string().url(),
  /** The exact prepared input saved with this quote. Inspect it before signing. */
  input: z.unknown(),
});
export type Challenge = z.infer<typeof Challenge>;

export const REQUEST_STATUS = [
  "quoted",
  "expired",
  "payment_pending",
  "payment_failed",
  "admission_pending",
  "admitted",
] as const;
export type RequestStatusName = (typeof REQUEST_STATUS)[number];

/** `admission.result` for `job.open`. A refusal has `kind: "refused"` and `problems`. */
export const AdmissionResult = z.looseObject({
  kind: z.string(),
  jobId: uuid.optional(),
  launch: z.boolean().optional(),
  statusUrl: z.string().optional(),
  resultUrl: z.string().optional(),
  problems: z.array(z.unknown()).optional(),
});
export type AdmissionResult = z.infer<typeof AdmissionResult>;

/** `GET /requests/:id`, and the 200/202 answers of a paid submit. */
export const RequestStatus = z.looseObject({
  status: z.enum(REQUEST_STATUS),
  order: z.looseObject({ id: uuid, status: z.string() }),
  payment: z
    .looseObject({
      status: z.string().optional(),
      paid: z.boolean().optional(),
      transactionHash: z.string().nullable().optional(),
    })
    .nullable(),
  admission: z
    .looseObject({ action: z.string().optional(), result: AdmissionResult.nullable().optional() })
    .nullable(),
});
export type RequestStatus = z.infer<typeof RequestStatus>;
