/**
 * A node that lives in memory, so no test touches the network.
 *
 * It answers the four JSON-RPC methods the indexer uses, through a real viem client, so the code
 * under test runs exactly the path it runs in production: hex in, viem's formatting, our checks.
 * It can also behave like the nodes we met: cap the block range of a log query, refuse old
 * history, leave timestamps out of logs, and reorganise its chain.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  keccak256,
  numberToHex,
  pad,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { mainnet } from "viem/chains";
import { FEE_PAYEE, IMD, TOPIC } from "../../src/constants.js";

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  blockTimestamp?: string;
  transactionHash: string;
  transactionIndex: string;
  logIndex: string;
  removed?: boolean;
}

export interface RawBlock {
  number: string;
  hash: string;
  parentHash: string;
  timestamp: string;
}

export interface LogFixture {
  what: string;
  address: string;
  from: number;
  to: number;
  logs: RawLog[];
  blocks: RawBlock[];
}

export function loadLogFixture(
  name: "work-recorded" | "intake" | "fee-transfers" | "launch-a-questions",
): LogFixture {
  const path = fileURLToPath(new URL(`../fixtures/logs/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as LogFixture;
}

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** Seconds; the timestamp given to block 0 when no recorded block is loaded. */
const GENESIS_TIME = 1_438_269_973;

export class FakeNode {
  head = 0;
  /** A log query wider than this many blocks is refused the way Cloudflare's gateway refuses it. */
  maxRange: number | null = null;
  /** A log query that reaches below this block is refused the way publicnode refuses old history. */
  historyFloor: number | null = null;
  /** Some nodes do not put the block timestamp in a log; set false to be one of them. */
  timestampsInLogs = true;
  /** The block the node calls finalized. Null: two epochs (64 blocks) behind the head. */
  finalized: number | null = null;
  /**
   * Called before every request is answered; whatever it throws is what the caller gets. For a
   * node that is down (`() => { throw new Error("fetch failed") }`) or refuses some requests.
   */
  intercept: ((method: string, params: unknown[]) => void) | null = null;
  /** Every request made, for counting. */
  readonly requests: { method: string; params: unknown }[] = [];

  #logs: RawLog[] = [];
  #recorded = new Map<number, { hash: string; timestamp: number }>();
  /** Blocks at or above a fork point get a new made-up hash. Later forks win. */
  #forks: { from: number; salt: number }[] = [];
  #txCounter = 0;

