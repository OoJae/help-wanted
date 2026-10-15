/**
 * Every table, in one place. `drizzle-kit generate` reads this file to write the migrations under
 * `drizzle/`, and other packages import table definitions from here
 * (`@help-wanted/indexer/schema`).
 *
 * Three groups:
 *   - the engine's own: `cursors`, `events`
 *   - one group per module, defined beside its handler in `src/modules`
 *   - the API mirror, `api_*`
 */
export { cursors, events } from "./core.js";
export type { CursorRow, EventRow } from "./core.js";

export { receipts } from "../modules/workRegistry.js";
export { intakeRequests } from "../modules/intake.js";
export { feeTransfers } from "../modules/feeTransfers.js";

export { claims, orders, ORDER_STATES } from "../modules/own/workOrders.js";
export type { OrderState } from "../modules/own/workOrders.js";
export { chips, pots } from "../modules/own/crowdPots.js";
export { feeds, rounds, ROUND_STATUSES } from "../modules/own/questions.js";
export type { RoundStatus } from "../modules/own/questions.js";
export { prints } from "../modules/own/jobsReport.js";
export { payrollMovements, PAYROLL_KINDS } from "../modules/own/payroll.js";
export type { PayrollKind } from "../modules/own/payroll.js";
export { rules, RULE_ACTIONS } from "../modules/own/rules.js";
export type { RuleAction } from "../modules/own/rules.js";

export { apiHealth, apiJobRecords, apiJobs, apiOracleRequests } from "../mirror/tables.js";
