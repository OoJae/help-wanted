/**
 * Questions, the Standing Questions contract (launch A): feeds and the rounds each feed buys.
 *
 * Launched on mainnet on 13 October 2026, so its events are final. The module decodes them with the
 * ABI the shared package generates from the launch project's build output, and folds them as below.
 * Columns follow `IQuestions.sol`: a round's status is `IQuestions.RoundStatus`, its answer is the
 * one word `latest`/`roundOf` return, and a feed's meter totals are what `fund`, `defund` and
 * `request` move.
 *
 *   FeedCreated    → insert `feeds` (creator, params, question prefix and tail)
 *   Funded         → `feeds.funded += amount`
 *   FundedFor      → the same, with the shares going to a beneficiary (`fundFor`)
 *   Defunded       → `feeds.defunded += amount`
 *   RoundOpened    → insert `rounds` (window, question hash, Intake request id, price, tip, keeper;
 *                    status Pending); `feeds.rounds`, `feeds.spent += price + tip`
 *   RoundAnswered  → `rounds` value, oracle request id, agreement, delivered by; status Answered;
 *                    `feeds.latest_round`, `feeds.latest_value`, `feeds.latest_time`
 *   RoundFailed    → status Failed; `feeds.spent -= tip`, because the tip of a round that is closed
 *                    without an answer goes back onto the meter
 *   AnswerRevealed → `rounds.answer` (the list behind a list-typed answer)
 *
 * Kept in `events` and folded into no table (`KEPT`): `CompletionSeen` (the Intake's completion was
 * noticed and the round can be closed from a given time), `SharesRetired` and `SharesRescaled`
 * (bookkeeping of a meter's shares), `TipsCollected` (a keeper took out tips it had earned),
 * `OracleSignerSet` and `EIP712DomainChanged` (emitted once, by the constructor).
 *
 * The tip of an answered round is always credited to `rounds.keeper`, the keeper that opened it,
 * whoever `delivered_by` is: `submit` earns nothing. That is the contract as launched.
 *
 * A round's `intake_request_id` is the key of `intake_requests`, where the body bytes and the
 * Intake's own verdict are; joining the two is how a page shows a round end to end.
 */