  /** Adds recorded logs and their real headers, and moves the head past them. */
  load(fixture: LogFixture): this {
    for (const block of fixture.blocks) {
      this.#recorded.set(Number(block.number), {
        hash: block.hash.toLowerCase(),
        timestamp: Number(block.timestamp),
      });
    }
    this.#logs.push(...fixture.logs.map((log) => ({ ...log })));
    this.head = Math.max(this.head, fixture.to);
    return this;
  }

  #salt(number: number): number | null {
    let salt: number | null = null;
    for (const fork of this.#forks) if (number >= fork.from) salt = fork.salt;
    return salt;
  }

  hashOf(number: number): Hex {
    const salt = this.#salt(number);
    const recorded = this.#recorded.get(number);
    if (salt === null && recorded) return recorded.hash as Hex;
    return keccak256(toHex(`fake-block:${salt ?? 0}:${number}`));
  }

  timeOf(number: number): number {
    const recorded = this.#recorded.get(number);
    if (this.#salt(number) === null && recorded) return recorded.timestamp;
    // A made-up block takes its time from the nearest recorded block below it, twelve seconds a
    // block, so made-up and recorded blocks sit on one consistent clock.
    let anchor: { number: number; timestamp: number } | null = null;
    for (const [known, header] of this.#recorded) {
      if (known <= number && (anchor === null || known > anchor.number))
        anchor = { number: known, timestamp: header.timestamp };
    }
    return anchor ? anchor.timestamp + (number - anchor.number) * 12 : GENESIS_TIME + number * 12;
  }

  /** Adds a made-up IMD transfer to the fee payee in `block`. Returns the raw log. */
  addFeeTransfer(options: {
    block: number;
    from: Address;
    value: bigint;
    logIndex?: number;
    txHash?: Hex;
  }): RawLog {
    const log: RawLog = {
      address: IMD.toLowerCase(),
      topics: [TOPIC.Transfer, pad(options.from).toLowerCase(), pad(FEE_PAYEE).toLowerCase()],
      data: encodeAbiParameters([{ type: "uint256" }], [options.value]),
      blockNumber: numberToHex(options.block),
      blockHash: this.hashOf(options.block),
      blockTimestamp: numberToHex(this.timeOf(options.block)),
      transactionHash: options.txHash ?? keccak256(toHex(`fake-tx:${++this.#txCounter}`)),
      transactionIndex: "0x0",
      logIndex: numberToHex(options.logIndex ?? 0),
      removed: false,
    };
    this.addLog(log);
    return log;
  }

  addLog(log: RawLog): void {
    this.#logs.push(log);
    this.head = Math.max(this.head, Number(log.blockNumber));
  }

  /**
   * Replaces the chain from `fromBlock` up: those blocks get new hashes and lose their logs. Add
   * the new fork's logs afterwards.
   */
  reorg(fromBlock: number): void {
    this.#forks.push({ from: fromBlock, salt: this.#forks.length + 1 });
    this.#logs = this.#logs.filter((log) => Number(log.blockNumber) < fromBlock);
  }

  countOf(method: string): number {
    return this.requests.filter((request) => request.method === method).length;
  }

  /** The inclusive block range of every `eth_getLogs` request made so far, in order. */
  logRanges(): [from: number, to: number][] {
    return this.requests
      .filter((request) => request.method === "eth_getLogs")
      .map((request) => {
        const [filter] = request.params as [{ fromBlock: string; toBlock: string }];
        return [Number(filter.fromBlock), Number(filter.toBlock)];
      });
  }

  client(): PublicClient {
    return createPublicClient({
      chain: mainnet,
      transport: custom(
        { request: async ({ method, params }) => this.#handle(method, params as unknown[]) },
        { retryCount: 0 },
      ),
    });
  }

  #handle(method: string, params: unknown[]): unknown {
    this.requests.push({ method, params });
    this.intercept?.(method, params);
    switch (method) {
      case "eth_chainId":
        return "0x1";
      case "eth_blockNumber":
        return numberToHex(this.head);
      case "eth_getBlockByNumber":
        return this.#block(params[0] as string);
      case "eth_getLogs":
        return this.#getLogs(
          params[0] as {
            address: string;
            topics?: (string | string[] | null)[];
            fromBlock: string;
            toBlock: string;
          },
        );
      default:
        throw new RpcError(-32601, `the method ${method} does not exist/is not available`);
    }
  }

  #block(tag: string): unknown {
    const number =
      tag === "latest"
        ? this.head
        : tag === "finalized"
          ? (this.finalized ?? Math.max(0, this.head - 64))
          : Number(tag);
    if (number > this.head) return null;
    const zero32 = `0x${"0".repeat(64)}`;
    return {
      number: numberToHex(number),
      hash: this.hashOf(number),
      parentHash: number > 0 ? this.hashOf(number - 1) : zero32,
      timestamp: numberToHex(this.timeOf(number)),
      nonce: "0x0000000000000000",
      difficulty: "0x0",
      totalDifficulty: "0x0",
      gasLimit: "0x1c9c380",
      gasUsed: "0x0",
      size: "0x0",
      baseFeePerGas: "0x1",
      miner: `0x${"0".repeat(40)}`,
      extraData: "0x",
      logsBloom: `0x${"0".repeat(512)}`,
      mixHash: zero32,
      receiptsRoot: zero32,
      sha3Uncles: zero32,
      stateRoot: zero32,
      transactionsRoot: zero32,
      transactions: [],
      uncles: [],
    };
  }

  #getLogs(filter: {
    /** One address, or several: a node takes either. */
    address: string | string[];
    topics?: (string | string[] | null)[];
    fromBlock: string;
    toBlock: string;
  }): RawLog[] {
    const from = Number(filter.fromBlock);
    const to = Number(filter.toBlock);
    if (this.historyFloor !== null && from < this.historyFloor) {
      throw new RpcError(
        -32602,
        "Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode",
      );
    }
    if (this.maxRange !== null && to - from + 1 > this.maxRange) {
      throw new RpcError(
        -32047,
        `Invalid eth_getLogs request. 'fromBlock'-'toBlock' range too large. Max range: ${this.maxRange}`,
      );
    }
    const addresses = (typeof filter.address === "string" ? [filter.address] : filter.address).map(
      (address) => address.toLowerCase(),
    );
    const matchesTopics = (log: RawLog) =>
      (filter.topics ?? []).every((wanted, position) => {
        if (wanted === null) return true;
        const actual = log.topics[position]?.toLowerCase();
        if (actual === undefined) return false;
        return Array.isArray(wanted)
          ? wanted.some((one) => one.toLowerCase() === actual)
          : wanted.toLowerCase() === actual;
      });
    return this.#logs
      .filter((log) => {
        const number = Number(log.blockNumber);
        return (
          addresses.includes(log.address.toLowerCase()) &&
          number >= from &&
          number <= to &&
          number <= this.head &&
          matchesTopics(log)
        );
      })
      .map((log) => {
        if (this.timestampsInLogs) return { ...log };
        const { blockTimestamp: _dropped, ...rest } = log;
        return rest;
      });
  }
}
