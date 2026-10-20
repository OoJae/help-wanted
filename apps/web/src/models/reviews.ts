/**
 * A seat's reviews in the ERC-8004 Reputation Registry, read live, each kind filtered by who gave it
 * (the registry's answer to fake reviewers is a list of clients you trust):
 *
 * 1. IdentityMD's own, first: its WorkRegistry writes one with each receipt, value 1 when its
 *    verifier accepted the work, under the evidence category in tag1.
 * 2. Ours: for each order on our hire desk that the seat's agent did, the entries from the wallet
 *    that paid for the order's swarm job, carrying our tags. Each was given with a feedback file on
 *    this site whose `proofOfPayment` names that x402 payment (`config/erc8004.ts`).
 *
 * The registry's storage holds an entry's value, tags and whether it was revoked. The file an entry
 * names is only in its `NewFeedback` log, so ours are checked against their file while the RPC still
 * serves that log, and said to be unchecked after.
 */
import { decodeEventLog, numberToHex, pad, type Hex } from "viem";
import { MAINNET } from "@help-wanted/shared";
import { etherscanAddress, etherscanTx } from "~/config/chain";
import { ERC8004, pinnedReviews, reputationRegistryAbi } from "~/config/erc8004";
import { HOUSE_WALLETS, houseSet } from "~/config/house";
import type { Sources } from "~/data";
import { messageOf } from "~/lib/cache";
import { formatUnits, shortAddress } from "~/lib/format";
import type { RawLog } from "~/lib/jsonrpc";
import type { ViewCall, ViewResult } from "~/lib/multicall";
import { castCall } from "./common";
import { sourceNote, type SourceNote } from "./types";

/** IdentityMD's reviews of one agent, counted by evidence category (tag1). */
export interface ImdReviews {
  agentId: string;
  total: number;
  /** One row per category, most reviews first. `accepted` counts the entries with value 1. */
  categories: { category: string; count: number; accepted: number }[];
  error: string | null;
}

export interface SeatReview {
  orderId: number;
  agentId: string;
  /** The wallet that gave it, as the registry returns it. */
  client: string;
  /** "H1" for a wallet of ours, the short address for any other. */
  clientName: string;
  origin: "HOUSE" | "OUTSIDE";
  /** The entry's number among this client's reviews of the agent, from 1. */
  index: number;
  /** The value with its decimals applied, as the registry holds it. */
  value: string;
  tags: string;
  revoked: boolean;
  fileUrl: string;
  paymentTxUrl: string;
  settlementTxUrl: string;
  /** What the entry's `NewFeedback` log names, while the RPC serves it; null after. */
  log: { txUrl: string; matches: boolean } | null;
}

export interface SeatReviews {
  registry: string;
  registryUrl: string;
  /** IdentityMD's WorkRegistry, the client its own reviews come from. */
  imdClient: string;
  imdClientUrl: string;
  imd: ImdReviews[];
  /** Ours. Null when none of the seat's agents did an order on record here. */
  ours: {
    entries: SeatReview[];
    /** Reviews written for this seat's agents that the registry does not hold yet. Empty when unread. */
    waiting: { orderId: number; agentId: string; fileUrl: string }[];
    error: string | null;
  } | null;
}

/** What the section is, in the words both twins of the seat page use. */
export const SEAT_REVIEWS_NOTE =
  "IdentityMD's WorkRegistry gives one with each receipt: value 1 when its verifier accepted the work. Ours come from the wallet that paid for a desk order's swarm job and name a feedback file whose proofOfPayment is that x402 payment, beside the receipt and the desk's settlement. In both, 1 says accepted or paid on proof, not how good the work is.";

type Row = readonly [
  readonly string[],
  readonly bigint[],
  readonly bigint[],
  readonly number[],
  readonly string[],
  readonly string[],
  readonly boolean[],
];

interface FeedbackLog {
  agentId: string;
  client: string;
  index: number;
  uri: string;
  hash: Hex;
  tx: string;
}

