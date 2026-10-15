/**
 * @help-wanted/indexer: what other packages import.
 *
 * - `openDatabase`, `createQueries`   open the indexer's database and read it through typed functions
 * - `tally*`, `rankPayers`, …         the Jobs Report arithmetic, as pure functions
 * - `createApp`                       the read-only JSON API as a `Request → Response` function
 * - `writeSnapshot`                   the deterministic evidence files
 * - `Indexer`, `ContractModule`       the sync engine and the shape of a module, for adding a contract
 *
 * Table definitions are at `@help-wanted/indexer/schema`. Nothing in this package signs, sends a
 * transaction or holds a key.
 */
export { openDatabase } from "./db/client.js";
export type { Database, Db, OpenDatabaseOptions } from "./db/client.js";

export { createQueries } from "./queries.js";
export type {
  ApiHealthRow,
  ApiJobRecordRow,
  ApiJobRow,
  ApiOracleRequestRow,
  ChainSource,
  ChipRow,
  ClaimRow,
  FeedRow,
  FeeTransferRow,
  IntakeRequestRow,
  JobReceipts,
  JobsReportDaily,
  JobsReportWindow,
  ModuleCoverage,
  OrderRow,
  PayrollMovementRow,
  PotRow,
  PrintRow,
  Queries,
  QueryOptions,
  ReceiptRow,
  RoundRow,
  RuleRow,
  StoreStatus,
} from "./queries.js";
export type { EventRow } from "./db/core.js";

export { dayStart, formatImd, rankPayers, tallyAll, tallyByDay, utcDay } from "./report/tally.js";
export type { Coverage, DayTally, PayerTally, Split, Tally, TransferRow } from "./report/tally.js";

export { isUuid, jobIdToUuid, normalizeJobId, uuidToJobId } from "./ids.js";
export { JsonTooDeepError, MAX_JSON_DEPTH, MAX_STORED_JSON_DEPTH, stableStringify, toJson } from "./json.js";
export type { JsonValue } from "./json.js";

export { createApp } from "./http/app.js";
export type { AppOptions } from "./http/app.js";
export { serve } from "./http/server.js";

export { buildSnapshot, chooseCut, DEFAULT_SNAPSHOT_DIR, writeSnapshot } from "./snapshot.js";
export type { SnapshotCut, SnapshotFile, SnapshotOptions, SnapshotResult } from "./snapshot.js";

export { loadConfig, loadHouseAddresses, parseStartBlock } from "./config.js";
export type { Config, MirrorConfig, StartBlock, SyncConfig } from "./config.js";
export { moduleNameOf, NO_DEPLOYMENTS, OWN_CONTRACTS } from "./deployments.js";
export type { Deployments, OwnContract } from "./deployments.js";

export { Indexer, MissingStartBlockError } from "./engine/indexer.js";
export type {
  IndexerLive,
  IndexerOptions,
  ModuleLive,
  ModuleProgress,
  SkipResult,
  TickReport,
} from "./engine/indexer.js";
export type { ReplayResult } from "./engine/store.js";
export type { ContractModule, IndexedEvent, LogFilter, LogTopic } from "./engine/module.js";
export { ALL_MODULES, EXTERNAL_MODULES, OWN_MODULES } from "./modules/index.js";

export { ApiMirror } from "./mirror/poller.js";
export { PoliteFetcher } from "./mirror/politeFetch.js";

export * as constants from "./constants.js";
