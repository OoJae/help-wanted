/**
 * The first day of launch A, step by step (launches/a-payroll/docs/LAUNCH.md, section 6).
 *
 * Nothing is called by the launch pipeline after deployment, so the feeds do not exist until
 * somebody creates them. The runbook is:
 *
 *   0. read back what was deployed and compare it with what the launch was meant to be;
 *   1. create the three house feeds, with the parameters and bytes of launch A's own fixtures;
 *   2. approve `Questions` for the IMD the meters get, and fund each meter from this wallet;
 *   3. make the first request of each feed, each as a transaction of its own.
 *
 * `planFirstDay` is a pure function: what the chain says in, the list of steps out, each marked
 * done, to do, or blocked, with the reason. A step that is already on chain is done, whoever did
 * it, so the command can be run again after a failure and picks up where it stopped.
 *
 * LIVE needs a confirmation. A dry run prints every step and a digest of the whole runbook (the
 * addresses, the feed ids, the exact calldata of each `createFeed`, the amounts). A live run goes
 * ahead only when `FIRST_DAY_CONFIRM` is that digest: the operator has seen, in a dry run, exactly
 * the steps that are about to be sent.
 *
 * Everything here is open to any caller. The one thing this command does that the daily keeper
 * never does is spend IMD: step 2 moves the wallet's own IMD onto the meters, where it stays this
 * wallet's to take back (`Questions.defund`) for as long as the meter has not spent it.
 */
import { encodeFunctionData, keccak256, stringToHex, type Abi, type Address, type Hex } from "viem";
import {
  REQUEST_BLOCKER,
  canonicalize,
  erc20Abi,
  feedIdOf,
  intakeAbi,
  jobsReportAbi,
  payrollAbi,
  questionsAbi,
  requestBlockerName,
  sameAddress,
  type HouseFeed,
} from "@help-wanted/shared";
import type { Action } from "./actions.js";
import type { ExpectedDeployment } from "./config.js";
import { messageOf, readAt, type ObserveContext } from "./observe/common.js";
import { big, num } from "./observe/questions.js";

const QUESTIONS_ABI = questionsAbi as unknown as Abi;
const JOBS_REPORT_ABI = jobsReportAbi as unknown as Abi;
const PAYROLL_ABI = payrollAbi as unknown as Abi;
const INTAKE_ABI = intakeAbi as unknown as Abi;
const ERC20_ABI = erc20Abi as unknown as Abi;

export interface FirstDayFeed {
  feed: HouseFeed;
  exists: boolean;
  rounds: bigint;
  meterBalance: bigint;
  /** The operator's shares of the meter. */
  operatorShares: bigint;
  /** `canRequest`, meaningful once the feed exists. */
  canRequest: { ok: boolean; why: number };
  /** What to put on the meter. */
  fund: bigint;
}

export interface FirstDaySnapshot {
  chainId: number;
  questions: Address;
  jobsReport: Address | null;
  payroll: Address | null;
  /** The wallet that sends the steps and funds the meters; null in a dry run with no address. */
  operator: Address | null;
  expected: ExpectedDeployment;
  /** What the deployed contracts say they were built on. */
  deployed: {
    intake: Address;
    imd: Address;
    oracleSigner: Address;
    /** The Intake's live price for the feeds' action, in IMD wei; zero when it is not sold. */
    price: bigint;
    jobsReport: { questions: Address; feeds: [Hex, Hex, Hex] } | null;
    payroll: { questions: Address; feeds: [Hex, Hex, Hex] } | null;
  };
  operatorImd: bigint | null;
  operatorAllowance: bigint | null;
  feeds: FirstDayFeed[];
}

export interface FirstDayStep {
  id: string;
  title: string;
  /**
   * `done`: already on chain. `todo`: can be sent now. `later`: will be sent once the steps before
   * it are on chain (it cannot be simulated before that). `blocked`: cannot be sent, and `detail`
   * says why.
   */
  status: "done" | "todo" | "later" | "blocked";
  detail: string;
  /** What is sent for a `todo` step, and what will be for a `later` one. */
  action?: Action;
}

export interface FirstDayPlan {
  steps: FirstDayStep[];
  /** The digest a live run must be confirmed with. */
  digest: Hex;
}

/** What a meter gets by default: the feed's runway (14 daily requests, 4 weekly) at the live cost. */
export function defaultFund(feed: HouseFeed, price: bigint): bigint {
  return BigInt(feed.runwayRequests) * (price + feed.params.tip);
}