function decodeLogs(logs: readonly RawLog[]): FeedbackLog[] {
  return logs.flatMap((log) => {
    try {
      const { args } = decodeEventLog({
        abi: reputationRegistryAbi,
        eventName: "NewFeedback",
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      });
      return [
        {
          agentId: args.agentId.toString(),
          client: args.clientAddress.toLowerCase(),
          index: Number(args.feedbackIndex),
          uri: args.feedbackURI,
          hash: args.feedbackHash,
          tx: log.transactionHash,
        },
      ];
    } catch {
      return [];
    }
  });
}

const READ_ALL =
  "readAllFeedback(uint256,address[],string,string,bool)(address[],uint64[],int128[],uint8[],string[],string[],bool[])";

function readAll(
  agentId: string,
  client: string,
  tag1: string,
  tag2: string,
  includeRevoked: boolean,
): ViewCall {
  return {
    to: ERC8004.reputationRegistry,
    abi: reputationRegistryAbi,
    functionName: "readAllFeedback",
    args: [BigInt(agentId), [client], tag1, tag2, includeRevoked],
  };
}

function rowOf(
  result: ViewResult | undefined,
  fallback: string | null,
): { row: Row | null; error: string | null } {
  if (!result) return { row: null, error: fallback ?? "not read" };
  return result.ok ? { row: result.value as Row, error: null } : { row: null, error: result.error };
}

function imdReviews(agentId: string, result: ViewResult | undefined, fallback: string | null): ImdReviews {
  const { row, error } = rowOf(result, fallback);
  const categories = new Map<string, { category: string; count: number; accepted: number }>();
  if (row) {
    row[4].forEach((category, j) => {
      const at = categories.get(category) ?? { category, count: 0, accepted: 0 };
      at.count += 1;
      if (row[2][j] === 1n && row[3][j] === 0) at.accepted += 1;
      categories.set(category, at);
    });
  }
  return {
    agentId,
    total: row ? row[0].length : 0,
    categories: [...categories.values()].sort((a, b) => b.count - a.count),
    error,
  };
}

/**
 * Reads the reviews of the seat's agents. Null when the seat has no agent this site knows of.
 * Never throws: a read that fails is said in the section.
 */
