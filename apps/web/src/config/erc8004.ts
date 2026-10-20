/**
 * The reviews HELP WANTED gives on ERC-8004 (https://eips.ethereum.org/EIPS/eip-8004): one entry in
 * the Reputation Registry for each IdentityMD agent that did an order on the hire desk, given by the
 * wallet that paid for the order's swarm job, with a feedback file on this site whose
 * `proofOfPayment` names that payment. `scripts/feedback.sh` sends them; the seat pages read them.
 *
 * The registry is not ours and not IdentityMD's: it is the reference deployment of the ERC-8004
 * authors (github.com/erc-8004/erc-8004-contracts), an ERC-1967 proxy that its owner can upgrade.
 * IdentityMD binds its seats' agents to ids in the Identity Registry it points at, and its WorkRegistry
 * writes its own acceptance reviews to it. Its interface is written here and nowhere else, as
 * Multicall3's is in `lib/multicall.ts`. Read on 20 October 2026 with cast against
 * https://rpc.mevblocker.io: code at both addresses, `getIdentityRegistry()` naming the Identity
 * Registry below, `getVersion()` "2.0.0", and the selectors of the functions below in the
 * implementation's bytecode.
 *
 * A record is used only while the deployments book gives the hire desk the address it was written
 * for, as `config/history.ts` does: a fork or a test book borrows nothing.
 */
import { encodeEventTopics, type Address, type Hex } from "viem";
import { MAINNET } from "@help-wanted/shared";
import { ORDER_HISTORY } from "./history";

export const reputationRegistryAbi = [
  {
    type: "function",
    name: "getIdentityRegistry",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "giveFeedback",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "value", type: "int128" },
      { name: "valueDecimals", type: "uint8" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
      { name: "endpoint", type: "string" },
      { name: "feedbackURI", type: "string" },
      { name: "feedbackHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "readAllFeedback",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "clientAddresses", type: "address[]" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
      { name: "includeRevoked", type: "bool" },
    ],
    outputs: [
      { name: "clients", type: "address[]" },
      { name: "feedbackIndexes", type: "uint64[]" },
      { name: "values", type: "int128[]" },
      { name: "valueDecimals", type: "uint8[]" },
      { name: "tag1s", type: "string[]" },
      { name: "tag2s", type: "string[]" },
      { name: "revokedStatuses", type: "bool[]" },
    ],
  },
  {
    type: "event",
    name: "NewFeedback",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "clientAddress", type: "address", indexed: true },
      { name: "feedbackIndex", type: "uint64", indexed: false },
      { name: "value", type: "int128", indexed: false },
      { name: "valueDecimals", type: "uint8", indexed: false },
      { name: "indexedTag1", type: "string", indexed: true },
      { name: "tag1", type: "string", indexed: false },
      { name: "tag2", type: "string", indexed: false },
      { name: "endpoint", type: "string", indexed: false },
      { name: "feedbackURI", type: "string", indexed: false },
      { name: "feedbackHash", type: "bytes32", indexed: false },
    ],
  },
] as const;

const [newFeedbackTopic] = encodeEventTopics({ abi: reputationRegistryAbi, eventName: "NewFeedback" });

export const ERC8004 = {
  identityRegistry: MAINNET.IDENTITY_REGISTRY as Address,
  reputationRegistry: MAINNET.REPUTATION_REGISTRY as Address,
  /** `NewFeedback(uint256 indexed, address indexed, uint64, int128, uint8, string indexed, string, string, string, string, bytes32)`. */
  newFeedbackTopic: newFeedbackTopic as Hex,
  /** The tags every review of ours carries: what it is about, and who gives it. */
  tag1: "paid-on-receipt",
  tag2: "helpwanted",
  /** The origin written into each review's feedbackURI: the live site. */
  origin: "https://web-production-a7c148.up.railway.app",
} as const;

export interface DeskReview {
  orderId: number;
  agentId: string;
  /** The seat the agent was bound to when the review was written. */
  tokenId: string;
  /** The wallet that paid for the order's swarm job, which gives the review. */
  client: Address;
  /** Where the feedback file is on this site. */
  path: string;
  /** The feedbackURI written on chain. */
  uri: string;
  /** The feedbackHash written on chain: keccak256 of the file's bytes. */
  hash: Hex;
  /** The x402 payment its `proofOfPayment` names. */
  paymentTx: Hex;
  /** The desk's settlement of the order, which its `helpwanted.settlement` names. */
  settlementTx: Hex;
}

const H1: Address = "0x60CcC928eb8EEE1d64CA0164565BfA9858669560";

const review = (
  orderId: number,
  agentId: string,
  tokenId: string,
  hash: Hex,
  paymentTx: Hex,
  settlementTx: Hex,
): DeskReview => ({
  orderId,
  agentId,
  tokenId,
  client: H1,
  path: `/erc8004/feedback-order-${orderId}.json`,
  uri: `${ERC8004.origin}/erc8004/feedback-order-${orderId}.json`,
  hash,
  paymentTx,
  settlementTx,
});

export const DESK_REVIEWS: { workOrders: Address; reviews: readonly DeskReview[] } = {
  workOrders: ORDER_HISTORY.workOrders,
  reviews: [
    review(
      1,
      "51519",
      "1049",
      "0x7ef86f5479be3c3d443c3590f1662ae7013482091e6656142812232eaf4b4525",
      "0xc92c4731e996540cbe68d2e62bc820d67e6bf4d7ec9adc6464b4b0be90e66bc5",
      "0xa3f5b783fe194c35f348e411a10f0a199589ea89b668a16d1597794931217628",
    ),
    review(
      2,
      "52142",
      "1978",
      "0x71c70586eb4c3f9ac56402a1ee21bc3da12bb0e386efcbe876993b844c1523ea",
      "0x2fc7fa990bb74b015cff16c5c69e8d97eccdad38c79307c8b1a02bfbcea3ca70",
      "0x35bb49cc9576a425b94a94137e8fe24e496017cc154456eeee255d22fc020516",
    ),
  ],
};

/** The reviews written for these agents' desk orders, when the book's desk is the one they name. */
export function pinnedReviews(workOrders: string | null, agentIds: readonly string[]): readonly DeskReview[] {
  if (!workOrders || workOrders.toLowerCase() !== DESK_REVIEWS.workOrders.toLowerCase()) return [];
  return DESK_REVIEWS.reviews.filter((r) => agentIds.includes(r.agentId));
}
