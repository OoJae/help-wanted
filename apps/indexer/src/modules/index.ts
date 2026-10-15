/**
 * Every module the indexer runs, in the order the status page lists them.
 *
 * The first three read IdentityMD's own contracts and are complete. The rest are HELP WANTED's
 * contracts: each has tables and a place in the engine and stays idle until its address is in the
 * deployments book (or the environment). Launch A's three (Questions, JobsReport, Payroll) are
 * launched and fold their events. Launch B's three (WorkOrders, CrowdPots, Doorbell) are launched
 * too: their logs are stored from the launch block on, and their handlers are still stubs, as are
 * launch C's, which is not launched (see `own/stub.ts`).
 */
import type { ContractModule } from "../engine/module.js";
import { feeTransfersModule } from "./feeTransfers.js";
import { intakeModule } from "./intake.js";
import { crowdPotsModule } from "./own/crowdPots.js";
import { jobsReportModule } from "./own/jobsReport.js";
import { payrollModule } from "./own/payroll.js";
import { questionsModule } from "./own/questions.js";
import { rulesModule } from "./own/rules.js";
import { ownModule } from "./own/stub.js";
import { workOrdersModule } from "./own/workOrders.js";
import { workRegistryModule } from "./workRegistry.js";

/**
 * Contracts whose logs are worth keeping but that need no table of their own yet. Their events
 * are in `events`, which is enough for a count or a history list. The Doorbell, as launched
 * (13 October 2026), emits Rang, Hired, HireSkipped and Delivered; its module has no ABI yet, so
 * those logs are stored undecoded. As the source stood on 11 October 2026, Endowments emits
 * Created, Deposited, Donated, Staked, Settled, Withdrawn, Harvested, MeterFunded, FallbackPaid
 * and PriceMarked; Zap emits ChippedIn, MeterFunded and Bought.
 */
const doorbellModule = ownModule({
  name: "doorbell",
  title: "Doorbell: rings and hires (logs kept, no table)",
  contract: "doorbell",
  tables: [],
});
const endowmentsModule = ownModule({
  name: "endowments",
  title: "Endowments: deposits and harvests (logs kept, no table)",
  contract: "endowments",
  tables: [],
});
const zapModule = ownModule({
  name: "zap",
  title: "Zap: ETH paid in (logs kept, no table)",
  contract: "zap",
  tables: [],
});

export const EXTERNAL_MODULES: ContractModule[] = [workRegistryModule, intakeModule, feeTransfersModule];

export const OWN_MODULES: ContractModule[] = [
  questionsModule,
  jobsReportModule,
  payrollModule,
  workOrdersModule,
  crowdPotsModule,
  doorbellModule,
  rulesModule,
  endowmentsModule,
  zapModule,
];

export const ALL_MODULES: ContractModule[] = [...EXTERNAL_MODULES, ...OWN_MODULES];

export function findModule(name: string, modules: ContractModule[] = ALL_MODULES): ContractModule {
  const found = modules.find((module) => module.name === name);
  if (!found) {
    throw new Error(`unknown module "${name}"; known: ${modules.map((module) => module.name).join(", ")}`);
  }
  return found;
}

export { feeTransfersModule, intakeModule, workRegistryModule };