export async function loadSeatReviews(
  sources: Sources,
  agentIds: readonly string[],
): Promise<{
  reviews: SeatReviews | null;
  source: SourceNote | null;
  commands: { comment: string; command: string }[];
}> {
  const first = agentIds[0];
  if (first === undefined) return { reviews: null, source: null, commands: [] };
  const { chain } = sources;
  const registry = ERC8004.reputationRegistry;
  const imdClient = MAINNET.WORK_REGISTRY;
  const records = pinnedReviews(sources.deployments.contracts.workOrders.address, agentIds);
  const calls = [
    ...agentIds.map((agentId) => readAll(agentId, imdClient, "", "", false)),
    ...records.map((r) => readAll(r.agentId, r.client, ERC8004.tag1, ERC8004.tag2, true)),
  ];
  const key = `erc8004:${agentIds.join(",")}`;
  const read = await chain.views(key, calls, 60_000).then(
    (cached) => ({ cached, error: cached.error }),
    (error: unknown) => ({ cached: null, error: messageOf(error) }),
  );
  const results = read.cached?.value ?? [];
  const logs =
    records.length === 0
      ? []
      : await chain
          .recentLogs(key, {
            address: registry,
            topics: [
              ERC8004.newFeedbackTopic,
              [...new Set(records.map((r) => numberToHex(BigInt(r.agentId), { size: 32 })))],
              [...new Set(records.map((r) => pad(r.client.toLowerCase() as Hex, { size: 32 })))],
            ],
          })
          .then(
            (cached) => decodeLogs(cached.value.logs),
            () => [],
          );
  const house = houseSet(sources.deployments);

  let oursError: string | null = null;
  const entries: SeatReview[] = [];
  records.forEach((r, i) => {
    const { row, error } = rowOf(results[agentIds.length + i], read.error);
    if (!row) {
      oursError ??= error;
      return;
    }
    const [clients, indexes, values, decimals, tag1s, tag2s, revoked] = row;
    clients.forEach((client, j) => {
      const index = Number(indexes[j]);
      const log = logs.find(
        (l) => l.agentId === r.agentId && l.client === client.toLowerCase() && l.index === index,
      );
      const wallet = HOUSE_WALLETS.find((w) => w.address.toLowerCase() === client.toLowerCase());
      entries.push({
        orderId: r.orderId,
        agentId: r.agentId,
        client,
        clientName: wallet?.label ?? shortAddress(client),
        origin: house.has(client.toLowerCase()) ? "HOUSE" : "OUTSIDE",
        index,
        value: formatUnits(values[j] ?? 0n, decimals[j] ?? 0),
        tags: `${tag1s[j]}, ${tag2s[j]}`,
        revoked: revoked[j] ?? false,
        fileUrl: r.path,
        paymentTxUrl: etherscanTx(r.paymentTx),
        settlementTxUrl: etherscanTx(r.settlementTx),
        log: log
          ? { txUrl: etherscanTx(log.tx), matches: log.uri === r.uri && log.hash.toLowerCase() === r.hash }
          : null,
      });
    });
  });

  return {
    reviews: {
      registry,
      registryUrl: etherscanAddress(registry),
      imdClient,
      imdClientUrl: etherscanAddress(imdClient),
      imd: agentIds.map((agentId, i) => imdReviews(agentId, results[i], read.error)),
      ours:
        records.length === 0
          ? null
          : {
              entries,
              waiting:
                oursError !== null
                  ? []
                  : records
                      .filter((r) => !entries.some((e) => e.orderId === r.orderId))
                      .map((r) => ({ orderId: r.orderId, agentId: r.agentId, fileUrl: r.path })),
              error: oursError,
            },
    },
    source: sourceNote(
      "ERC-8004 reviews",
      `readAllFeedback at ${registry} through ${chain.rpcHost}`,
      read.cached,
      read.error,
    ),
    // One read for both kinds, the first agent's, as the seat's other commands do.
    commands: [first].map((agentId) => {
      const ours = records.filter((r) => r.agentId === agentId);
      const clients = [imdClient, ...new Set(ours.map((r) => r.client))];
      return {
        comment:
          ours.length > 0
            ? `Agent ${agentId}'s reviews from IdentityMD's WorkRegistry and from the wallet that paid for order ${ours.map((r) => r.orderId).join(" and ")}'s job, revoked ones too.`
            : `Agent ${agentId}'s reviews from IdentityMD's WorkRegistry, revoked ones too.`,
        command: castCall(registry, "REPUTATION", READ_ALL, [
          agentId,
          `"[${clients.join(",")}]"`,
          '""',
          '""',
          "true",
        ]),
      };
    }),
  };
}

/** IdentityMD's reviews of one agent, in the words both twins of the seat page use. */
export function imdReviewWords(r: ImdReviews): string {
  if (r.error) return `IdentityMD's reviews of agent ${r.agentId} could not be read just now: ${r.error}`;
  if (r.total === 0) return `IdentityMD has given agent ${r.agentId} no review yet.`;
  const accepted = r.categories.reduce((sum, c) => sum + c.accepted, 0);
  return `IdentityMD has given agent ${r.agentId} ${r.total} review${r.total === 1 ? "" : "s"}, ${accepted} with value 1.`;
}

/** One of our reviews, in the same words. */
export function seatReviewWords(entry: SeatReview): string {
  const log = entry.log
    ? entry.log.matches
      ? " Its NewFeedback log names this feedback file and its keccak256."
      : " Its NewFeedback log names another file."
    : " Its NewFeedback log is older than the RPC serves, so the file it names is not checked here.";
  return `Order ${entry.orderId}, agent ${entry.agentId}: value ${entry.value} (${entry.tags}), entry ${entry.index} from ${entry.clientName}, the wallet that paid for the job.${entry.revoked ? " Revoked by its client." : ""}${log}`;
}

/** A review of ours written and not sent, in the same words. */
export function seatReviewWaitingWords(w: { orderId: number; agentId: string }): string {
  return `Order ${w.orderId}'s review of agent ${w.agentId} is written and not sent yet.`;
}
