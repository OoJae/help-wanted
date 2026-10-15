/**
 * Writes the database out as JSON files for the evidence pack.
 *
 * The files are deterministic: every list is ordered by its natural key, every object's keys are
 * sorted, amounts are decimal strings, and no file holds the time the snapshot was taken. The same
 * database contents give the same bytes, so a commit that changes a file shows exactly what
 * changed, and `manifest.json` (a SHA-256 per file) lets anyone check a copy.
 *
 * Two kinds of file, named apart in the manifest:
 *   - `chain`: derived only from Ethereum logs. Anyone who indexes the same block range gets the
 *     same file. Each names the module it was read from and whether that module's handler is
 *     finished (`handler: "stub"` means the table is not being filled yet, so its empty list says
 *     nothing about the chain).
 *   - `api`: copies of what the public IdentityMD API served, with the time each was fetched.
 *     Reproducible from this database, not from the chain.
 *
 * The cut. The indexer follows the chain two blocks behind its head, and a block that recent can
 * still be replaced. A published file cannot be repaired afterwards, so a snapshot is cut at a
 * block that can no longer change (the node's finalized block, or one the operator names): the
 * chain files hold the store as it stood at that block, and `coverage.json` names it. The store
 * as of an earlier block is not a filter over today's rows (a request answered after the cut must
 * read as unanswered), so it is rebuilt: inside a transaction that is rolled back at the end, the
 * tables of every module that has logs above the cut are folded again from the logs up to it.
 * The database is left exactly as it was.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, eq, getTableColumns, gt, gte, lt, lte, notInArray, sql } from "drizzle-orm";
import type { PublicClient } from "viem";
import { assertMainnet, blockRef, finalizedBlock } from "./chain/client.js";
import type { Db } from "./db/client.js";
import { cursors, events } from "./db/core.js";
import type { ContractModule } from "./engine/module.js";
import { replayModule } from "./engine/store.js";
import { stableStringify } from "./json.js";
import { errorMessage, silentLogger, type Logger } from "./log.js";
import { apiHealth, apiJobRecords, apiJobs, apiOracleRequests } from "./mirror/tables.js";
import { feeTransfers } from "./modules/feeTransfers.js";
import { ALL_MODULES, EXTERNAL_MODULES } from "./modules/index.js";
import { intakeRequests } from "./modules/intake.js";
import { chips, pots } from "./modules/own/crowdPots.js";
import { prints } from "./modules/own/jobsReport.js";
import { payrollMovements } from "./modules/own/payroll.js";
import { feeds, rounds } from "./modules/own/questions.js";
import { rules } from "./modules/own/rules.js";
import { claims, orders } from "./modules/own/workOrders.js";
import { receipts } from "./modules/workRegistry.js";
import { createQueries, type ModuleCoverage } from "./queries.js";
import { formatImd, rankPayers, tallyAll, tallyByDay, type Split, type Tally } from "./report/tally.js";

/**
 * Where the snapshot command writes when it is given no `--out`: `evidence/indexer` at the root
 * of the repository, where the evidence pack keeps the indexer's files.
 */
export const DEFAULT_SNAPSHOT_DIR = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
  "../../evidence/indexer",
);

/** The block a snapshot's chain files are cut at: nothing above it is in them. */
export interface SnapshotCut {
  block: number;
  /** The block's hash and timestamp as the node gave them; null when the node could not be asked. */
  hash: string | null;
  time: number | null;
  /** `finalized`: the node's finalized block when the snapshot was taken. `given`: named by the operator. */
  rule: "finalized" | "given";
}

/**
 * Chooses the block a snapshot is cut at.
 *
 * Without `through` it is the node's finalized block, so the node must answer: a snapshot that
 * cannot name a final block is not taken. With `through` the operator's block is used; the node
 * is then only asked for that block's hash and time, which the snapshot can do without (they are
 * left null, and no day of the tally is called complete), and a block that is not final yet is
 * accepted with a warning.
 */
export async function chooseCut(
  client: PublicClient,
  through?: number,
  log: Logger = silentLogger,
): Promise<SnapshotCut> {
  if (through === undefined) {
    try {
      await assertMainnet(client);
      const final = await finalizedBlock(client);
      return { block: final.number, hash: final.hash, time: final.time, rule: "finalized" };
    } catch (error) {
      throw new Error(
        `could not read the finalized block from the node (${errorMessage(error)}). A snapshot is cut at a ` +
          `block that can no longer change; to take one without the node, name the block: --through <block>`,
      );
    }
  }
  try {
    await assertMainnet(client);
    const named = await blockRef(client, through);
    const final = await finalizedBlock(client);
    if (through > final.number) {
      log.warn("the block named with --through is not final yet; the chain may still replace it", {
        through,
        finalized: final.number,
      });
    }
    return { block: through, hash: named.hash, time: named.time, rule: "given" };
  } catch (error) {
    log.warn("the node could not be asked about the cut block; its hash and time are left out", {
      through,
      error: errorMessage(error),
    });
    return { block: through, hash: null, time: null, rule: "given" };
  }
}