function createFeedCall(questions: Address, feed: HouseFeed): Action["call"] {
  return {
    address: questions,
    abi: QUESTIONS_ABI,
    functionName: "createFeed",
    args: [feed.params, feed.qPrefix, feed.tail],
  };
}

/**
 * The digest of the whole runbook: every address, every feed id, the calldata of each
 * `createFeed` and every amount. It does not depend on how far the runbook has got, so the same
 * confirmation carries a run that is resumed after a failure.
 */
export function planDigest(snapshot: FirstDaySnapshot): Hex {
  const document = {
    chainId: snapshot.chainId,
    questions: snapshot.questions.toLowerCase(),
    jobsReport: snapshot.jobsReport?.toLowerCase() ?? null,
    payroll: snapshot.payroll?.toLowerCase() ?? null,
    operator: snapshot.operator?.toLowerCase() ?? null,
    intake: snapshot.deployed.intake.toLowerCase(),
    imd: snapshot.deployed.imd.toLowerCase(),
    oracleSigner: snapshot.deployed.oracleSigner.toLowerCase(),
    feeds: snapshot.feeds.map(({ feed, fund }) => ({
      name: feed.name,
      feedId: feed.id,
      createFeed: keccak256(
        encodeFunctionData({
          abi: QUESTIONS_ABI,
          functionName: "createFeed",
          args: [feed.params, feed.qPrefix, feed.tail],
        }),
      ),
      fund: fund.toString(),
    })),
  };
  return keccak256(stringToHex(canonicalize(document)));
}

