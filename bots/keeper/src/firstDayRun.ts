/**
 * Runs the first-day runbook: prints every step, and in a live run that the operator confirmed,
 * sends them one at a time, looking at the chain again after each.
 */
import type { Address } from "viem";
import type { Waiting } from "./actions.js";
import { observeFirstDay, planFirstDay, type FirstDayPlan, type FirstDayResult } from "./firstDay.js";
import { execute, statusOf, type Runtime } from "./pass.js";
import { writeStatus, type ActionRecord } from "./status.js";
import { messageOf } from "./observe/common.js";

/** Far more than the eleven steps there are: a guard against a step that never shows as done. */
const MAX_STEPS = 24;

async function planNow(rt: Runtime): Promise<FirstDayPlan> {
  const block = await rt.reader.getBlock();
  const snapshot = await observeFirstDay(
    {
      reader: rt.reader,
      api: rt.api,
      store: rt.store,
      log: rt.log,
      cache: rt.cache,
      block,
      chainId: rt.config.chainId,
      keeper: rt.config.keeper,
    },
    {
      questions: rt.config.questions as Address,
      jobsReport: rt.config.jobsReport,
      payroll: rt.config.payroll,
      expected: rt.config.expected,
      feeds: rt.config.feeds,
      fund: rt.config.firstDayFund,
    },
  );
  return planFirstDay(snapshot);
}

function print(rt: Runtime, plan: FirstDayPlan): void {
  plan.steps.forEach((step, index) => {
    rt.log.info(`first day, step ${index + 1} of ${plan.steps.length}: ${step.title}`, {
      id: step.id,
      status: step.status,
      detail: step.detail,
      ...(step.action === undefined
        ? {}
        : { to: step.action.call.address, function: step.action.call.functionName }),
    });
  });
  rt.log.info("first day: plan digest", { digest: plan.digest });
}

export async function runFirstDay(rt: Runtime): Promise<FirstDayResult> {
  if (rt.config.questions === null) throw new Error("the first day needs QUESTIONS");
  const records: ActionRecord[] = [];
  let plan = await planNow(rt);
  let stopped: string | null = null;
  print(rt, plan);

  const blocked = plan.steps.filter((step) => step.status === "blocked");
  if (rt.writer.mode === "dry-run") {
    // Simulate what could be sent now. Steps that follow others cannot be simulated before those
    // are on chain; they are listed with what they will send.
    const ready = plan.steps.flatMap((step) => (step.status === "todo" && step.action ? [step.action] : []));
    records.push(...(await execute(rt, ready)).records);
    for (const step of plan.steps) {
      if (step.status === "later" && step.action) {
        records.push({
          module: "firstDay",
          kind: step.action.kind,
          subject: step.action.subject,
          label: step.action.label,
          reason: step.action.reason,
          outcome: "planned",
        });
      }
    }
    rt.log.info(
      blocked.length > 0
        ? `DRY RUN (${rt.config.dryRunReason}): nothing was signed and nothing was sent. ${blocked.length} step(s) are blocked, and a live run would send nothing until they are cleared: ${blocked[0]?.title}: ${blocked[0]?.detail}`
        : `DRY RUN (${rt.config.dryRunReason}): nothing was signed and nothing was sent. To send these steps, read them, then run the same command with LIVE=1 and FIRST_DAY_CONFIRM=${plan.digest}`,
    );
  } else if (blocked.length > 0) {
    stopped = `nothing was sent: ${blocked.map((step) => `${step.title}: ${step.detail}`).join("; ")}`;
  } else if (rt.config.firstDayConfirm !== plan.digest) {
    stopped =
      rt.config.firstDayConfirm === null
        ? `nothing was sent: a live first day needs FIRST_DAY_CONFIRM=${plan.digest}, the digest of the plan above, to show that its dry run was read`
        : `nothing was sent: FIRST_DAY_CONFIRM is not the digest of this plan (${plan.digest}). Something changed since the dry run: read the plan again`;
  } else {
    for (let sent = 0; sent < MAX_STEPS; sent++) {
      const next = plan.steps.find((step) => step.status === "todo" && step.action !== undefined);
      if (next === undefined || next.action === undefined) break;
      const result = await execute(rt, [next.action]);
      records.push(...result.records);
      if (result.sent === 0 || result.records.some((record) => record.outcome === "failed")) {
        stopped = `stopped at "${next.title}": ${result.records.at(-1)?.error ?? "it was not sent"}. Run the command again to go on from here`;
        break;
      }
      plan = await planNow(rt);
    }
  }
  if (stopped !== null) rt.log.error(`first day: ${stopped}`);

  const complete = plan.steps.every((step) => step.status === "done");
  const waiting: Waiting[] = plan.steps
    .filter((step) => step.status !== "done")
    .map((step) => ({
      module: "firstDay",
      subject: step.id,
      reason: `${step.title}: ${step.status}. ${step.detail}`,
      ...(step.status === "blocked" ? { attention: true } : {}),
    }));
  try {
    const status = await statusOf(rt, "first-day", null, records, []);
    status.waiting = waiting;
    status.attention.push(...waiting.filter((w) => w.attention).map((w) => `${w.subject}: ${w.reason}`));
    if (stopped !== null) status.attention.push(stopped);
    status.firstDay = {
      digest: plan.digest,
      complete,
      steps: plan.steps.map(({ action: _action, ...step }) => step),
    };
    writeStatus(rt.config.statusPath, status);
  } catch (error) {
    rt.log.error("the status file could not be written", { error: messageOf(error) });
  }
  if (complete) rt.log.info("first day: every step is on chain");
  return { plan, complete, stopped };
}