export interface SnapshotOptions {
  house?: Iterable<string>;
  /** Where to cut. Left out, the files hold everything stored, up to each module's last block. */
  cut?: SnapshotCut | null;
  /** The modules whose tables may need rebuilding at the cut. Default: every module of this package. */
  modules?: ContractModule[];
}

export interface SnapshotFile {
  name: string;
  source: "chain" | "api";
  /** Entries in the file's main list. */
  rows: number;
  bytes: number;
  sha256: string;
}

export interface SnapshotResult {
  dir: string;
  cut: SnapshotCut | null;
  files: SnapshotFile[];
}

interface BuiltFile {
  name: string;
  source: "chain" | "api";
  rows: number;
  value: unknown;
}

function showSplit(split: Split) {
  return {
    amountWei: split.amount,
    amountImd: formatImd(split.amount),
    payments: split.payments,
    payers: split.payers,
  };
}

function showTally(tally: Tally) {
  return {
    ...showSplit(tally),
    house: showSplit(tally.house),
    outside: showSplit(tally.outside),
    zeroValueLogs: tally.zeroValueLogs,
  };
}

/** Thrown to end the transaction a cut snapshot is built in: its only purpose is the rollback. */
class Undo extends Error {}

/** A module's coverage as a snapshot states it: the range, capped at the cut, and nothing of ours. */
function coverageAsOf(entry: ModuleCoverage, handler: "ready" | "stub", cut: SnapshotCut | null) {
  const base = {
    module: entry.module,
    handler,
    fromBlock: entry.fromBlock,
    fromTime: entry.fromTime,
    events: entry.events,
    unfolded: entry.unfolded,
  };
  if (cut === null || entry.throughBlock === null || entry.throughBlock <= cut.block) {
    return {
      ...base,
      throughBlock: entry.throughBlock,
      throughTime: entry.throughTime,
      throughHash: entry.throughHash,
    };
  }
  // The module had not begun at the cut: as of that block it had indexed nothing.
  if (entry.fromBlock > cut.block)
    return { ...base, throughBlock: null, throughTime: null, throughHash: null };
  return { ...base, throughBlock: cut.block, throughTime: cut.time, throughHash: cut.hash };
}

