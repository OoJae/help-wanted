/**
 * Every protocol fact the indexer relies on, in one file.
 *
 * The addresses, the oracle action and the API base are `@help-wanted/shared`'s: the one list the
 * bots, the web app and the indexer all read, itself held against `Mainnet.sol` in the launch
 * projects. They are re-exported here under the names the modules use, so nothing is typed twice.
 * What this file adds is the indexer's own: the creation blocks a full backfill starts from, the
 * topics it filters logs by (a test checks each against its event signature) and the names of the
 * Intake's statuses.
 */
import type { Address, Hex } from "viem";
import {
  CHAIN_ID as SHARED_CHAIN_ID,
  IMD_API_BASE as SHARED_API_BASE,
  IMD_DECIMALS as SHARED_IMD_DECIMALS,
  MAINNET,
  WORK_RECORDED_TOPIC,
} from "@help-wanted/shared";

export const CHAIN_ID = SHARED_CHAIN_ID;

/** IMD: 18 decimals, a plain ERC-20 with no fee on transfer. */
export const IMD: Address = MAINNET.IMD;
export const IMD_DECIMALS = SHARED_IMD_DECIMALS;

/** Where the 0.5 IMD fee of every paid action lands. Also the Intake's `payTo`. */
export const FEE_PAYEE: Address = MAINNET.FEE_PAYEE;

/** IdentityMD's WorkRegistry: `latest(bytes16 jobId)` is keccak256 of the job's work record. */
export const WORK_REGISTRY: Address = MAINNET.WORK_REGISTRY;

/**
 * The IdentityMD Intake, version 2: where a contract buys an oracle request today, and the one
 * launch A's `Questions` is built on.
 */
export const INTAKE: Address = MAINNET.INTAKE;

/**
 * The Intake, version 1: legacy, still served, with the same two events. It holds the earlier
 * history, including the requests that put the three house feed questions to the live oracle.
 */
export const INTAKE_V1: Address = MAINNET.INTAKE_V1;

/** Both Intake contracts, the current one first. The `intake` module reads the logs of both. */
export const INTAKES: readonly Address[] = [INTAKE, INTAKE_V1];

/** Which version of the Intake an address is, or null for any other address. Any letter case. */
export function intakeVersionOf(address: string): 1 | 2 | null {
  const lower = address.toLowerCase();
  if (lower === INTAKE.toLowerCase()) return 2;
  if (lower === INTAKE_V1.toLowerCase()) return 1;
  return null;
}

/** `bytes32("oracle.request@oracle-1")`: the text right-padded with zeros, not a hash. */
export const ORACLE_ACTION: Hex = MAINNET.ORACLE_ACTION;

/**
 * Creation blocks, for a full backfill. IMD and the legacy Intake (version 1) are from Sourcify's
 * deployment record; the WorkRegistry's is the block of its creation transaction
 * `0xb64e1d57212b1845209968c62e4ef32ae868c6155aa26a0e8daaf8a982ef98e2`. Version 2 of the Intake
 * was created after version 1, so a backfill of the `intake` module that starts at `INTAKE` (the
 * older contract's block) holds every request of both.
 */
export const CREATION_BLOCK = {
  IMD: 23_501_863,
  WORK_REGISTRY: 26_013_352,
  INTAKE: 26_142_962,
} as const;

/** topic0 of each event the indexer filters on. */
export const TOPIC = {
  /** `Transfer(address indexed from, address indexed to, uint256 value)` */
  Transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  /** `WorkRecorded(bytes16 indexed jobId, bytes32 indexed documentHash, bytes32 previousHash, string uri)` */
  WorkRecorded: WORK_RECORDED_TOPIC,
  /** `Requested(bytes32 indexed requestId, address indexed payer, bytes32 indexed action, bytes body, address callbackTarget, bytes4 callbackSelector, address asset, uint256 amount)` */
  Requested: "0x1c521a43c9b0f72a335bc80a6918abce08af7949ebbd1c41fe2a576074379063",
  /** `Completed(bytes32 indexed requestId, uint8 status, bytes32 resultHash, string uri, bool delivered)` */
  Completed: "0xd4ad2d2ef4e8ea9995103f34e322dbefb2534f3a52984a308f7db8e257b76fa1",
} as const satisfies Record<string, Hex>;

/** What the Intake's `Completed.status` means. Both versions emit the same event; one table reads both. */
export const INTAKE_STATUS = { 0: "answered", 1: "refused", 2: "unanswered" } as const;

export const IMD_API_BASE = SHARED_API_BASE;

/** The free node. It serves recent logs only; see the README for what a backfill needs. */
export const DEFAULT_RPC_URL = "https://ethereum-rpc.publicnode.com" as const;

/** Mainnet has produced one block every 12 seconds since the merge, less the missed slots. */
export const BLOCKS_PER_DAY = 7_200 as const;
