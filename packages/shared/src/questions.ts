/**
 * Standing Questions (launch A's `Questions` contract): its enums, its fixed waits, the three house
 * feeds, and the feed id.
 *
 * The house feeds come from `src/generated/houseFeeds.ts`, which a generator copies from the launch
 * project's own fixture files (`pnpm --filter @help-wanted/shared feeds:gen`); nothing about their
 * text or parameters is typed here. A feed's body and question hash for a block window are built
 * with the same two byte strings the contract stores:
 *
 *   body         = qPrefix ‖ dec(fromBlock) ‖ ',"toBlock":' ‖ dec(toBlock) ‖ '}' ‖ tail
 *   questionHash = keccak256(qPrefix ‖ dec(fromBlock) ‖ ',"toBlock":' ‖ dec(toBlock) ‖ '}}')
 */
import {
  encodeAbiParameters,
  getAddress,
  hexToString,
  keccak256,
  stringToHex,
  type AbiParameter,
  type Address,
  type Hex,
} from "viem";
import { questionsAbi } from "./abi/generated/questions.js";
import { sameAddress } from "./addresses.js";
import { HOUSE_FEED_DATA } from "./generated/houseFeeds.js";
import {
  ANSWER_TYPES,
  assembleOracleBody,
  questionHashFromPrefix,
  type AnswerType,
  type BlockWindow,
} from "./oracle.js";

/** `IQuestions.RoundStatus`, in declaration order. */
export const ROUND_STATUS = { None: 0, Pending: 1, Answered: 2, Failed: 3 } as const;
export type RoundStatusName = keyof typeof ROUND_STATUS;

/** `Questions.Blocker`: why `request` cannot be made right now, as `canRequest` reports it. */
export const REQUEST_BLOCKER = {
  None: 0,
  UnknownFeed: 1,
  AlreadyAskedThisTransaction: 2,
  RoundPending: 3,
  TooSoon: 4,
  NoBlocks: 5,
  GateClosed: 6,
  NotSold: 7,
  PriceAboveCap: 8,
  MeterTooLow: 9,
} as const;
export type RequestBlockerName = keyof typeof REQUEST_BLOCKER;

/** `Questions.AbandonStep`: what `abandon` would do now, as `canAbandon` reports it. */
export const ABANDON_STEP = {
  /** Nothing: no round is pending, or it is too early and the call would revert. */
  Wait: 0,
  /** The call records that the Intake completed the request and starts the thirty minutes. */
  StartWait: 1,
  /** The call closes the round as failed. */
  Close: 2,
} as const;
export type AbandonStepName = keyof typeof ABANDON_STEP;

function nameOf<T extends Record<string, number>>(table: T, code: number, what: string): keyof T {
  for (const [name, value] of Object.entries(table)) if (value === code) return name;
  throw new RangeError(`unknown ${what} ${code}`);
}

export function roundStatusName(code: number): RoundStatusName {
  return nameOf(ROUND_STATUS, code, "round status");
}

/** How an answered round got its answer. */
export type AnswerDelivery = "callback" | "submit";

/**
 * How the answer of an answered round reached `Questions`, from `RoundAnswered.deliveredBy`: the
 * Intake the contract is built on delivers through its callback (`onOracleResult`); any other
 * address handed the signed answer in with `submit`. `intake` is the contract's own `INTAKE()`.
 */
export function answerDelivery(deliveredBy: string, intake: string): AnswerDelivery {
  return sameAddress(deliveredBy, intake) ? "callback" : "submit";
}

export function requestBlockerName(code: number): RequestBlockerName {
  return nameOf(REQUEST_BLOCKER, code, "request blocker");
}

export function abandonStepName(code: number): AbandonStepName {
  return nameOf(ABANDON_STEP, code, "abandon step");
}

/**
 * The waits fixed in `Questions` at launch, in seconds. They are constants of the deployed
 * bytecode; anything that acts on them reads them from the contract (`SUBMIT_AFTER_SILENCE()` and
 * so on) and uses these only to say what to expect.
 */
