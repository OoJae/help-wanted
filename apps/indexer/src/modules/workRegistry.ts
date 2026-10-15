/**
 * WorkRegistry receipts.
 *
 * IdentityMD writes one `WorkRecorded` log when a job's work record is anchored: the job id and
 * keccak256 of the record's bytes. `WorkRegistry.latest(jobId)` returns the newest of them, and it
 * is the hash the hire desk pays against. A job can be recorded more than once (each record names
 * the one before it), so the table keeps every receipt and the newest per job is the one that counts.
 */
import { index, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { parseAbi } from "viem";
import { z } from "zod";
import { WORK_REGISTRY, TOPIC } from "../constants.js";
import { logOrigin } from "../db/columns.js";
import { bytes16, bytes32, parseArgs } from "../engine/args.js";
import type { ContractModule } from "../engine/module.js";
import { jobIdToUuid } from "../ids.js";

export const receipts = pgTable(
  "receipts",
  {
    ...logOrigin(),
    /** `bytes16`, as the chain writes it. */
    jobId: text("job_id").notNull(),
    /** The same id as a UUID, as the IdentityMD API writes it. */
    jobUuid: text("job_uuid").notNull(),
    /** keccak256 of the work record's bytes. */
    documentHash: text("document_hash").notNull(),
    /** The hash this record replaces, or zero for a job's first record. */
    previousHash: text("previous_hash").notNull(),
    /** Where IdentityMD serves the record. Stored as data; the indexer never fetches it. */
    uri: text("uri").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.txHash, t.logIndex] }),
    index("receipts_job_idx").on(t.jobId, t.blockNumber, t.logIndex),
    index("receipts_block_idx").on(t.blockNumber, t.logIndex),
    index("receipts_hash_idx").on(t.documentHash),
  ],
);

export const workRegistryAbi = parseAbi([
  "event WorkRecorded(bytes16 indexed jobId, bytes32 indexed documentHash, bytes32 previousHash, string uri)",
]);

const WorkRecorded = z.object({
  jobId: bytes16,
  documentHash: bytes32,
  previousHash: bytes32,
  uri: z.string(),
});

export const workRegistryModule: ContractModule = {
  name: "receipts",
  title: "WorkRegistry WorkRecorded (work-record receipts)",
  abi: workRegistryAbi,
  filter: () => ({ address: WORK_REGISTRY, topics: [TOPIC.WorkRecorded] }),
  tables: [receipts],
  async apply(db, event) {
    if (event.event !== "WorkRecorded") return;
    const args = parseArgs(WorkRecorded, event);
    const row = {
      txHash: event.txHash,
      logIndex: event.logIndex,
      blockNumber: event.blockNumber,
      blockTime: event.blockTime,
      jobId: args.jobId,
      jobUuid: jobIdToUuid(args.jobId),
      documentHash: args.documentHash,
      previousHash: args.previousHash,
      uri: args.uri,
    };
    await db
      .insert(receipts)
      .values(row)
      .onConflictDoUpdate({ target: [receipts.txHash, receipts.logIndex], set: row });
  },
};
