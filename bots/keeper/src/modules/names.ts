/**
 * The names a module is switched on or off by (`MODULES=questions,jobsReport,payroll,desk`).
 *
 * Launch A: `questions`, `jobsReport`, `payroll`.
 * Launch B: `desk` (the hire desk's open buttons and the watch on delivery claims), `pots` (crowd
 * pots), `doorbell` (reported in the status file; the keeper never rings).
 * Launch C: `rules`, `endowments`.
 *
 * A module runs only when the addresses it needs are known: from the deployments book of the
 * shared package once its launch is written there, or from the environment. With `MODULES` unset,
 * every module whose addresses are known runs; naming a module whose addresses are missing is an
 * error that says which one to set.
 */
export const BUILT_MODULES = [
  "questions",
  "jobsReport",
  "payroll",
  "desk",
  "pots",
  "doorbell",
  "rules",
  "endowments",
] as const;
export type ModuleName = (typeof BUILT_MODULES)[number];

/** Which launch a module belongs to. */
export const MODULE_LAUNCH: Readonly<Record<ModuleName, "A" | "B" | "C">> = {
  questions: "A",
  jobsReport: "A",
  payroll: "A",
  desk: "B",
  pots: "B",
  doorbell: "B",
  rules: "C",
  endowments: "C",
};
