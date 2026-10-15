import { decodeFunctionData, type Abi, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { HOUSE_FEEDS, MAINNET, erc20Abi, questionsAbi, type HouseFeed } from "@help-wanted/shared";
import {
  defaultFund,
  planDigest,
  planFirstDay,
  type FirstDayFeed,
  type FirstDaySnapshot,
} from "../src/firstDay.js";
import { IMD, JOBS_REPORT, KEEPER, PAYROLL, QUESTIONS } from "./factories.js";

const { payrolls, hires, employers } = HOUSE_FEEDS;
const PRICE = IMD(0.5);
const IDS: [Hex, Hex, Hex] = [payrolls.id, hires.id, employers.id];

const feedRow = (feed: HouseFeed, over: Partial<FirstDayFeed> = {}): FirstDayFeed => ({
  feed,
  exists: false,
  rounds: 0n,
  meterBalance: 0n,
  operatorShares: 0n,
  // Blocker 1: the feed is unknown.
  canRequest: { ok: false, why: 1 },
  fund: defaultFund(feed, PRICE),
  ...over,
});

/** Right after the launch: three contracts, no feeds, a wallet with IMD and no allowance. */
function fresh(over: Partial<FirstDaySnapshot> = {}): FirstDaySnapshot {
  return {
    chainId: 1,
    questions: QUESTIONS,
    jobsReport: JOBS_REPORT,
    payroll: PAYROLL,
    operator: KEEPER,
    expected: { intake: MAINNET.INTAKE, imd: MAINNET.IMD, oracleSigner: MAINNET.ORACLE_SIGNER },
    deployed: {
      intake: MAINNET.INTAKE,
      imd: MAINNET.IMD,
      oracleSigner: MAINNET.ORACLE_SIGNER,
      price: PRICE,
      jobsReport: { questions: QUESTIONS, feeds: IDS },
      payroll: { questions: QUESTIONS, feeds: IDS },
    },
    operatorImd: IMD(100),
    operatorAllowance: 0n,
    feeds: [feedRow(payrolls), feedRow(hires), feedRow(employers)],
    ...over,
  };
}

const statuses = (snapshot: FirstDaySnapshot) =>
  planFirstDay(snapshot).steps.map((s) => `${s.id}=${s.status}`);
const step = (snapshot: FirstDaySnapshot, id: string) => {
  const found = planFirstDay(snapshot).steps.find((s) => s.id === id);
  if (!found) throw new Error(`no step ${id}`);
  return found;
};
const created = (feed: HouseFeed, over: Partial<FirstDayFeed> = {}) =>
  // Blocker 9: the meter is too low.
  feedRow(feed, { exists: true, canRequest: { ok: false, why: 9 }, ...over });
const funded = (feed: HouseFeed, over: Partial<FirstDayFeed> = {}) =>
  feedRow(feed, {
    exists: true,
    meterBalance: defaultFund(feed, PRICE),
    operatorShares: defaultFund(feed, PRICE),
    canRequest: { ok: true, why: 0 },
    ...over,
  });

describe("the amounts", () => {
  it("puts one runway on each meter: 14, 14 and 4 requests at the live price and the tip", () => {
    expect(defaultFund(payrolls, PRICE)).toBe(IMD(7.7));
    expect(defaultFund(hires, PRICE)).toBe(IMD(7.7));
    expect(defaultFund(employers, PRICE)).toBe(IMD(2.2));
    // The runway follows the Intake's price.
    expect(defaultFund(payrolls, IMD(1))).toBe(IMD(14.7));
  });
});

describe("the plan on the first day", () => {
  it("lists the eleven steps in the runbook's order", () => {
    expect(statuses(fresh())).toEqual([
      "check=done",
      "create:payrolls=todo",
      "create:hires=todo",
      "create:employers=todo",
      "approve=todo",
      "fund:payrolls=later",
      "fund:hires=later",
      "fund:employers=later",
      "request:payrolls=later",
      "request:hires=later",
      "request:employers=later",
    ]);
  });

  it("creates each feed with exactly the parameters and bytes of launch A's fixture", () => {
    for (const feed of [payrolls, hires, employers]) {
      const action = step(fresh(), `create:${feed.name}`).action;
      expect(action?.call.address).toBe(QUESTIONS);
      expect(action?.call.functionName).toBe("createFeed");
      expect(action?.call.args).toEqual([feed.params, feed.qPrefix, feed.tail]);
    }
  });

  it("approves exactly what the meters get, and funds each with its runway", () => {
    const approve = step(fresh(), "approve").action;
    expect(approve?.call).toMatchObject({
      address: MAINNET.IMD,
      functionName: "approve",
      args: [QUESTIONS, IMD(17.6)],
    });
    const fund = step(fresh(), "fund:employers").action;
    expect(fund?.call).toMatchObject({
      address: QUESTIONS,
      functionName: "fund",
      args: [employers.id, IMD(2.2)],
    });
    expect(step(fresh(), "fund:employers").detail).toContain(
      "follows the creation of the feed and the approval",
    );
  });

  it("uses the operator's own amounts when given", () => {
    const snapshot = fresh({
      feeds: [feedRow(payrolls, { fund: IMD(3) }), feedRow(hires, { fund: 0n }), feedRow(employers)],
    });
    expect(step(snapshot, "approve").action?.call.args).toEqual([QUESTIONS, IMD(5.2)]);
    expect(step(snapshot, "fund:hires").status).toBe("done");
    expect(step(snapshot, "fund:hires").detail).toContain("nothing is to be put");
  });

  it("asks each feed in a call of its own", () => {
    const requests = planFirstDay(fresh()).steps.filter((s) => s.id.startsWith("request:"));
    expect(requests.map((s) => s.action?.call.args)).toEqual([[payrolls.id], [hires.id], [employers.id]]);
    for (const request of requests) expect(request.action?.call.functionName).toBe("request");
  });
});

describe("picking up where it stopped", () => {
  it("skips a feed that exists, whoever created it", () => {
    const snapshot = fresh({ feeds: [created(payrolls), feedRow(hires), feedRow(employers)] });
    expect(step(snapshot, "create:payrolls").status).toBe("done");
    expect(step(snapshot, "create:payrolls").action).toBeUndefined();
    expect(step(snapshot, "create:hires").status).toBe("todo");
    // The feed exists, the allowance does not: funding follows the approval.
    expect(step(snapshot, "fund:payrolls")).toMatchObject({
      status: "later",
      detail: "follows the approval",
    });
  });

  it("funds a meter once its feed exists and the allowance covers it", () => {
    const snapshot = fresh({
      operatorAllowance: IMD(17.6),
      feeds: [created(payrolls), created(hires), created(employers)],
    });
    expect(statuses(snapshot)).toEqual([
      "check=done",
      "create:payrolls=done",
      "create:hires=done",
      "create:employers=done",
      "approve=done",
      "fund:payrolls=todo",
      "fund:hires=todo",
      "fund:employers=todo",
      "request:payrolls=later",
      "request:hires=later",
      "request:employers=later",
    ]);
    // An allowance of exactly this meter's amount is enough for it.
    const exact = fresh({
      operatorAllowance: IMD(7.7),
      feeds: [created(payrolls), created(hires), created(employers)],
    });
    expect(step(exact, "fund:payrolls").status).toBe("todo");
    // An allowance one wei short of this meter's amount does not make its funding ready.
    const short = fresh({
      operatorAllowance: IMD(7.7) - 1n,
      feeds: [created(payrolls), created(hires), created(employers)],
    });
    expect(step(short, "fund:payrolls").status).toBe("later");
    expect(step(short, "fund:employers").status).toBe("todo");
  });

  it("approves only for the meters still to fund", () => {
    const snapshot = fresh({ feeds: [funded(payrolls), created(hires), created(employers)] });
    expect(step(snapshot, "approve").action?.call.args).toEqual([QUESTIONS, IMD(9.9)]);
    expect(step(snapshot, "fund:payrolls").status).toBe("done");
  });

  it("counts a meter as funded when this wallet holds shares of it, or it already holds its amount", () => {
    // After the first request the meter is below the amount, and the wallet still holds its shares.
    const spent = funded(payrolls, { meterBalance: IMD(7.15), rounds: 1n });
    expect(step(fresh({ feeds: [spent, funded(hires), funded(employers)] }), "fund:payrolls").status).toBe(
      "done",
    );
    // Somebody else filled it.
    const byOthers = created(hires, {
      meterBalance: IMD(7.7),
      operatorShares: 0n,
      canRequest: { ok: true, why: 0 },
    });
    const snapshot = fresh({ feeds: [funded(payrolls), byOthers, funded(employers)] });
    expect(step(snapshot, "fund:hires")).toMatchObject({ status: "done" });
    expect(step(snapshot, "fund:hires").detail).toContain("the meter already holds");
    // One wei short of the amount, with no shares of its own: still to fund.
    const nearly = created(hires, { meterBalance: IMD(7.7) - 1n });
    expect(
      step(fresh({ feeds: [funded(payrolls), nearly, funded(employers)] }), "fund:hires").status,
    ).not.toBe("done");
  });

  it("makes the first requests once the meters are funded", () => {
    const snapshot = fresh({ feeds: [funded(payrolls), funded(hires), funded(employers)] });
    expect(statuses(snapshot).filter((line) => line.startsWith("request:"))).toEqual([
      "request:payrolls=todo",
      "request:hires=todo",
      "request:employers=todo",
    ]);
    // No approve step at all when nothing is left to fund.
    expect(planFirstDay(snapshot).steps.some((s) => s.id === "approve")).toBe(false);
  });

  it("skips a feed that has already been asked", () => {
    const snapshot = fresh({
      feeds: [
        funded(payrolls, { rounds: 1n, canRequest: { ok: false, why: 3 } }),
        funded(hires),
        funded(employers),
      ],
    });
    expect(step(snapshot, "request:payrolls").status).toBe("done");
    expect(step(snapshot, "request:hires").status).toBe("todo");
  });

  it("is finished when every step is done, and then sends nothing", () => {
    const done = (feed: HouseFeed) => funded(feed, { rounds: 1n, canRequest: { ok: false, why: 3 } });
    const plan = planFirstDay(fresh({ feeds: [done(payrolls), done(hires), done(employers)] }));
    expect(plan.steps.every((s) => s.status === "done")).toBe(true);
    expect(plan.steps.every((s) => s.action === undefined)).toBe(true);
  });
});

describe("what stops it", () => {
  const blockedAll = (snapshot: FirstDaySnapshot) => {
    const plan = planFirstDay(snapshot);
    expect(plan.steps[0]?.status).toBe("blocked");
    expect(plan.steps.every((s) => s.status === "blocked" || s.status === "done")).toBe(true);
    expect(plan.steps.every((s) => s.action === undefined)).toBe(true);
    return plan.steps[0]?.detail ?? "";
  };
  const deployed = fresh().deployed;

  it("a Questions built on another Intake, token or oracle signer: nothing is sent", () => {
    expect(blockedAll(fresh({ deployed: { ...deployed, intake: MAINNET.INTAKE_V1 } }))).toContain(
      "Questions.INTAKE is",
    );
    expect(blockedAll(fresh({ deployed: { ...deployed, imd: MAINNET.SIMD } }))).toContain("Questions.IMD is");
    expect(blockedAll(fresh({ deployed: { ...deployed, oracleSigner: KEEPER } }))).toContain(
      "Questions.oracleSigner is",
    );
  });

  it("a JobsReport or Payroll bound to another Questions or to other feed ids", () => {
    expect(
      blockedAll(fresh({ deployed: { ...deployed, jobsReport: { questions: PAYROLL, feeds: IDS } } })),
    ).toContain("JobsReport.QUESTIONS is");
    // The old employers id, from before the feed was rewritten.
    const old = "0xc09b49435a17cb78599285e972df2f6f095b0f49658a8279812f653670633817";
    expect(
      blockedAll(
        fresh({ deployed: { ...deployed, payroll: { questions: QUESTIONS, feeds: [IDS[0], IDS[1], old] } } }),
      ),
    ).toContain("Payroll is bound to");
    // Payrolls and hires swapped: Payroll would serve the wrong feed first.
    expect(
      blockedAll(
        fresh({
          deployed: { ...deployed, payroll: { questions: QUESTIONS, feeds: [IDS[1], IDS[0], IDS[2]] } },
        }),
      ),
    ).toContain("Payroll is bound to");
  });

  it("an Intake that does not sell the action, and a chain the feeds are not about", () => {
    expect(blockedAll(fresh({ deployed: { ...deployed, price: 0n } }))).toContain("does not sell");
    expect(blockedAll(fresh({ chainId: 11155111 }))).toContain("this is chain 11155111");
  });

  it("checks what it can when JobsReport or Payroll is not configured", () => {
    const plan = planFirstDay(
      fresh({ jobsReport: null, payroll: null, deployed: { ...deployed, jobsReport: null, payroll: null } }),
    );
    expect(plan.steps[0]?.status).toBe("done");
  });

  it("a wallet that does not hold the IMD: the feeds can be created, the funding is blocked", () => {
    const snapshot = fresh({ operatorImd: IMD(17.6) - 1n });
    expect(step(snapshot, "create:payrolls").status).toBe("todo");
    expect(step(snapshot, "approve")).toMatchObject({ status: "blocked" });
    expect(step(snapshot, "approve").detail).toContain("the meters are to get");
    expect(step(snapshot, "fund:payrolls").status).toBe("blocked");
    // Exactly enough is enough.
    expect(step(fresh({ operatorImd: IMD(17.6) }), "approve").status).toBe("todo");
  });

  it("no wallet address: the plan is still printed, and the steps that need one say so", () => {
    const snapshot = fresh({ operator: null, operatorImd: null, operatorAllowance: null });
    expect(step(snapshot, "create:hires").status).toBe("todo");
    expect(step(snapshot, "approve").detail).toContain("KEEPER_ADDRESS");
    expect(step(snapshot, "fund:hires").status).toBe("blocked");
  });

  it("a request the contract refuses for a reason the runbook cannot cure", () => {
    // Blocker 8: the Intake's price is above the feed's cap.
    const snapshot = fresh({
      feeds: [funded(payrolls, { canRequest: { ok: false, why: 8 } }), funded(hires), funded(employers)],
    });
    expect(step(snapshot, "request:payrolls")).toMatchObject({
      status: "blocked",
      detail: "canRequest says no: PriceAboveCap",
    });
  });
});

describe("the digest a live run is confirmed with", () => {
  it("is the same however far the runbook has got", () => {
    const start = planDigest(fresh());
    expect(start).toMatch(/^0x[0-9a-f]{64}$/);
    const midway = fresh({
      operatorAllowance: IMD(9.9),
      feeds: [funded(payrolls, { rounds: 1n }), created(hires), feedRow(employers)],
    });
    expect(planDigest(midway)).toBe(start);
    expect(planFirstDay(midway).digest).toBe(start);
  });

  it("changes with anything that changes what is sent or where", () => {
    const start = planDigest(fresh());
    const other: Address = "0x000000000000000000000000000000000000dEaD";
    expect(planDigest(fresh({ questions: other }))).not.toBe(start);
    expect(planDigest(fresh({ operator: other }))).not.toBe(start);
    expect(planDigest(fresh({ payroll: other }))).not.toBe(start);
    expect(planDigest(fresh({ chainId: 5 }))).not.toBe(start);
    expect(
      planDigest(
        fresh({ feeds: [feedRow(payrolls, { fund: IMD(7.7) + 1n }), feedRow(hires), feedRow(employers)] }),
      ),
    ).not.toBe(start);
    expect(planDigest(fresh({ feeds: [feedRow(payrolls), feedRow(hires)] }))).not.toBe(start);
    const tampered = { ...payrolls, tail: `${payrolls.tail}20` as Hex };
    expect(planDigest(fresh({ feeds: [feedRow(tampered), feedRow(hires), feedRow(employers)] }))).not.toBe(
      start,
    );
  });
});

describe("the calldata", () => {
  it("of each createFeed is what launch A's document publishes, when the document is there", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { encodeFunctionData } = await import("viem");
    const path = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "launches",
      "a-payroll",
      "docs",
      "LAUNCH.md",
    );
    if (!existsSync(path)) return;
    const text = readFileSync(path, "utf8");
    for (const feed of [payrolls, hires, employers]) {
      const published = new RegExp(`<!-- createFeed:${feed.name} -->\\s*\`\`\`text\\s*(0x[0-9a-f]+)`).exec(
        text,
      )?.[1];
      expect(published, feed.name).toBeDefined();
      const action = step(fresh(), `create:${feed.name}`).action;
      const data = encodeFunctionData({
        abi: questionsAbi as unknown as Abi,
        functionName: "createFeed",
        args: action?.call.args as unknown[],
      });
      expect(data, feed.name).toBe(published);
      expect(decodeFunctionData({ abi: questionsAbi, data }).functionName).toBe("createFeed");
    }
    // And the approval is a plain ERC-20 approve.
    const approve = step(fresh(), "approve").action;
    expect(encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [QUESTIONS, IMD(17.6)] })).toBe(
      encodeFunctionData({
        abi: approve?.call.abi as Abi,
        functionName: "approve",
        args: approve?.call.args as unknown[],
      }),
    );
  });
});