export const QUESTIONS_WAITS = {
  /** `submit` opens this long after a request the Intake has still not completed. */
  SUBMIT_AFTER_SILENCE: 1_800,
  /** A round whose Intake request is completed can be closed this long after `abandon` first saw it. */
  ABANDON_AFTER_COMPLETED: 1_800,
  /**
   * How long the oracle is given to sign before a silent round can be closed. Since the launch
   * pipeline adapted launch A (13 Oct 2026) this is only the first part of the wait: see
   * `silenceSeconds`.
   */
  ABANDON_AFTER_SILENCE: 43_200,
  /** How far ahead of the chain's clock an attestation's `issuedAt` may be. */
  ISSUED_AT_TOLERANCE: 300,
} as const;

/**
 * How long after its request any pending round can be closed, whatever the Intake says:
 * `ABANDON_AFTER_SILENCE` for the oracle to sign, then the validity the feed asks of an answer
 * (`FeedParams.validFor`), the signing-clock tolerance, and one second because an answer's expiry
 * is inclusive. This mirrors `Questions._abandonStep`; `canAbandon(feedId)` reports the moment
 * itself as `closableAt`, and anything that acts reads it there. For the three house feeds
 * (`validFor` one day) it is 129,901 seconds: 36 hours, 5 minutes and one second.
 */
export function silenceSeconds(validFor: number | bigint): bigint {
  return (
    BigInt(QUESTIONS_WAITS.ABANDON_AFTER_SILENCE) +
    BigInt(validFor) +
    BigInt(QUESTIONS_WAITS.ISSUED_AT_TOLERANCE) +
    1n
  );
}

/** `Questions.FeedParams`, with amounts as bigint. */
export interface FeedParams {
  action: Hex;
  chainId: bigint;
  answerType: number;
  panelSize: number;
  quorum: number;
  minAgreed: number;
  validFor: number;
  cadenceBlocks: number;
  maxWindowBlocks: number;
  lagBlocks: number;
  contiguous: boolean;
  pinHash: boolean;
  maxPrice: bigint;
  tip: bigint;
  gateCmp: number;
  gateTarget: Address;
  gateThreshold: bigint;
  gateData: Hex;
}

export const HOUSE_FEED_NAMES = ["payrolls", "hires", "employers"] as const;
export type HouseFeedName = (typeof HOUSE_FEED_NAMES)[number];

export interface HouseFeed {
  name: HouseFeedName;
  title: string;
  /** `keccak256(abi.encode(params, keccak256(qPrefix), keccak256(tail)))`. */
  id: Hex;
  params: FeedParams;
  /** The canonical question document up to and including `"window":{"fromBlock":`, as bytes. */
  qPrefix: Hex;
  /** The rest of the body after the window's closing brace, as bytes. */
  tail: Hex;
  qPrefixText: string;
  tailText: string;
  answerType: AnswerType;
  /** "panel" when the question is judged by the panel's agreement and not recomputed by the oracle. */
  evidence: "chain" | "panel";
  /**
   * Whether `Questions.submit` is open to this feed at all: it pins its question and is not judged
   * by a panel. When false, only the Intake's own callback can answer a round.
   */
  submit: boolean;
  /** Which of Payroll's three feed slots it is: `FEED_A` and `FEED_B` are served first. */
  payrollSlot: "A" | "B" | "C";
  /** How many requests Payroll keeps on the feed's meter: 14 for the daily feeds, 4 for the weekly. */
  runwayRequests: number;
}

const PANEL_EVIDENCE = '"evidence":"panel"';

/**
 * Whether a question prefix holds `"evidence":"panel"`, the test `Questions` applies when a feed is
 * created (`QuestionBody.holdsPanelEvidence`). Takes the prefix as bytes or as text.
 */
export function holdsPanelEvidence(qPrefix: Hex | string): boolean {
  const text = /^0x([0-9a-fA-F]{2})*$/.test(qPrefix) ? hexToString(qPrefix as Hex) : qPrefix;
  return text.includes(PANEL_EVIDENCE);
}

const SLOTS = { payrolls: "A", hires: "B", employers: "C" } as const;