async function build(db: Db, options: SnapshotOptions, cut: SnapshotCut | null): Promise<BuiltFile[]> {
  const houseList = [...new Set([...(options.house ?? [])].map((address) => address.toLowerCase()))].sort();
  const house = new Set(houseList);
  const modules = options.modules ?? ALL_MODULES;
  const queries = createQueries(db, { house, modules });
  const out: BuiltFile[] = [];
  /** The modules that have indexed at least one block as of the cut. Filled in below. */
  const indexed = new Set<string>();
  /** A file derived from chain logs: it names its module and says whether the handler is finished. */
  const chain = (
    name: string,
    module: string,
    about: string,
    rows: unknown[],
    extra: Record<string, unknown> = {},
  ) => {
    const handler = queries.handlerOf(module);
    out.push({
      name,
      source: "chain",
      rows: rows.length,
      value: {
        about:
          handler === "stub"
            ? `${about} NOT INDEXED YET: the handler of module "${module}" is a stub, so this list is empty whatever happened on chain; the contract's logs, once it has an address, are in own-events.json.`
            : indexed.has(module)
              ? about
              : `${about} NOT INDEXED: module "${module}" has indexed no block here (its contract has no address in this configuration, or it has not been synced yet), so this list is empty whatever happened on chain.`,
        module,
        handler,
        ...extra,
        rows,
      },
    });
  };
  const api = (name: string, about: string, rows: unknown[]) =>
    out.push({ name, source: "api", rows: rows.length, value: { about, rows } });

  // Coverage: which blocks each file below was counted from. No clock values of ours.
  const coverage = (await queries.coverage(cut ? { through: cut.block } : {})).map((entry) =>
    coverageAsOf(entry, queries.handlerOf(entry.module), cut),
  );
  for (const entry of coverage) if (entry.throughBlock !== null) indexed.add(entry.module);
  out.push({
    name: "coverage.json",
    source: "chain",
    rows: coverage.length,
    value: {
      about:
        "The inclusive block range each module has indexed, and the hash of its last block. `cut` is the block these files are cut at: nothing above it is in any chain file. `handler: stub` marks a module whose tables are not being filled yet. `unfolded` counts logs in the range that the handler could not fold, which are therefore missing from the module's file.",
      cut,
      rows: coverage,
    },
  });

  chain(
    "receipts.json",
    "receipts",
    "WorkRegistry WorkRecorded logs: job id, keccak256 of the work record, block and transaction.",
    await db.select().from(receipts).orderBy(asc(receipts.blockNumber), asc(receipts.logIndex)),
  );

  chain(
    "intake-requests.json",
    "intake",
    "Every oracle request bought through either IdentityMD Intake contract in the indexed range, with its body and how it ended. `intake` is the contract that logged it: version 2 (the current one) or the legacy version 1.",
    await db
      .select()
      .from(intakeRequests)
      .orderBy(
        sql`coalesce(${intakeRequests.requestedBlock}, ${intakeRequests.completedBlock})`,
        sql`coalesce(${intakeRequests.requestedLogIndex}, ${intakeRequests.completedLogIndex})`,
        asc(intakeRequests.requestId),
      ),
  );

  const transfers = await db
    .select()
    .from(feeTransfers)
    .orderBy(asc(feeTransfers.blockNumber), asc(feeTransfers.logIndex));
  chain(
    "fee-transfers.json",
    "fee_transfers",
    "IMD Transfer logs to the fee payee: the raw material of the Robot Jobs Report.",
    transfers.map((transfer) => ({ ...transfer, label: house.has(transfer.from) ? "HOUSE" : "OUTSIDE" })),
  );

  const feeCoverage = coverage.find((entry) => entry.module === "fee_transfers") ?? null;
  const days = tallyByDay(transfers, house, {
    fromTime: feeCoverage?.fromTime ?? null,
    toTime: feeCoverage?.throughTime ?? null,
  });
  chain(
    "jobs-report.json",
    "fee_transfers",
    "The unofficial Jobs Report tally: per UTC day of the indexed range, IMD paid to the swarm, payments and distinct payers, HOUSE and OUTSIDE. Every Transfer log to the fee payee is a payment, zero-value ones included (zeroValueLogs says how many), as the official hires feed counts.",
    days.map((day) => ({
      day: day.day,
      complete: day.complete,
      firstBlock: day.firstBlock,
      lastBlock: day.lastBlock,
      ...showTally(day),
    })),
    {
      unofficial: true,
      coverage: feeCoverage,
      houseAddresses: houseList,
      total: showTally(tallyAll(transfers, house)),
      topPayers: rankPayers(transfers, house, 25).map((payer) => ({
        payer: payer.payer,
        amountWei: payer.amount,
        amountImd: formatImd(payer.amount),
        payments: payer.payments,
        label: payer.house ? "HOUSE" : "OUTSIDE",
      })),
    },
  );

  // Our own contracts. Listed even while empty, so the pack's shape never changes; each file says
  // through `handler` whether its table is being filled at all.
  chain(
    "orders.json",
    "work_orders",
    "Orders on the hire desk.",
    await db.select().from(orders).orderBy(asc(orders.id)),
  );
  chain(
    "claims.json",
    "work_orders",
    "Claims runners made on orders.",
    await db.select().from(claims).orderBy(asc(claims.orderId), asc(claims.seq)),
  );
  chain("pots.json", "crowd_pots", "Crowd pots.", await db.select().from(pots).orderBy(asc(pots.id)));
  chain(
    "chips.json",
    "crowd_pots",
    "Each contributor's stake in each pot.",
    await db.select().from(chips).orderBy(asc(chips.potId), asc(chips.contributor)),
  );
  chain(
    "feeds.json",
    "questions",
    "Standing Questions feeds.",
    await db.select().from(feeds).orderBy(asc(feeds.feedId)),
  );
  chain(
    "rounds.json",
    "questions",
    "Rounds bought by the feeds.",
    await db.select().from(rounds).orderBy(asc(rounds.feedId), asc(rounds.round)),
  );
  chain(
    "prints.json",
    "jobs_report",
    "Prints of the Robot Jobs Report.",
    await db.select().from(prints).orderBy(asc(prints.index)),
  );
  chain(
    "payroll-movements.json",
    "payroll",
    "Payroll's ledger.",
    await db
      .select()
      .from(payrollMovements)
      .orderBy(asc(payrollMovements.blockNumber), asc(payrollMovements.logIndex)),
  );
  chain("rules.json", "rules", "WHEN/THEN rules.", await db.select().from(rules).orderBy(asc(rules.id)));

  const ownEvents = await db
    .select(getTableColumns(events))
    .from(events)
    .innerJoin(
      cursors,
      and(
        eq(cursors.module, events.module),
        gte(events.blockNumber, cursors.startBlock),
        lt(events.blockNumber, cursors.nextBlock),
      ),
    )
    .where(
      and(
        notInArray(
          events.module,
          EXTERNAL_MODULES.map((module) => module.name),
        ),
        cut ? lte(events.blockNumber, cut.block) : undefined,
      ),
    )
    .orderBy(asc(events.blockNumber), asc(events.logIndex), asc(events.module));
  out.push({
    name: "own-events.json",
    source: "chain",
    rows: ownEvents.length,
    value: {
      about:
        "Every log of HELP WANTED's own contracts inside each module's indexed range, raw and decoded. (The logs of IdentityMD's contracts are in the files above.) The logs of launch A's contracts are decoded with their generated ABIs. While a module's handler is a stub its logs are stored undecoded: `event` is topic0 and `args` is null.",
      rows: ownEvents,
    },
  });

  api(
    "mirror-health.json",
    "The IdentityMD API's /health, one copy per UTC hour.",
    await db.select().from(apiHealth).orderBy(asc(apiHealth.hour)),
  );
  const watched = await db.select().from(apiJobs).where(eq(apiJobs.watched, true)).orderBy(asc(apiJobs.id));
  const watchedWithRecords = [];
  for (const job of watched) {
    watchedWithRecords.push({
      ...job,
      records: await db
        .select()
        .from(apiJobRecords)
        .where(eq(apiJobRecords.jobId, job.id))
        .orderBy(asc(apiJobRecords.recordId)),
    });
  }
  api(
    "mirror-watched-jobs.json",
    "The swarm jobs we watch, in full, with their work records.",
    watchedWithRecords,
  );
  api(
    "mirror-oracle-requests.json",
    "Oracle requests as the IdentityMD API lists them.",
    await db
      .select()
      .from(apiOracleRequests)
      .orderBy(asc(apiOracleRequests.createdAt), asc(apiOracleRequests.id)),
  );

  return out;
}