/** What the chain says in, the steps out. Pure. */
export function planFirstDay(snapshot: FirstDaySnapshot): FirstDayPlan {
  const steps: FirstDayStep[] = [];
  const { deployed, expected, questions } = snapshot;

  // Step 0: is this the launch it is meant to be?
  const wrong: string[] = [];
  const same = (what: string, got: string, want: string) => {
    if (!sameAddress(got, want)) wrong.push(`${what} is ${got}, expected ${want}`);
  };
  same("Questions.INTAKE", deployed.intake, expected.intake);
  same("Questions.IMD", deployed.imd, expected.imd);
  same("Questions.oracleSigner", deployed.oracleSigner, expected.oracleSigner);
  const ids = snapshot.feeds.map(({ feed }) => feed);
  const bySlot = (slot: "A" | "B" | "C") => ids.find((feed) => feed.payrollSlot === slot);
  for (const [name, bound] of [
    ["JobsReport", deployed.jobsReport],
    ["Payroll", deployed.payroll],
  ] as const) {
    if (bound === null) continue;
    same(`${name}.QUESTIONS`, bound.questions, questions);
    (["A", "B", "C"] as const).forEach((slot, i) => {
      const feed = bySlot(slot);
      if (feed !== undefined && bound.feeds[i]?.toLowerCase() !== feed.id.toLowerCase()) {
        wrong.push(`${name} is bound to ${bound.feeds[i]} where the ${feed.name} feed is ${feed.id}`);
      }
    });
  }
  for (const { feed } of snapshot.feeds) {
    if (feedIdOf(feed.params, feed.qPrefix, feed.tail) !== feed.id) {
      wrong.push(`the ${feed.name} fixture does not hash to its feed id`);
    }
    if (Number(feed.params.chainId) !== snapshot.chainId) {
      wrong.push(
        `the ${feed.name} feed is about chain ${feed.params.chainId}, this is chain ${snapshot.chainId}`,
      );
    }
  }
  if (deployed.price === 0n) wrong.push("the Intake does not sell the feeds' action for IMD");
  const sound = wrong.length === 0;
  steps.push({
    id: "check",
    title: "check the deployment against the launch",
    status: sound ? "done" : "blocked",
    detail: sound
      ? `Questions is built on Intake ${deployed.intake}, IMD ${deployed.imd} and oracle signer ${deployed.oracleSigner}; JobsReport and Payroll are bound to it and to the three feed ids; a request costs ${deployed.price} and the tip`
      : wrong.join("; "),
  });
  const held = (detail: string) => (sound ? detail : "the deployment check failed: nothing is sent");

  // Step 1: the feeds.
  for (const f of snapshot.feeds) {
    steps.push({
      id: `create:${f.feed.name}`,
      title: `create the ${f.feed.name} feed`,
      status: f.exists ? "done" : sound ? "todo" : "blocked",
      detail: f.exists
        ? `feed ${f.feed.id} exists`
        : held(
            `createFeed with the parameters and bytes of launch A's ${f.feed.name} fixture; the id will be ${f.feed.id}`,
          ),
      ...(f.exists || !sound
        ? {}
        : {
            action: {
              module: "firstDay",
              kind: "createFeed",
              subject: f.feed.name,
              label: `create the ${f.feed.name} feed`,
              reason: `the ${f.feed.name} feed does not exist on Questions yet`,
              call: createFeedCall(questions, f.feed),
            },
          }),
    });
  }

  // Step 2: the meters. A meter is funded when this wallet holds shares of it, or when it already
  // holds what it was meant to get, whoever put it there.
  const funded = (f: FirstDayFeed) => f.operatorShares > 0n || f.meterBalance >= f.fund;
  const toFund = snapshot.feeds.filter((f) => !funded(f) && f.fund > 0n);
  const total = toFund.reduce((sum, f) => sum + f.fund, 0n);
  if (toFund.length > 0) {
    const base = { id: "approve", title: `approve Questions for ${total} IMD wei` };
    if (snapshot.operator === null || snapshot.operatorImd === null || snapshot.operatorAllowance === null) {
      steps.push({
        ...base,
        status: "blocked",
        detail: held("no wallet address is configured: set KEEPER_ADDRESS to plan this step"),
      });
    } else if (snapshot.operatorImd < total) {
      steps.push({
        ...base,
        status: "blocked",
        detail: held(`the wallet holds ${snapshot.operatorImd} IMD wei and the meters are to get ${total}`),
      });
    } else if (snapshot.operatorAllowance >= total) {
      steps.push({ ...base, status: "done", detail: `the allowance is ${snapshot.operatorAllowance}` });
    } else {
      steps.push({
        ...base,
        status: sound ? "todo" : "blocked",
        detail: held(
          `the allowance is ${snapshot.operatorAllowance}; exactly what the meters get is approved, no more`,
        ),
        ...(sound
          ? {
              action: {
                module: "firstDay",
                kind: "approve",
                subject: "IMD",
                label: `approve Questions for ${total} IMD wei`,
                reason: "funding a meter pulls IMD from this wallet",
                call: {
                  address: deployed.imd,
                  abi: ERC20_ABI,
                  functionName: "approve",
                  args: [questions, total],
                },
              },
            }
          : {}),
      });
    }
  }
  const enough = snapshot.operatorImd !== null && snapshot.operatorImd >= total;
  for (const f of snapshot.feeds) {
    const base = { id: `fund:${f.feed.name}`, title: `fund the ${f.feed.name} meter with ${f.fund} IMD wei` };
    if (f.fund === 0n) {
      steps.push({ ...base, status: "done", detail: "nothing is to be put on this meter" });
    } else if (funded(f)) {
      steps.push({
        ...base,
        status: "done",
        detail:
          f.operatorShares > 0n
            ? "this wallet already holds shares of the meter"
            : `the meter already holds ${f.meterBalance}`,
      });
    } else if (!sound || snapshot.operator === null || !enough) {
      steps.push({
        ...base,
        status: "blocked",
        detail: held(
          snapshot.operator === null
            ? "no wallet address is configured"
            : "the wallet does not hold enough IMD",
        ),
      });
    } else {
      // It can be sent once the feed exists and the allowance covers it.
      const ready = f.exists && (snapshot.operatorAllowance ?? 0n) >= f.fund;
      steps.push({
        ...base,
        status: ready ? "todo" : "later",
        detail: ready
          ? `${f.feed.runwayRequests} requests' worth by default; this wallet can take back whatever the meter has not spent`
          : `follows ${f.exists ? "the approval" : "the creation of the feed and the approval"}`,
        action: {
          module: "firstDay",
          kind: "fund",
          subject: f.feed.name,
          label: `fund the ${f.feed.name} meter`,
          reason: `the ${f.feed.name} meter holds ${f.meterBalance} and this wallet has no shares of it`,
          call: { address: questions, abi: QUESTIONS_ABI, functionName: "fund", args: [f.feed.id, f.fund] },
        },
      });
    }
  }

  // Step 3: the first requests, each a transaction of its own.
  for (const f of snapshot.feeds) {
    const base = { id: `request:${f.feed.name}`, title: `make the first request of ${f.feed.name}` };
    const action: Action = {
      module: "firstDay",
      kind: "request",
      subject: f.feed.name,
      label: `request ${f.feed.name}`,
      reason: `the ${f.feed.name} feed has never been asked`,
      call: { address: questions, abi: QUESTIONS_ABI, functionName: "request", args: [f.feed.id] },
    };
    if (f.rounds > 0n) {
      steps.push({ ...base, status: "done", detail: `the feed has opened ${f.rounds} round(s)` });
    } else if (!sound) {
      steps.push({ ...base, status: "blocked", detail: held("") });
    } else if (f.exists && f.canRequest.ok) {
      steps.push({
        ...base,
        status: "todo",
        detail: "canRequest allows it; sent as a transaction of its own",
        action,
      });
    } else if (!f.exists || (f.canRequest.why === REQUEST_BLOCKER.MeterTooLow && !funded(f))) {
      // Not yet possible, and it will be once the steps above are on chain.
      steps.push({
        ...base,
        status: "later",
        detail: `follows ${f.exists ? "the funding of its meter" : "the creation of the feed and the funding of its meter"}`,
        action,
      });
    } else {
      steps.push({
        ...base,
        status: "blocked",
        detail: `canRequest says no: ${requestBlockerName(f.canRequest.why)}`,
      });
    }
  }

  return { steps, digest: planDigest(snapshot) };
}