function build(name: HouseFeedName): HouseFeed {
  const data = HOUSE_FEED_DATA[name];
  const p = data.params;
  const answerType = ANSWER_TYPES[p.answerType];
  if (answerType === undefined) throw new RangeError(`${name}: unknown answer type ${p.answerType}`);
  const panel = holdsPanelEvidence(data.qPrefix);
  return {
    name,
    title: data.title,
    id: data.feedId as Hex,
    params: {
      action: p.action as Hex,
      chainId: BigInt(p.chainId),
      answerType: p.answerType,
      panelSize: p.panelSize,
      quorum: p.quorum,
      minAgreed: p.minAgreed,
      validFor: p.validFor,
      cadenceBlocks: p.cadenceBlocks,
      maxWindowBlocks: p.maxWindowBlocks,
      lagBlocks: p.lagBlocks,
      contiguous: p.contiguous,
      pinHash: p.pinHash,
      maxPrice: BigInt(p.maxPrice),
      tip: BigInt(p.tip),
      gateCmp: p.gateCmp,
      gateTarget: getAddress(p.gateTarget),
      gateThreshold: BigInt(p.gateThreshold),
      gateData: p.gateData as Hex,
    },
    qPrefix: data.qPrefixHex as Hex,
    tail: data.tailHex as Hex,
    qPrefixText: data.qPrefix,
    tailText: data.tail,
    answerType,
    evidence: panel ? "panel" : "chain",
    submit: p.pinHash && !panel,
    payrollSlot: SLOTS[name],
    runwayRequests: name === "employers" ? 4 : 14,
  };
}

/** The three house feeds of launch A, keyed by name, in Payroll's order A, B, C. */
export const HOUSE_FEEDS: Readonly<Record<HouseFeedName, HouseFeed>> = {
  payrolls: build("payrolls"),
  hires: build("hires"),
  employers: build("employers"),
};

export function isHouseFeedName(value: string): value is HouseFeedName {
  return (HOUSE_FEED_NAMES as readonly string[]).includes(value);
}

/** The house feed with this id, in any letter case, or undefined. */
export function houseFeedById(feedId: string): HouseFeed | undefined {
  const wanted = feedId.toLowerCase();
  return HOUSE_FEED_NAMES.map((name) => HOUSE_FEEDS[name]).find((feed) => feed.id.toLowerCase() === wanted);
}

function createFeedInputs(): readonly AbiParameter[] {
  for (const item of questionsAbi) {
    if (item.type === "function" && item.name === "createFeed") return item.inputs;
  }
  throw new Error("the Questions ABI has no createFeed");
}

/**
 * The id a feed with these parts has, whether or not it exists: what `Questions.feedIdOf` returns.
 * The struct's layout is taken from the compiled ABI of `createFeed`, not written again here.
 */
export function feedIdOf(params: FeedParams, qPrefix: Hex, tail: Hex): Hex {
  const tuple = createFeedInputs()[0];
  if (tuple === undefined) throw new Error("createFeed takes no parameters");
  return keccak256(
    encodeAbiParameters(
      [tuple, { type: "bytes32" }, { type: "bytes32" }],
      [params, keccak256(qPrefix), keccak256(tail)],
    ),
  );
}

/** The exact body text `Questions` sends to the Intake for one window of a feed. */
export function feedBody(feed: Pick<HouseFeed, "qPrefixText" | "tailText">, window: BlockWindow): string {
  return assembleOracleBody({ qPrefix: feed.qPrefixText, tail: feed.tailText }, window);
}

/** The same body as the bytes that travel in the Intake's `Requested` event. */
export function feedBodyHex(feed: Pick<HouseFeed, "qPrefixText" | "tailText">, window: BlockWindow): Hex {
  return stringToHex(feedBody(feed, window));
}

/** The question hash an answer to that window must carry: what the contract pins. */
export function feedQuestionHash(feed: Pick<HouseFeed, "qPrefixText">, window: BlockWindow): Hex {
  return questionHashFromPrefix(feed.qPrefixText, window);
}
