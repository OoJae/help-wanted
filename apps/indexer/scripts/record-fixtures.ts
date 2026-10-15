/**
 * Records the real logs the tests replay. Run by hand, once; the tests themselves never touch the
 * network. It only reads (`eth_getLogs`, `eth_getBlockByNumber`).
 *
 *   pnpm --filter @help-wanted/indexer exec tsx scripts/record-fixtures.ts [receipts|intake|fees]
 *
 * Two endpoints are used because the default one refuses logs older than roughly a day and a half
 * without a token. `ARCHIVE_RPC_URL` must serve the block ranges named below.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FEE_PAYEE, IMD, INTAKE_V1, TOPIC, WORK_REGISTRY } from "../src/constants.js";

const RECENT_RPC = process.env.RPC_URL ?? "https://ethereum-rpc.publicnode.com";
const ARCHIVE_RPC = process.env.ARCHIVE_RPC_URL ?? "https://rpc.mevblocker.io";
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/logs");

interface RawLog {
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

interface RawBlock {
  number: string;
  hash: string;
  parentHash: string;
  timestamp: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n: number) => `0x${n.toString(16)}`;

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { result?: T; error?: { message: string } };
      if (parsed.error) throw new Error(`${method}: ${parsed.error.message}`);
      return parsed.result as T;
    } catch (error) {
      if (attempt >= 4) throw error;
      await sleep(1500 * attempt);
    }
  }
}

async function logsIn(
  url: string,
  filter: { address: string; topics?: (string | string[] | null)[] },
  from: number,
  to: number,
  step: number,
): Promise<RawLog[]> {
  const out: RawLog[] = [];
  for (let start = from; start <= to; start += step) {
    const end = Math.min(to, start + step - 1);
    const page = await rpc<RawLog[]>(url, "eth_getLogs", [
      { ...filter, fromBlock: hex(start), toBlock: hex(end) },
    ]);
    out.push(...page);
    await sleep(400);
  }
  return out;
}

/** The headers of every block a log sits in, so a test node can answer `eth_getBlockByNumber`. */
async function headersFor(url: string, logs: RawLog[]): Promise<RawBlock[]> {
  const numbers = [...new Set(logs.map((l) => l.blockNumber))].sort((a, b) => Number(a) - Number(b));
  const blocks: RawBlock[] = [];
  for (const number of numbers) {
    const block = await rpc<RawBlock>(url, "eth_getBlockByNumber", [number, false]);
    blocks.push({
      number: block.number,
      hash: block.hash,
      parentHash: block.parentHash,
      timestamp: block.timestamp,
    });
    await sleep(150);
  }
  return blocks;
}

async function save(name: string, body: Record<string, unknown>): Promise<void> {
  await mkdir(OUT, { recursive: true });
  await writeFile(resolve(OUT, name), `${JSON.stringify(body, null, 2)}\n`);
  console.log(`wrote ${name}`);
}

async function recordReceipts(): Promise<void> {
  // 1. WorkRegistry receipts: a 200-block window on 6 Oct that holds the receipt of job e9efec16
  //    (block 26,131,975), the job the brief names, and four others.
  const receiptsRange = { from: 26_131_900, to: 26_132_100 };
  const receipts = await logsIn(
    ARCHIVE_RPC,
    { address: WORK_REGISTRY, topics: [TOPIC.WorkRecorded] },
    receiptsRange.from,
    receiptsRange.to,
    2000,
  );
  await save("work-recorded.json", {
    what: "WorkRegistry WorkRecorded logs",
    address: WORK_REGISTRY,
    ...receiptsRange,
    logs: receipts,
    blocks: await headersFor(ARCHIVE_RPC, receipts),
  });
}

async function recordIntake(): Promise<void> {
  // 2. Every Requested and Completed log of the legacy Intake (version 1) from its creation block
  //    to the block the fixtures were recorded at. Version 2 did not exist in that range.
  const intakeRange = { from: 26_142_962, to: 26_164_615 };
  const intake = await logsIn(
    ARCHIVE_RPC,
    { address: INTAKE_V1, topics: [[TOPIC.Requested, TOPIC.Completed]] },
    intakeRange.from,
    intakeRange.to,
    2000,
  );
  await save("intake.json", {
    what: "Intake Requested and Completed logs, from the Intake's creation block",
    address: INTAKE_V1,
    ...intakeRange,
    logs: intake,
    blocks: await headersFor(ARCHIVE_RPC, intake),
  });
}

async function recordFees(): Promise<void> {
  // 3. IMD transfers to the fee payee over 7,000 blocks (a little under one day).
  const feeRange = { from: 26_157_615, to: 26_164_615 };
  const payeeTopic = `0x${FEE_PAYEE.slice(2).toLowerCase().padStart(64, "0")}`;
  const fees = await logsIn(
    RECENT_RPC,
    { address: IMD, topics: [TOPIC.Transfer, null, payeeTopic] },
    feeRange.from,
    feeRange.to,
    7001,
  );
  await save("fee-transfers.json", {
    what: "IMD Transfer logs whose recipient is the fee payee",
    address: IMD,
    ...feeRange,
    logs: fees,
    blocks: await headersFor(RECENT_RPC, fees),
  });
}

const only = process.argv[2];
if (!only || only === "receipts") await recordReceipts();
if (!only || only === "intake") await recordIntake();
if (!only || only === "fees") await recordFees();