import { and, eq, sql } from "drizzle-orm";
import { index, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { z } from "zod";
import { questionsAbi } from "@help-wanted/shared";
import { int53, numeric, wei } from "../../db/columns.js";
import { address, bytes32, hex, parseArgs, smallUint, uint } from "../../engine/args.js";
import { isStorableJson, type JsonValue } from "../../json.js";
import { launchedModule } from "./stub.js";

/** `IQuestions.RoundStatus`, in the contract's order. */
export const ROUND_STATUSES = ["None", "Pending", "Answered", "Failed"] as const;
export type RoundStatus = (typeof ROUND_STATUSES)[number];

export const feeds = pgTable(
  "feeds",
  {
    /** `bytes32`. */
    feedId: text("feed_id").primaryKey(),
    creator: text("creator").notNull(),
    /** The feed's parameters exactly as its creation event carried them. */
    params: jsonb("params").$type<JsonValue>(),
    /** The fixed parts of the request body, hex: what comes before and after the block window. */
    questionPrefix: text("question_prefix"),
    questionTail: text("question_tail"),
    /** Rounds opened so far, answered or not. */
    rounds: int53("rounds").notNull(),
    latestRound: int53("latest_round"),
    /** The newest answer as one word (see `IQuestions.latest` for what it means per answer type). */
    latestValue: wei("latest_value"),
    latestTime: int53("latest_time"),
    /** Meter totals: IMD put in, taken back out, and spent on requests and keeper tips. */
    funded: wei("funded").notNull(),
    defunded: wei("defunded").notNull(),
    spent: wei("spent").notNull(),

    createdBlock: int53("created_block").notNull(),
    createdTime: int53("created_time").notNull(),
    createdTx: text("created_tx").notNull(),
    updatedBlock: int53("updated_block").notNull(),
    updatedTime: int53("updated_time").notNull(),
  },
  (t) => [index("feeds_creator_idx").on(t.creator)],
);

export const rounds = pgTable(
  "rounds",
  {
    feedId: text("feed_id").notNull(),
    /** Counts from 1. */
    round: int53("round").notNull(),
    status: text("status").$type<RoundStatus>().notNull(),
    /** The Intake's id for the request this round bought. */
    intakeRequestId: text("intake_request_id").notNull(),
    /** The attestation's request id (the oracle request's UUID, left-aligned), once answered. */
    oracleRequestId: text("oracle_request_id"),
    /** The block window the question was asked about. */
    fromBlock: int53("from_block").notNull(),
    toBlock: int53("to_block").notNull(),
    questionHash: text("question_hash").notNull(),
    /** The closing block's hash as the contract saw it; zero when it was too old to read. */
    windowBlockHash: text("window_block_hash"),
    /** What the round cost the meter: the Intake's price and the keeper's tip. */
    price: wei("price").notNull(),
    tip: wei("tip").notNull(),
    keeper: text("keeper"),
    /** The answer as one word; null until answered. */
    value: wei("value"),
    /** How many panel members agreed, when the answer says. */
    agreed: int53("agreed"),
    /** Who handed the answer in: the Intake, or whoever called `submit`. */
    deliveredBy: text("delivered_by"),
    /** The list behind a list-typed answer, hex, once somebody published it. */
    answer: text("answer"),

    openedBlock: int53("opened_block").notNull(),
    openedTime: int53("opened_time").notNull(),
    openedTx: text("opened_tx").notNull(),
    closedBlock: int53("closed_block"),
    closedTime: int53("closed_time"),
    closedTx: text("closed_tx"),
  },
  (t) => [
    primaryKey({ columns: [t.feedId, t.round] }),
    index("rounds_intake_idx").on(t.intakeRequestId),
    index("rounds_opened_idx").on(t.openedBlock),
  ],
);

const FeedCreated = z.object({
  feedId: bytes32,
  creator: address,
  params: z.record(z.string(), z.unknown()),
  qPrefix: hex,
  tail: hex,
});
const Funded = z.object({ feedId: bytes32, amount: uint });
const Defunded = z.object({ feedId: bytes32, amount: uint });
const RoundOpened = z.object({
  feedId: bytes32,
  round: smallUint,
  intakeRequestId: bytes32,
  fromBlock: smallUint,
  toBlock: smallUint,
  questionHash: bytes32,
  blockHash: bytes32,
  price: uint,
  tip: uint,
  keeper: address,
});
const RoundAnswered = z.object({
  feedId: bytes32,
  round: smallUint,
  oracleRequestId: bytes32,
  value: uint,
  agreed: smallUint,
  deliveredBy: address,
});
const RoundFailed = z.object({ feedId: bytes32, round: smallUint });
const AnswerRevealed = z.object({ feedId: bytes32, round: smallUint, answer: hex });

/** The events the handler writes into `feeds` or `rounds`. */
export const QUESTIONS_FOLDED = [
  "FeedCreated",
  "Funded",
  "FundedFor",
  "Defunded",
  "RoundOpened",
  "RoundAnswered",
  "RoundFailed",
  "AnswerRevealed",
] as const;

/** The events that are stored in `events` and go no further; the header says why for each. */
export const QUESTIONS_KEPT = [
  "CompletionSeen",
  "SharesRetired",
  "SharesRescaled",
  "TipsCollected",
  "OracleSignerSet",
  "EIP712DomainChanged",
] as const;

export const questionsModule = launchedModule({
  name: "questions",
  title: "Questions: feeds and rounds",
  contract: "questions",
  abi: questionsAbi,
  tables: [feeds, rounds],
  folded: QUESTIONS_FOLDED,
  kept: QUESTIONS_KEPT,
  async apply(db, event) {
    const touched = { updatedBlock: event.blockNumber, updatedTime: event.blockTime };
    switch (event.event) {
      case "FeedCreated": {
        const args = parseArgs(FeedCreated, event);
        const params = args.params as JsonValue;
        const row = {
          creator: args.creator,
          params: isStorableJson(params) ? params : null,
          questionPrefix: args.qPrefix,
          questionTail: args.tail,
          rounds: 0,
          funded: 0n,
          defunded: 0n,
          spent: 0n,
          createdBlock: event.blockNumber,
          createdTime: event.blockTime,
          createdTx: event.txHash,
          ...touched,
        };
        // A feed is created once: its id is the hash of its parameters and text, and the contract
        // refuses a second `createFeed` for the same id.
        await db
          .insert(feeds)
          .values({ feedId: args.feedId, ...row })
          .onConflictDoNothing();
        return;
      }
      case "Funded":
      case "FundedFor": {
        const args = parseArgs(Funded, event);
        await db
          .update(feeds)
          .set({ funded: sql`${feeds.funded} + ${numeric(args.amount)}`, ...touched })
          .where(eq(feeds.feedId, args.feedId));
        return;
      }
      case "Defunded": {
        const args = parseArgs(Defunded, event);
        await db
          .update(feeds)
          .set({ defunded: sql`${feeds.defunded} + ${numeric(args.amount)}`, ...touched })
          .where(eq(feeds.feedId, args.feedId));
        return;
      }
      case "RoundOpened": {
        const args = parseArgs(RoundOpened, event);
        await db
          .insert(rounds)
          .values({
            feedId: args.feedId,
            round: args.round,
            status: "Pending",
            intakeRequestId: args.intakeRequestId,
            fromBlock: args.fromBlock,
            toBlock: args.toBlock,
            questionHash: args.questionHash,
            windowBlockHash: args.blockHash,
            price: args.price,
            tip: args.tip,
            keeper: args.keeper,
            openedBlock: event.blockNumber,
            openedTime: event.blockTime,
            openedTx: event.txHash,
          })
          .onConflictDoNothing();
        await db
          .update(feeds)
          .set({
            rounds: sql`greatest(${feeds.rounds}, ${args.round})`,
            spent: sql`${feeds.spent} + ${numeric(args.price + args.tip)}`,
            ...touched,
          })
          .where(eq(feeds.feedId, args.feedId));
        return;
      }
      case "RoundAnswered": {
        const args = parseArgs(RoundAnswered, event);
        await db
          .update(rounds)
          .set({
            status: "Answered",
            value: args.value,
            oracleRequestId: args.oracleRequestId,
            agreed: args.agreed,
            deliveredBy: args.deliveredBy,
            closedBlock: event.blockNumber,
            closedTime: event.blockTime,
            closedTx: event.txHash,
          })
          .where(and(eq(rounds.feedId, args.feedId), eq(rounds.round, args.round)));
        await db
          .update(feeds)
          .set({
            latestRound: args.round,
            latestValue: args.value,
            latestTime: event.blockTime,
            ...touched,
          })
          .where(eq(feeds.feedId, args.feedId));
        return;
      }
      case "RoundFailed": {
        const args = parseArgs(RoundFailed, event);
        const [closed] = await db
          .update(rounds)
          .set({
            status: "Failed",
            closedBlock: event.blockNumber,
            closedTime: event.blockTime,
            closedTx: event.txHash,
          })
          .where(and(eq(rounds.feedId, args.feedId), eq(rounds.round, args.round)))
          .returning({ tip: rounds.tip });
        // The price is spent either way; the tip that was set aside goes back onto the meter.
        await db
          .update(feeds)
          .set({ spent: sql`${feeds.spent} - ${numeric(closed?.tip ?? 0n)}`, ...touched })
          .where(eq(feeds.feedId, args.feedId));
        return;
      }
      case "AnswerRevealed": {
        const args = parseArgs(AnswerRevealed, event);
        await db
          .update(rounds)
          .set({ answer: args.answer })
          .where(and(eq(rounds.feedId, args.feedId), eq(rounds.round, args.round)));
        return;
      }
      default:
        // One of `QUESTIONS_KEPT`, or a log the ABI does not know: it is in `events`.
        return;
    }
  },
});
