/**
 * What the observers read through. Each `observe` function turns chain reads (all at one block)
 * and, where a round is pending, reads of IdentityMD's API into the plain snapshot its module's
 * `decide` takes. Observers send nothing.
 */
import type { Abi, AbiEvent, Address, Hex } from "viem";
import type {
  CheckedRecord,
  IntakeRead,
  Job,
  JobRecords,
  OracleAttestationDocument,
  OracleRequest,
} from "@help-wanted/shared";
import type { Logger } from "../log.js";
import type { Store } from "../store.js";

/** The part of a viem public client the observers use. */
export interface Reader {
  readContract(args: {
    address: Address;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
    blockNumber?: bigint;
  }): Promise<unknown>;
  getBlock(): Promise<{ number: bigint; timestamp: bigint }>;
  getBalance(args: { address: Address; blockNumber?: bigint }): Promise<bigint>;
  getLogs(args: {
    address: Address;
    event: AbiEvent;
    args?: Record<string, unknown>;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<{ transactionHash: Hex | null; blockNumber?: bigint | null; args?: unknown }[]>;
  /** The network's current fee per gas, in wei. Only the rules module asks. */
  getGasPrice?(): Promise<bigint>;
}

/**
 * The routes of IdentityMD's API the keeper reads: three for Standing Questions, and three for the
 * watch on delivery claims. `ImdClient` is one. Every one is a public GET.
 */
export interface ServiceApi {
  /** `GET /intake/:chainId/:tx`: the state of a request and the oracle request behind it. */
  intakeRead(chainId: number, transactionHash: string): Promise<IntakeRead>;
  /** `GET /oracle/requests/:id/attestation`: the signed answer, once there is one. */
  oracleAttestation(id: string): Promise<OracleAttestationDocument>;
  /** `GET /oracle/requests/:id`: read only for a request that ended without an answer, to say why. */
  oracleRequest(id: string): Promise<OracleRequest>;
  /** `GET /jobs/:id`: a job's state, template and full objective. */
  job(id: string): Promise<Job>;
  /** `GET /jobs/:id/records`: the hashes of the job's work records, newest first. */
  jobRecords(id: string): Promise<JobRecords>;
  /** `GET /work-records/:hash.json`: the record's bytes, checked against the hash asked for. */
  workRecord(hash: string): Promise<CheckedRecord>;
}

/** The block a pass reads everything at. */
export interface AtBlock {
  number: bigint;
  timestamp: bigint;
}

/** Facts that cannot change once read: constants of the deployed code, and a feed's own text. */
export interface ObserveCache {
  values: Map<string, unknown>;
}

export function newCache(): ObserveCache {
  return { values: new Map() };
}

export interface ObserveContext {
  reader: Reader;
  api: ServiceApi;
  store: Store;
  log: Logger;
  cache: ObserveCache;
  block: AtBlock;
  chainId: number;
  keeper: Address | null;
}

/** Reads a contract at the pass's block. */
export function readAt(
  ctx: Pick<ObserveContext, "reader" | "block">,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<unknown> {
  return ctx.reader.readContract({ address, abi, functionName, args, blockNumber: ctx.block.number });
}

/** Reads something that never changes, once per process. */
export async function readOnce<T>(
  ctx: Pick<ObserveContext, "reader" | "block" | "cache">,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<T> {
  const key = `${address.toLowerCase()}:${functionName}:${JSON.stringify(args)}`;
  if (ctx.cache.values.has(key)) return ctx.cache.values.get(key) as T;
  const value = (await readAt(ctx, address, abi, functionName, args)) as T;
  ctx.cache.values.set(key, value);
  return value;
}

/**
 * Every log of one event since a block. Tried as one query first; a node that refuses the range
 * is asked again in pieces of `chunk` blocks. Throws when the node serves neither.
 */
export async function logsSince(
  ctx: Pick<ObserveContext, "reader" | "block">,
  query: { address: Address; event: AbiEvent; args?: Record<string, unknown>; fromBlock: bigint },
  chunk: bigint = 5_000n,
  maxChunks = 40,
): Promise<{ transactionHash: Hex | null; blockNumber?: bigint | null; args?: unknown }[]> {
  const head = ctx.block.number;
  const from = query.fromBlock > head ? head : query.fromBlock;
  const base = {
    address: query.address,
    event: query.event,
    ...(query.args === undefined ? {} : { args: query.args }),
  };
  try {
    return await ctx.reader.getLogs({ ...base, fromBlock: from, toBlock: head });
  } catch (whole) {
    const out: { transactionHash: Hex | null; blockNumber?: bigint | null; args?: unknown }[] = [];
    let start = from;
    for (let n = 0; start <= head; n++) {
      if (n >= maxChunks) {
        throw new Error(
          `the node refused logs from block ${from} in one query (${messageOf(whole)}) and the range is more than ${maxChunks} pieces of ${chunk} blocks: use a keyed RPC`,
        );
      }
      const end = start + chunk - 1n < head ? start + chunk - 1n : head;
      out.push(...(await ctx.reader.getLogs({ ...base, fromBlock: start, toBlock: end })));
      start = end + 1n;
    }
    return out;
  }
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const short = (error as { shortMessage?: string }).shortMessage;
    return (short ?? error.message).slice(0, 240);
  }
  return String(error).slice(0, 240);
}