/**
 * Builds every file's contents without touching the disk: name → value. Split from the writing so
 * a test can compare two snapshots in memory.
 *
 * With a cut, the chain files hold the store as of that block (see the file header).
 *
 * Everything is read inside one transaction at isolation level "repeatable read", so the files
 * describe one state of the database even while an indexer is writing to it, and the transaction
 * is always rolled back, so the rebuild at the cut changes nothing. Should the indexer change a
 * row at the very moment the snapshot is rebuilding it, Postgres ends the transaction with a
 * serialization error; nothing has been written, and the command is simply run again.
 */
export async function buildSnapshot(db: Db, options: SnapshotOptions = {}): Promise<BuiltFile[]> {
  const cut = options.cut ?? null;
  const result: { files: BuiltFile[] | null } = { files: null };
  try {
    await db.transaction(
      async (tx) => {
        if (cut !== null) {
          for (const module of options.modules ?? ALL_MODULES) {
            const above = await tx.$count(
              events,
              and(eq(events.module, module.name), gt(events.blockNumber, cut.block)),
            );
            // Without a log above the cut the module's tables already are what they were at the cut.
            if (above > 0) await replayModule(tx, module, { through: cut.block });
          }
        }
        result.files = await build(tx, options, cut);
        throw new Undo();
      },
      { isolationLevel: "repeatable read" },
    );
  } catch (error) {
    if (!(error instanceof Undo)) throw error;
  }
  if (result.files === null) throw new Error("the snapshot could not be built");
  return result.files;
}

/** Writes the snapshot into `dir` (created if missing) and returns what was written. */
export async function writeSnapshot(
  db: Db,
  dir: string,
  options: SnapshotOptions = {},
): Promise<SnapshotResult> {
  const cut = options.cut ?? null;
  const built = await buildSnapshot(db, options);
  // Every file is turned into text before the first is written, so a value that cannot be
  // written leaves no half-finished pack behind.
  const texts = built.map((file) => ({ file, text: stableStringify(file.value) }));
  await mkdir(dir, { recursive: true });
  const files: SnapshotFile[] = [];
  for (const { file, text } of texts) {
    await writeFile(join(dir, file.name), text);
    files.push({
      name: file.name,
      source: file.source,
      rows: file.rows,
      bytes: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
    });
  }
  files.sort((a, b) => (a.name < b.name ? -1 : 1));
  const manifest = stableStringify({
    about:
      "Written by `pnpm --filter @help-wanted/indexer snapshot`. Files with source `chain` depend only on Ethereum logs up to the block named in `cut`; files with source `api` are copies of the public IdentityMD API.",
    cut,
    files,
  });
  await writeFile(join(dir, "manifest.json"), manifest);
  return { dir, cut, files };
}