/** Reads what `planFirstDay` needs. Sends nothing. */
export async function observeFirstDay(
  ctx: ObserveContext,
  targets: {
    questions: Address;
    jobsReport: Address | null;
    payroll: Address | null;
    expected: ExpectedDeployment;
    feeds: readonly HouseFeed[];
    fund: Readonly<Record<string, bigint | null>>;
  },
): Promise<FirstDaySnapshot> {
  const { questions, jobsReport, payroll } = targets;
  const operator = ctx.keeper;
  const [intake, imd, oracleSigner] = (await Promise.all(
    ["INTAKE", "IMD", "oracleSigner"].map((name) => readAt(ctx, questions, QUESTIONS_ABI, name)),
  )) as [Address, Address, Address];

  let price = 0n;
  const action = targets.feeds[0]?.params.action;
  if (action !== undefined) {
    try {
      price = big(await readAt(ctx, intake, INTAKE_ABI, "priceOf", [action, imd]));
    } catch (error) {
      ctx.log.warn("could not read the Intake's price", { intake, error: messageOf(error) });
    }
  }

  const bound = async (
    address: Address | null,
    abi: Abi,
    names: [string, string, string],
  ): Promise<{ questions: Address; feeds: [Hex, Hex, Hex] } | null> => {
    if (address === null) return null;
    const [q, a, b, c] = (await Promise.all(
      ["QUESTIONS", ...names].map((name) => readAt(ctx, address, abi, name)),
    )) as [Address, Hex, Hex, Hex];
    return { questions: q, feeds: [a, b, c] };
  };

  const feeds: FirstDayFeed[] = [];
  for (const feed of targets.feeds) {
    const state = (await readAt(ctx, questions, QUESTIONS_ABI, "feedState", [feed.id])) as {
      exists: boolean;
      rounds: unknown;
      meterBalance: unknown;
    };
    const [can, shares] = (await Promise.all([
      readAt(ctx, questions, QUESTIONS_ABI, "canRequest", [feed.id]),
      operator === null
        ? Promise.resolve(0n)
        : readAt(ctx, questions, QUESTIONS_ABI, "sharesOf", [feed.id, operator]),
    ])) as [readonly unknown[], unknown];
    feeds.push({
      feed,
      exists: state.exists,
      rounds: big(state.rounds),
      meterBalance: big(state.meterBalance),
      operatorShares: big(shares),
      canRequest: { ok: can[0] === true, why: num(can[1]) },
      fund: targets.fund[feed.name] ?? defaultFund(feed, price),
    });
  }

  let operatorImd: bigint | null = null;
  let operatorAllowance: bigint | null = null;
  if (operator !== null) {
    [operatorImd, operatorAllowance] = (
      await Promise.all([
        readAt(ctx, imd, ERC20_ABI, "balanceOf", [operator]),
        readAt(ctx, imd, ERC20_ABI, "allowance", [operator, questions]),
      ])
    ).map(big) as [bigint, bigint];
  }

  return {
    chainId: ctx.chainId,
    questions,
    jobsReport,
    payroll,
    operator,
    expected: targets.expected,
    deployed: {
      intake,
      imd,
      oracleSigner,
      price,
      jobsReport: await bound(jobsReport, JOBS_REPORT_ABI, ["PAYROLLS_FEED", "HIRES_FEED", "EMPLOYERS_FEED"]),
      payroll: await bound(payroll, PAYROLL_ABI, ["FEED_A", "FEED_B", "FEED_C"]),
    },
    operatorImd,
    operatorAllowance,
    feeds,
  };
}

/** What the first-day command reports back. */
export interface FirstDayResult {
  plan: FirstDayPlan;
  /** True when every step is on chain. */
  complete: boolean;
  /** Why a live run sent nothing, or stopped; null when it did not have to. */
  stopped: string | null;
}
