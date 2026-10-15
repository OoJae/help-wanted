/**
 * What this site adds to the protocol facts it takes from `@help-wanted/shared`: the public RPC it
 * reads by default, the explorers it links to, the topics it filters logs by, and the one job it
 * checks on its own account.
 *
 * Every address, ABI and protocol constant comes from the shared package (`MAINNET`, the ABIs,
 * `CHAIN_ID`, `PAID_ACTION_PRICE`, …). Nothing of that kind is written again here. The topics below
 * are computed from the shared ABIs, not typed.
 */
import { encodeEventTopics, type Abi, type Address, type Hex } from "viem";
import {
  erc20Abi,
  IMD_API_BASE,
  IMD_EXPLORER_BASE,
  intakeAbi,
  WORK_RECORDED_TOPIC,
} from "@help-wanted/shared";

/**
 * Multicall3: a public utility contract this site batches its reads through. No contract of ours
 * touches it, which is why it is not in the shared address list.
 */
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

export const ETHERSCAN_BASE = "https://etherscan.io" as const;
/** Serves `eth_call` freely and `eth_getLogs` for about the newest 7,200 blocks. */
export const DEFAULT_RPC_URL = "https://ethereum-rpc.publicnode.com" as const;
/** How far back the default public RPC answers `eth_getLogs`. */
export const PUBLIC_LOG_WINDOW_BLOCKS = 7200 as const;
/** Mainnet's slot time, for turning a number of blocks into a rough length of time. */
export const SECONDS_PER_BLOCK = 12 as const;

function topicOf(abi: Abi, eventName: string): Hex {
  const [topic] = encodeEventTopics({ abi, eventName });
  if (typeof topic !== "string") throw new Error(`the ABI has no event ${eventName}`);
  return topic;
}

export const TOPIC = {
  /** `Transfer(address indexed from, address indexed to, uint256 value)`. */
  TRANSFER: topicOf(erc20Abi, "Transfer"),
  /** Intake `Requested(bytes32 indexed, address indexed, bytes32 indexed, bytes, address, bytes4, address, uint256)`. */
  INTAKE_REQUESTED: topicOf(intakeAbi, "Requested"),
  /** Intake `Completed(bytes32 indexed, uint8, bytes32, string, bool)`. */
  INTAKE_COMPLETED: topicOf(intakeAbi, "Completed"),
  /** WorkRegistry `WorkRecorded(bytes16 indexed, bytes32 indexed, bytes32, string)`. */
  WORK_RECORDED: WORK_RECORDED_TOPIC as Hex,
} as const satisfies Record<string, Hex>;

/** The job this whole product leans on: its receipt was reproduced by hand before anything was built. */
export const REFERENCE_JOB = {
  jobId: "e9efec16-56f3-40d3-9243-52c453effc7d",
  jobIdBytes16: "0xe9efec1656f340d3924352c453effc7d",
  receipt: "0x3db993254c94479c4bf74d1115c7db3bfb48e5859379a4e83467ab6c3338b2c5",
  recordBytes: 7339,
  receiptTx: "0xee0fe8ac1d27324676b65c3e86d89bb2359bf708648115ec59a1ab3325f000ec",
  receiptBlock: 26131975,
} as const;

export function etherscanTx(hash: string): string {
  return `${ETHERSCAN_BASE}/tx/${hash}`;
}

export function etherscanAddress(address: string): string {
  return `${ETHERSCAN_BASE}/address/${address}`;
}

export function etherscanBlock(block: number | bigint | string): string {
  return `${ETHERSCAN_BASE}/block/${block}`;
}

export function explorerJob(jobId: string): string {
  return `${IMD_EXPLORER_BASE}/jobs/${jobId}`;
}

/** Public pages of IdentityMD's API that a reader can open to check something this site says. */
export const IMD_LINK = {
  job: (jobId: string) => `${IMD_API_BASE}/jobs/${jobId}`,
  jobRecords: (jobId: string) => `${IMD_API_BASE}/jobs/${jobId}/records`,
  jobReport: (jobId: string) => `${IMD_API_BASE}/jobs/${jobId}/report.md`,
  oracleRequest: (id: string) => `${IMD_API_BASE}/oracle/requests/${id}`,
  intakeRead: (transactionHash: string) => `${IMD_API_BASE}/intake/1/${transactionHash}`,
  workRecord: (hashNo0x: string) => `${IMD_API_BASE}/work-records/${hashNo0x}.json`,
} as const;
