/**
 * The transaction flows: what a page prints as `cast send`, what the wallet island sends, and what
 * `/api/v1/flows/:id` returns are one plan. These tests pin its arguments to the contracts' ABIs as
 * the shared package generates them from the launch projects' build output.
 */
import {
  decodeFunctionData,
  encodeFunctionData,
  hexToString,
  keccak256,
  stringToBytes,
  toFunctionSelector,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";
import { resolveDeployments } from "~/config/deployments";
import {
  crowdPotsAbi,
  DESK,
  endowmentsAbi,
  HOUSE_FEEDS,
  kindHash,
  MAINNET,
  ORDER_FLAG,
  questionsAbi,
  rulesAbi,
  silenceSeconds,
  specHash,
  workOrdersAbi,
  zapAbi,
} from "@help-wanted/shared";
import {
  castCommand,
  castReadCommand,
  flowById,
  FLOWS,
  initialValues,
  type Addresses,
  type FlowContext,
  type FlowPlan,
} from "~/flows";
import { ENDOWMENT, GAS_LIMIT, RULE, signatureOf } from "~/lib/contracts";
import { handleApi } from "~/lib/api";
import { addressesOf, previewFlow } from "~/models/flowPreview";
import { BOOKS, ctxFor, NOW, testSources } from "./helpers";

const IMD = 10n ** 18n;
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const DESK_ADDRESS = "0x00000000000000000000000000000000000000D1";
// The two ends a flow is planned at: a book with no launch in it, and one with all three.
const NOT_LAUNCHED: Addresses = addressesOf(resolveDeployments({}, BOOKS.none));
const LAUNCHED: Addresses = {
  ...NOT_LAUNCHED,
  workOrders: DESK_ADDRESS,
  crowdPots: "0x00000000000000000000000000000000000000c2",
  payroll: "0x00000000000000000000000000000000000000A3",
};
const ctx = (addresses: Addresses = NOT_LAUNCHED): FlowContext => ({ addresses, now: NOW_SECONDS });

function ok(plan: FlowPlan): Extract<FlowPlan, { ok: true }> {
  if (!plan.ok) throw new Error(`expected a plan, got: ${plan.problems.join(" ")}`);
  return plan;
}

function problems(plan: FlowPlan): string[] {
  if (plan.ok) throw new Error("expected the plan to be refused");
  return plan.problems;
}

const AUDIT = {
  template: "audit",
  repoUrl: "https://github.com/owner/repo",
  baseCommit: "0123456789abcdef0123456789abcdef01234567",
  focus: "",
  maxPay: "3",
  minPay: "2",
  rampHours: "1",
  expiresDays: "7",
  allowClaimed: "true",
};

describe("posting an order (IWorkOrders.createOrder, frozen)", () => {
  const hire = flowById("hire")!;

  it("is two calls: allow the desk to pull the escrow, then createOrder", () => {
    const plan = ok(hire.plan(AUDIT, ctx(LAUNCHED)));
    expect(plan.calls.map((c) => [c.target, c.functionName, c.to])).toEqual([
      ["IMD", "approve", MAINNET.IMD],
      ["workOrders", "createOrder", DESK_ADDRESS],
    ]);
    const [approve, create] = plan.calls;
    expect(approve?.args).toEqual([DESK_ADDRESS, 3n * IMD]);
    expect(approve?.allowance).toEqual({ spender: DESK_ADDRESS, amount: 3n * IMD });

    const data = encodeFunctionData({
      abi: create!.abi,
      functionName: create!.functionName,
      args: create!.args as unknown[],
    });
    expect(data.slice(0, 10)).toBe("0x3cc26202");
    const decoded = decodeFunctionData({ abi: workOrdersAbi, data });
    const [params, spec] = decoded.args as unknown as [Record<string, unknown>, Hex];
    expect(params).toEqual({
      kindHash: keccak256(stringToBytes("audit")),
      minPay: 2n * IMD,
      maxPay: 3n * IMD,
      rampSecs: 3600,
      deliverySecs: 259_200,
      expiresAt: NOW_SECONDS + 7 * 86_400,
      bond: 250_000_000_000_000_000n,
      flags: ORDER_FLAG.ALLOW_CLAIMED,
      runnerOnly: "0x0000000000000000000000000000000000000000",
      arbiter: "0x0000000000000000000000000000000000000000",
      condTarget: "0x0000000000000000000000000000000000000000",
      condSelector: "0x00000000",
      condArg: `0x${"0".repeat(64)}`,
      condCmp: 0,
      condThreshold: 0n,
    });
    expect(hexToString(spec)).toBe(
      "Audit the smart contracts in this repository at the given commit and report every defect you find, most serious first. Inputs: repoUrl=https://github.com/owner/repo; baseCommit=0123456789abcdef0123456789abcdef01234567",
    );
    expect(plan.summary[0]).toBe("You escrow 3 IMD. That is the most this order can cost you.");
    expect(plan.summary.join(" ")).toContain("at most 0.15 IMD");
  });

  it("uses the desk's own constants, from the shared package, for the bond and the delivery window", () => {
    expect(DESK.MIN_BOND).toBe(250_000_000_000_000_000n);
    expect(DESK.MIN_DELIVERY).toBe(3 * 86_400);
    expect(DESK.CLAIM_WINDOW).toBe(3600);
    expect(DESK.CHALLENGE_WINDOW).toBe(86_400);
    expect(DESK.DISPUTE_WINDOW).toBe(86_400);
  });

  it("plans the same calls before launch, with a shell variable where the address will be", () => {
    const plan = ok(hire.plan(AUDIT, ctx()));
    expect(plan.calls[1]?.to).toBeNull();
    const [approve, create] = plan.calls.map((c) => castCommand(c, "https://ethereum-rpc.publicnode.com"));
    expect(approve).toBe(
      `cast send ${MAINNET.IMD} "approve(address,uint256)" $WORK_ORDERS 3000000000000000000 --rpc-url https://ethereum-rpc.publicnode.com --account <your-keystore-account>`,
    );
    expect(create).toContain(
      'cast send $WORK_ORDERS "createOrder((bytes32,uint96,uint96,uint32,uint32,uint40,uint96,uint8,address,address,address,bytes4,bytes32,uint8,uint256),bytes)"',
    );
    expect(create).toContain(
      `'(${keccak256(stringToBytes("audit"))},2000000000000000000,3000000000000000000,3600,259200,${NOW_SECONDS + 604_800},250000000000000000,1,`,
    );
    expect(create).toContain("\"$(cast from-utf8 'Audit the smart contracts");
    // No command ever asks for a raw private key on the command line.
    expect(create).not.toContain("--private-key");
  });

  it("turns the claim path off when the employer wants receipts only, and drops the ramp for a fixed price", () => {
    const plan = ok(hire.plan({ ...AUDIT, allowClaimed: "false", minPay: "3" }, ctx(LAUNCHED)));
    const params = plan.calls[1]?.args[0] as { flags: number; rampSecs: number };
    expect(params.flags).toBe(0);
    expect(params.rampSecs).toBe(0);
    expect(plan.summary.join(" ")).toContain("The price is fixed at 3 IMD.");
    expect(plan.summary.join(" ")).toContain("Only an on-chain receipt pays.");
  });

  it("refuses what the contract would refuse, in plain words, before any wallet opens", () => {
    expect(problems(hire.plan({ ...AUDIT, template: "teleport" }, ctx()))).toEqual([
      "Choose what kind of job to order.",
    ]);
    expect(problems(hire.plan({ ...AUDIT, repoUrl: "" }, ctx()))).toEqual(["Repository: this is needed."]);
    expect(problems(hire.plan({ ...AUDIT, repoUrl: "http://example.com/x" }, ctx()))[0]).toContain(
      "public GitHub address",
    );
    expect(problems(hire.plan({ ...AUDIT, baseCommit: "abc123" }, ctx()))[0]).toContain(
      "40-character commit hash",
    );
    expect(problems(hire.plan({ ...AUDIT, minPay: "4" }, ctx()))).toContain(
      "The opening price cannot be more than the most you will pay.",
    );
    expect(problems(hire.plan({ ...AUDIT, maxPay: "0" }, ctx()))).toContain(
      "Say the most you will pay, in IMD.",
    );
    expect(problems(hire.plan({ ...AUDIT, maxPay: "three" }, ctx()))).toContain(
      "Say the most you will pay, in IMD.",
    );
    expect(
      problems(
        hire.plan({ template: "research", question: 'What is "x"?', maxPay: "2", minPay: "1" }, ctx()),
      )[0],
    ).toContain("double quote");
    expect(problems(hire.plan({ template: "image", brief: "", maxPay: "2", minPay: "1" }, ctx()))).toEqual([
      "The picture: this is needed.",
    ]);
  });

  it("starts each template's form from its own suggested prices, with the claim path off", () => {
    expect(initialValues(hire, { template: "audit" })).toMatchObject({
      template: "audit",
      maxPay: "3",
      minPay: "2",
      allowClaimed: "false",
      arbiter: "",
    });
    expect(initialValues(hire, { template: "video" })).toMatchObject({ maxPay: "3", minPay: "1.5" });
    expect(hire.fields({ template: "research" }).map((f) => f.name)).toEqual([
      "question",
      "maxPay",
      "minPay",
      "rampHours",
      "expiresDays",
      "allowClaimed",
      "arbiter",
    ]);
  });
});

describe("how an order pays: on proof by default, on a claim only by choice", () => {
  const hire = flowById("hire")!;
  const RESEARCH = { template: "research", question: "What is 2 plus 2?" };
  const untouched = () => ({ ...initialValues(hire, { template: "research" }), ...RESEARCH });
  const paramsOf = (plan: Extract<FlowPlan, { ok: true }>) =>
    plan.calls[1]?.args[0] as { flags: number; arbiter: string; expiresAt: number; rampSecs: number };
  const dataOf = (plan: Extract<FlowPlan, { ok: true }>) =>
    encodeFunctionData({
      abi: plan.calls[1]!.abi,
      functionName: plan.calls[1]!.functionName,
      args: plan.calls[1]!.args as unknown[],
    });

  it("an order posted from an untouched form pays only on a receipt, and says so", () => {
    const plan = ok(hire.plan(untouched(), ctx(LAUNCHED)));
    expect(paramsOf(plan).flags).toBe(0);
    expect(paramsOf(plan).arbiter).toBe("0x0000000000000000000000000000000000000000");
    const text = plan.summary.join(" ");
    expect(text).toContain("Only an on-chain receipt pays.");
    expect(text).toContain("the order times out and your escrow comes back");
    expect(text).not.toContain("bonded delivery claim");
    // The same bytes `cast calldata` gives for this tuple and text (Foundry 1.8.3, run by hand):
    //   cast calldata "createOrder((…),bytes)" "(<kind>,1e18,2e18,3600,259200,<now+7d>,25e16,0,0x0,0x0,0x0,0x00000000,0x0,0,0)" "$(cast from-utf8 'What is 2 plus 2?')"
    expect(keccak256(dataOf(plan))).toBe(
      "0x596497d3b1b471cb6f4ad90a92876655e5025f86239bafe5d53a28f66b5c3975",
    );
  });

  it("the API plans the same receipt-only order when the question is all it is given", async () => {
    const world = testSources({ env: { HW_ADDR_WORK_ORDERS: DESK_ADDRESS } });
    const response = await handleApi("flows/hire", new Request("https://help-wanted.test/x"), {
      ...ctxFor(world),
      url: new URL(
        `https://help-wanted.test/api/v1/flows/hire?template=research&question=${encodeURIComponent(RESEARCH.question)}`,
      ),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { calls: { data: string; args: [{ flags: number }] }[] };
    expect(body.calls[1]?.args[0].flags).toBe(0);
    expect(keccak256(body.calls[1]!.data as Hex)).toBe(
      "0x596497d3b1b471cb6f4ad90a92876655e5025f86239bafe5d53a28f66b5c3975",
    );
  });

  it("an employer who ticks the box is told both limits of the claim path, in the plan they sign from", () => {
    const plan = ok(hire.plan({ ...untouched(), allowClaimed: "true" }, ctx(LAUNCHED)));
    expect(paramsOf(plan).flags).toBe(ORDER_FLAG.ALLOW_CLAIMED);
    const text = plan.summary.join(" ");
    // First limit: an untrue claim nobody challenges is paid.
    expect(text).toContain("a claim that is untrue and that nobody challenges within 24 hours is paid");
    expect(text).toContain("Nothing on chain watches your order for you");
    // Second limit: an undecided challenge refunds, even on a true claim, and costs the challenger nothing.
    expect(text).toContain("you are refunded and the runner goes unpaid, even if the claim was true");
    expect(text).toContain("anyone can cause that at no cost by challenging");
    // And the remedy is named.
    expect(text).toContain("you named no arbiter");
    // The checkbox itself says the same before it is ticked.
    const help = hire.fields({ template: "research" }).find((f) => f.name === "allowClaimed")?.help ?? "";
    expect(help).toContain("A claim that is untrue is paid if nobody challenges it in time");
    expect(help).toContain("a challenge that nothing decides refunds you even when the claim was true");
    expect(help).not.toMatch(/arriving late at the moment|stalled/);
  });

  it("carries a named arbiter on the order, and says what it can do", () => {
    const arbiter = "0x00000000000000000000000000000000000000a7";
    const plan = ok(hire.plan({ ...untouched(), allowClaimed: "true", arbiter }, ctx(LAUNCHED)));
    expect(paramsOf(plan).arbiter).toBe("0x00000000000000000000000000000000000000A7");
    expect(plan.summary.join(" ")).toContain(
      "a challenged claim is decided by a receipt or by your arbiter 0x00000000000000000000000000000000000000A7, who can rule either way",
    );
    expect(plan.calls[1]?.castArgs[0]).toContain(
      ",1,0x0000000000000000000000000000000000000000,0x00000000000000000000000000000000000000A7,",
    );
    // cast calldata for the same tuple with flags 1 and that arbiter.
    expect(keccak256(dataOf(plan))).toBe(
      "0xdf8373e8796789037be17ea04c6eabc388234a82b1cc47a2e94f6b81bd9195c9",
    );
  });

  it("refuses an arbiter that is not an address, and one on an order that accepts no claims", () => {
    expect(problems(hire.plan({ ...untouched(), allowClaimed: "true", arbiter: "0x123" }, ctx()))).toEqual([
      "Arbiter: give an address, or leave it empty.",
    ]);
    expect(
      problems(
        hire.plan({ ...untouched(), arbiter: "0x00000000000000000000000000000000000000a7" }, ctx()),
      )[0],
    ).toContain("this order accepts none");
    expect(
      problems(hire.plan({ ...untouched(), allowClaimed: "true", arbiter: `0x${"0".repeat(40)}` }, ctx())),
    ).toEqual(["Arbiter: leave it empty to name none."]);
  });

  it("warns that an audit's record may be too large to prove when only a receipt pays", () => {
    const audit = ok(hire.plan({ ...AUDIT, allowClaimed: "false" }, ctx()));
    expect(audit.summary.join(" ")).toContain(
      "A record of this kind is often too large to prove in one transaction",
    );
    expect(ok(hire.plan(untouched(), ctx())).summary.join(" ")).not.toContain("too large to prove");
  });
});

describe("amounts and limits the desk would refuse, or a visitor would regret", () => {
  const hire = flowById("hire")!;
  const RESEARCH = {
    template: "research",
    question: "What is 2 plus 2?",
    maxPay: "2",
    minPay: "1",
    rampHours: "1",
    expiresDays: "7",
  };

  it("never reads a decimal comma as nothing: 0,5 is refused, not sent as 5", () => {
    const chip = flowById("chip-in")!;
    const refused = problems(chip.plan({ potId: "1", amount: "0,5" }, ctx(LAUNCHED)));
    expect(refused.join(" ")).toContain("A comma is not read as a decimal mark");
    expect(problems(hire.plan({ ...RESEARCH, maxPay: "1,5" }, ctx())).join(" ")).toContain(
      "The most you will pay: write the amount with a point",
    );
    for (const id of ["fund-feed", "runner-claim", "endow-deposit", "endow-withdraw"]) {
      const values = { id: "1", feedId: `0x${"11".repeat(32)}`, amount: "0,5", bond: "0,5" };
      expect(flowById(id)!.plan(values, ctx(LAUNCHED)).ok, id).toBe(false);
    }
    // With a point it is half an IMD, as meant.
    expect(ok(chip.plan({ potId: "1", amount: "0.5" }, ctx(LAUNCHED))).calls[1]?.args).toEqual([
      1n,
      IMD / 2n,
    ]);
  });

  it("refuses an amount beyond what the contract can hold as a problem with the form, not a crash", async () => {
    expect(problems(hire.plan({ ...RESEARCH, maxPay: "100000000000" }, ctx())).join(" ")).toContain(
      "more IMD than can exist",
    );
    const world = testSources();
    const query = new URLSearchParams({ ...RESEARCH, maxPay: "100000000000" }).toString();
    const response = await handleApi("flows/hire", new Request("https://help-wanted.test/x"), {
      ...ctxFor(world),
      url: new URL(`https://help-wanted.test/api/v1/flows/hire?${query}`),
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { problems: string[] }).problems.join(" ")).toContain(
      "more IMD than can exist",
    );
  });

  it("refuses an order that would expire before anyone could take it", () => {
    expect(problems(hire.plan({ ...RESEARCH, expiresDays: "0.0001" }, ctx()))).toContain(
      "Keep the order open for at least an hour, or no runner will have time to take it.",
    );
    expect(ok(hire.plan({ ...RESEARCH, expiresDays: "0.05" }, ctx())).calls).toHaveLength(2);
  });

  it("refuses a price that rises over no time at all, which the desk would price at the most at once", () => {
    expect(problems(hire.plan({ ...RESEARCH, rampHours: "0" }, ctx()))[0]).toContain(
      "The price cannot rise over no time at all",
    );
    // A fixed price needs no ramp.
    const fixed = ok(hire.plan({ ...RESEARCH, minPay: "2", rampHours: "0" }, ctx()));
    expect((fixed.calls[1]?.args[0] as { rampSecs: number }).rampSecs).toBe(0);
  });

  it("refuses a say-when audit whose text names no repository and commit: no runner could open it", () => {
    const sayWhen = flowById("say-when")!;
    const rule = {
      condTarget: MAINNET.IMD,
      condFunction: "totalSupply()",
      condArg: "",
      condCmp: "1",
      condThreshold: "1",
      template: "audit",
      maxPay: "3",
      minPay: "2",
      rampHours: "1",
      expiresDays: "7",
    };
    // The reason is the runner's own (the shared package builds the job body, or says why it cannot),
    // and the form adds how to write the inputs.
    const bare = problems(sayWhen.plan({ ...rule, spec: "Audit the staking vault." }, ctx()))[0];
    expect(bare).toContain("No runner can open this job as written");
    expect(bare).toContain(
      "End the job text with: Inputs: repoUrl=https://github.com/owner/repo; baseCommit=<40 hex, lowercase>",
    );
    expect(
      problems(
        sayWhen.plan(
          { ...rule, spec: "Audit the vault. Inputs: repoUrl=https://github.com/owner/repo baseCommit=abc" },
          ctx(),
        ),
      )[0],
    ).toContain("No runner can open this job as written");
    expect(
      problems(
        sayWhen.plan(
          {
            ...rule,
            spec: `Audit the vault. Inputs: repoUrl=https://example.com/x; baseCommit=${"a".repeat(40)}`,
          },
          ctx(),
        ),
      )[0],
    ).toContain("No runner can open this job as written");
    const good = `Audit the vault. Inputs: repoUrl=https://github.com/owner/repo; baseCommit=${"a".repeat(40)}`;
    expect(ok(sayWhen.plan({ ...rule, spec: good }, ctx())).calls).toHaveLength(2);
    // A job that needs no inputs is not asked for any.
    expect(
      ok(sayWhen.plan({ ...rule, template: "image", spec: "One square picture." }, ctx())).calls,
    ).toHaveLength(2);
  });

  it("tells a runner that a job pays for one order only", () => {
    const plan = ok(
      flowById("runner-register")!.plan({ id: "3", jobId: "e9efec16-56f3-40d3-9243-52c453effc7d" }, ctx()),
    );
    expect(plan.summary.join(" ")).toContain("one job pays for one order");
  });
});

describe("say when (an order with a condition, frozen)", () => {
  const sayWhen = flowById("say-when")!;
  const base = {
    condTarget: MAINNET.IMD,
    condFunction: "totalSupply()",
    condArg: "",
    condCmp: "1",
    condThreshold: "1000000000000000000000000",
    template: "image",
    spec: "Make one square picture celebrating a milestone. No text in the picture.",
    maxPay: "2",
    minPay: "1",
    rampHours: "1",
    expiresDays: "7",
    allowClaimed: "true",
  };

  it("stores the view call's selector, comparison and threshold on the order", () => {
    const plan = ok(sayWhen.plan(base, ctx(LAUNCHED)));
    const params = plan.calls[1]?.args[0] as Record<string, unknown>;
    expect(params).toMatchObject({
      condTarget: MAINNET.IMD,
      condSelector: toFunctionSelector("totalSupply()"),
      condArg: `0x${"0".repeat(64)}`,
      condCmp: 1,
      condThreshold: 10n ** 24n,
      flags: ORDER_FLAG.ALLOW_CLAIMED,
    });
    expect(params.condSelector).toBe("0x18160ddd");
    expect(plan.summary.join(" ")).toContain("Nobody can take the order until");
  });

  it("packs a single argument into one word and sets FLAG_COND_ARG", () => {
    const plan = ok(
      sayWhen.plan(
        {
          ...base,
          condFunction: "balanceOf(address)",
          condArg: MAINNET.SIMD,
          condCmp: "3",
          allowClaimed: "false",
        },
        ctx(LAUNCHED),
      ),
    );
    const params = plan.calls[1]?.args[0] as Record<string, unknown>;
    expect(params.condSelector).toBe("0x70a08231");
    expect(params.condArg).toBe(`0x${"0".repeat(24)}${MAINNET.SIMD.slice(2).toLowerCase()}`);
    expect(params.flags).toBe(ORDER_FLAG.COND_ARG);
    expect(params.condCmp).toBe(3);
    const withNumber = ok(
      sayWhen.plan({ ...base, condFunction: "ownerOf(uint256)", condArg: "1998" }, ctx(LAUNCHED)),
    );
    expect((withNumber.calls[1]?.args[0] as { condArg: string }).condArg).toBe(
      `0x${(1998).toString(16).padStart(64, "0")}`,
    );
  });

  it("refuses a call the desk could not make", () => {
    expect(problems(sayWhen.plan({ ...base, condTarget: "0x123" }, ctx()))[0]).toContain(
      "address of the contract to watch",
    );
    expect(
      problems(sayWhen.plan({ ...base, condFunction: "transfer(address,uint256)" }, ctx()))[0],
    ).toContain("no argument or with one");
    expect(
      problems(sayWhen.plan({ ...base, condFunction: "balanceOf(address)", condArg: "" }, ctx())),
    ).toContain("The call takes one address; give its value.");
    expect(problems(sayWhen.plan({ ...base, condArg: "5" }, ctx()))).toContain(
      "The call takes no argument; leave the argument empty.",
    );
    expect(problems(sayWhen.plan({ ...base, condThreshold: "1.5" }, ctx()))).toContain(
      "The number to compare with must be a whole number.",
    );
    expect(problems(sayWhen.plan({ ...base, condCmp: "9" }, ctx()))).toContain("Choose how to compare.");
  });
});

describe("the other flows", () => {
  it("every flow has a distinct id, a button label and plans without throwing on an empty form", () => {
    expect(new Set(FLOWS.map((f) => f.id)).size).toBe(FLOWS.length);
    for (const flow of FLOWS) {
      expect(flow.action.length).toBeGreaterThan(2);
      const plan = flow.plan(initialValues(flow), ctx());
      if (!plan.ok) expect(plan.problems.length, flow.id).toBeGreaterThan(0);
    }
  });

  it.each([
    ["order-cancel", { id: "7" }, "cancel(uint256)", "0x40e58ee5", [7n]],
    ["order-refund", { id: "7" }, "refund(uint256)", "0x278ecde1", [7n]],
    ["claim-seat", { tokenId: "1998" }, "claimSeat(uint256)", "0x1714bca2", [1998n]],
    ["claim-tip", { agentId: "52211" }, "claimTip(uint256)", "0x365ac285", [52211n]],
    ["drip", {}, "drip()", "0x9f678cca", []],
    ["book", {}, "book()", "0x05a8da72", []],
    [
      "runner-register",
      { id: "3", jobId: "e9efec16-56f3-40d3-9243-52c453effc7d" },
      "register(uint256,bytes16)",
      "0x39c688a8",
      [3n, "0xe9efec1656f340d3924352c453effc7d"],
    ],
    ["ring", {}, "ring()", "0x8360c185", []],
  ] as const)("%s sends %s", (id, values, signature, selector, args) => {
    const plan = ok(flowById(id)!.plan({ ...values }, ctx(LAUNCHED)));
    const call = plan.calls.at(-1)!;
    expect(call.signature).toBe(signature);
    expect(toFunctionSelector(signature)).toBe(selector);
    expect(
      encodeFunctionData({
        abi: call.abi,
        functionName: call.functionName,
        args: call.args as unknown[],
      }).slice(0, 10),
    ).toBe(selector);
    expect(call.args).toEqual(args);
  });

  it("chipping in allows exactly the chip, then calls ICrowdPots.chipIn", () => {
    const plan = ok(flowById("chip-in")!.plan({ potId: "4", amount: "0.5" }, ctx(LAUNCHED)));
    expect(plan.calls.map((c) => c.signature)).toEqual([
      "approve(address,uint256)",
      "chipIn(uint256,uint256)",
    ]);
    expect(plan.calls[0]?.args).toEqual([LAUNCHED.crowdPots, IMD / 2n]);
    expect(plan.calls[1]?.args).toEqual([4n, IMD / 2n]);
    expect(toFunctionSelector("chipIn(uint256,uint256)")).toBe("0xa0208e7c");
    expect(problems(flowById("chip-in")!.plan({ potId: "", amount: "0" }, ctx()))).toHaveLength(2);
  });

  it("funding a feed allows the amount, then calls IQuestions.fund", () => {
    const feedId = `0x${"11".repeat(32)}`;
    const plan = ok(flowById("fund-feed")!.plan({ feedId, amount: "5" }, ctx()));
    expect(plan.calls[1]?.signature).toBe("fund(bytes32,uint256)");
    expect(plan.calls[1]?.args).toEqual([feedId, 5n * IMD]);
    expect(problems(flowById("fund-feed")!.plan({ feedId: "0x11", amount: "5" }, ctx()))[0]).toContain(
      "64 hex characters",
    );
  });

  it("a runner's claim posts at least the desk's minimum bond", () => {
    const claim = flowById("runner-claim")!;
    expect(problems(claim.plan({ id: "1", bond: "0.1" }, ctx()))).toContain("The bond is at least 0.25 IMD.");
    const plan = ok(claim.plan({ id: "1", bond: "0.25" }, ctx(LAUNCHED)));
    expect(plan.calls[0]?.args).toEqual([DESK_ADDRESS, IMD / 4n]);
    expect(plan.calls[1]?.signature).toBe("claim(uint256)");
  });

  it("claimSeat refuses a number that is not a seat", () => {
    expect(problems(flowById("claim-seat")!.plan({ tokenId: "2000" }, ctx()))).toEqual([
      "Give a seat number from 0 to 1999.",
    ]);
  });
});

describe("a flow as a page prints it", () => {
  it("is not ready, and says which contract is missing, until the address exists", () => {
    const preview = previewFlow(
      "hire",
      resolveDeployments({}, BOOKS.none),
      NOW,
      { template: "audit" },
      AUDIT,
    );
    expect(preview.ready).toBe(false);
    expect(preview.reads).toEqual([]);
    expect(preview.contract).toMatchObject({ name: "WorkOrders", address: null, label: "not launched yet" });
    expect(preview.steps).toHaveLength(2);
    expect(preview.steps[1]?.command).toContain("cast send $WORK_ORDERS");
    expect(preview.problems).toEqual([]);

    const live = previewFlow(
      "hire",
      resolveDeployments({ HW_ADDR_WORK_ORDERS: DESK_ADDRESS }, BOOKS.none),
      NOW,
      { template: "audit" },
      AUDIT,
    );
    expect(live.ready).toBe(true);
    expect(live.steps[1]?.command).toContain(`cast send ${DESK_ADDRESS}`);
  });

  it("follows the book launch by launch: with launch A only, its flows are ready and the desk's are not", () => {
    const aOnly = resolveDeployments({}, BOOKS.aOnly);
    for (const flow of FLOWS) {
      const preview = previewFlow(flow.id, aOnly, NOW, {}, FILLED[flow.id] ?? {});
      const needsA = aOnly.contracts[flow.contract].launch === "A";
      expect(preview.ready, flow.id).toBe(needsA);
      expect(preview.contract.label === "not launched yet", flow.id).toBe(!needsA);
    }
    // A flow of launch A names the real address in its command; a flow of launch B still a variable.
    const request = previewFlow("request-feed", aOnly, NOW, {}, { feed: "payrolls" });
    expect(request.steps[0]?.command).toContain(
      `cast send ${aOnly.contracts.questions.address} "request(bytes32)"`,
    );
    const hire = previewFlow("hire", aOnly, NOW, { template: "audit" }, AUDIT);
    expect(hire.steps[1]?.command).toContain("cast send $WORK_ORDERS");
    // With every launch in the book, every flow is ready.
    const all = resolveDeployments({}, BOOKS.all);
    for (const flow of FLOWS) {
      expect(previewFlow(flow.id, all, NOW, {}, FILLED[flow.id] ?? {}).ready, flow.id).toBe(true);
    }
  });

  it("is served by the API with the calldata, and a refused form answers 422 with the reasons", async () => {
    const world = testSources();
    const query = new URLSearchParams(AUDIT).toString();
    const good = await handleApi("flows/hire", new Request("https://help-wanted.test/x"), {
      ...ctxFor(world),
      url: new URL(`https://help-wanted.test/api/v1/flows/hire?${query}`),
    });
    expect(good.status).toBe(200);
    const body = (await good.json()) as {
      ok: boolean;
      sendable: boolean;
      calls: { data: string; to: string | null; cast: string }[];
    };
    expect(body.ok).toBe(true);
    expect(body.sendable).toBe(false);
    expect(body.calls.map((c) => c.data.slice(0, 10))).toEqual(["0x095ea7b3", "0x3cc26202"]);
    expect(body.calls[1]?.to).toBeNull();

    const bad = await handleApi("flows/hire", new Request("https://help-wanted.test/x"), {
      ...ctxFor(world),
      url: new URL("https://help-wanted.test/api/v1/flows/hire?template=audit"),
    });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { problems: string[] }).problems.length).toBeGreaterThan(0);

    const unknown = await handleApi("flows/nope", new Request("https://help-wanted.test/x"), ctxFor(world));
    expect(unknown.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------
// Every flow against the ABI it is sent with
// ---------------------------------------------------------------------------------------------

const ADDRESS_1 = "0x0000000000000000000000000000000000000001";
const RESEARCH_SPEC =
  "Write a two-page plain-language report on who paid the IdentityMD swarm in the last seven days and for what, from on-chain IMD transfers to the fee payee only, with every figure sourced to a transaction.";

/** A filled form for every flow, so each can be planned, encoded and printed. */
const FILLED: Record<string, Record<string, string>> = {
  hire: AUDIT,
  "say-when": {
    condTarget: MAINNET.IMD,
    condFunction: "totalSupply()",
    condArg: "",
    condCmp: "1",
    condThreshold: "1",
    template: "image",
    spec: "One square picture.",
    maxPay: "2",
    minPay: "1",
    rampHours: "1",
    expiresDays: "7",
  },
  "order-cancel": { id: "7" },
  "order-refund": { id: "7" },
  "order-trigger": { id: "7" },
  "order-evict": { id: "7" },
  "order-timeout": { id: "7" },
  "order-challenge": { id: "7", bond: "0.25" },
  "runner-claim": { id: "7", bond: "0.25" },
  "runner-register": { id: "7", jobId: "e9efec16-56f3-40d3-9243-52c453effc7d" },
  "runner-release": { id: "7" },
  "runner-claim-delivered": { id: "7", recordHash: `0x${"cd".repeat(32)}` },
  "runner-finalize": { id: "7" },
  "open-pot": {
    template: "research",
    spec: RESEARCH_SPEC,
    target: "5",
    minPay: "2",
    rampHours: "24",
    bond: "0.5",
    fundDays: "3",
    hireDays: "7",
    deliveryDays: "7",
    allowClaimed: "false",
    firstChip: "1",
  },
  "chip-in": { potId: "4", amount: "0.5" },
  "launch-pot": { potId: "4", spec: RESEARCH_SPEC },
  "claim-refund": { potId: "4", contributor: ADDRESS_1 },
  ring: {},
  "fund-feed": { feed: "payrolls", amount: "5" },
  "defund-feed": { feed: "hires", shares: "1000" },
  "request-feed": { feed: "payrolls" },
  "collect-tips": {},
  "abandon-feed": { feed: "employers" },
  "print-report": {},
  "claim-seat": { tokenId: "1998" },
  "claim-tip": { agentId: "52211" },
  drip: {},
  book: {},
  "fund-feeds": {},
  "create-rule": {
    condKind: "view",
    condTarget: MAINNET.SIMD,
    condFunction: "totalAssets()",
    condArg: "",
    condCmp: "1",
    condThreshold: "2000000000000000000000000",
    action: "hire",
    template: "research",
    spec: RESEARCH_SPEC,
    maxPay: "5",
    minPay: "2",
    rampHours: "24",
    orderDays: "14",
    allowClaimed: "false",
    tip: "0.05",
    cooldownHours: "0",
    maxFires: "1",
    deposit: "5.05",
  },
  "fire-rule": { id: "1", spec: RESEARCH_SPEC },
  "cancel-rule": { id: "1" },
  "reconcile-rule": { id: "1", orderId: "9" },
  "endow-create-meter": { feed: "payrolls" },
  "endow-create-pot": { potId: "4", beneficiary: ADDRESS_1 },
  "endow-create-recipient": { recipient: ADDRESS_1 },
  "endow-deposit": { id: "1", amount: "100" },
  "endow-withdraw": { id: "1", amount: "100" },
  "endow-harvest": { id: "1" },
  "endow-stake": {},
  "zap-chip-in": { potId: "4", eth: "0.01", minImdOut: "8" },
  "zap-fund-meter": { feed: "payrolls", eth: "0.01", minImdOut: "8" },
  "zap-buy": { eth: "0.01", minImdOut: "8" },
};

const ALL_LAUNCHED: Addresses = Object.fromEntries(
  Object.keys(NOT_LAUNCHED).map((key, index) => [key, `0x${(index + 0xa1).toString(16).padStart(40, "0")}`]),
) as Addresses;

describe("every flow, against the ABI the compiler wrote", () => {
  it("there is a filled form here for each of them", () => {
    expect(Object.keys(FILLED).sort()).toEqual(FLOWS.map((f) => f.id).sort());
    expect(FLOWS.length).toBe(43);
  });

  it.each(FLOWS.map((f) => f.id))("%s plans, encodes, and prints the cast command of every call", (id) => {
    const flow = flowById(id)!;
    const values = { ...initialValues(flow), ...FILLED[id] };
    for (const addresses of [NOT_LAUNCHED, ALL_LAUNCHED]) {
      const plan = ok(flow.plan(values, ctx(addresses)));
      expect(plan.calls.length, id).toBeGreaterThan(0);
      expect(plan.summary.length, id).toBeGreaterThan(0);
      for (const call of plan.calls) {
        // The signature a reader sees is the ABI's own, never typed by hand.
        expect(call.signature, `${id} ${call.functionName}`).toBe(signatureOf(call.abi, call.functionName));
        // And the arguments are ones that function takes: this throws if they are not.
        const data = encodeFunctionData({
          abi: call.abi,
          functionName: call.functionName,
          args: call.args as unknown[],
        });
        expect(data.slice(0, 10)).toBe(toFunctionSelector(call.signature));
        const command = castCommand(call, "https://ethereum-rpc.publicnode.com");
        expect(command.startsWith("cast send ")).toBe(true);
        expect(command).toContain(`"${call.signature}"`);
        expect(command).toContain("--rpc-url https://ethereum-rpc.publicnode.com");
        expect(command).toContain("--account <your-keystore-account>");
        expect(command).not.toContain("--private-key");
        if (addresses === NOT_LAUNCHED && call.target !== "IMD") {
          expect(call.to, id).toBeNull();
          expect(command).toMatch(/^cast send \$[A-Z_]+ /);
        }
        if (addresses === ALL_LAUNCHED) {
          expect(call.to, id).toMatch(/^0x[0-9a-fA-F]{40}$/);
          expect(command).not.toMatch(/cast send \$/);
        }
      }
      for (const read of plan.reads ?? []) {
        const command = castReadCommand(read, "https://ethereum-rpc.publicnode.com");
        expect(command.startsWith("cast call ")).toBe(true);
        expect(command).not.toContain("--account");
      }
    }
  });
});

describe("opening a pot: its job kind is written out in text", () => {
  const open = flowById("open-pot")!;

  it("puts the kind first in the terms, with the hashes the pot will order under", () => {
    const plan = ok(open.plan(FILLED["open-pot"]!, ctx(ALL_LAUNCHED)));
    expect(plan.calls.map((c) => c.signature)).toEqual([
      "approve(address,uint256)",
      signatureOf(crowdPotsAbi, "openPot"),
    ]);
    // The first chip is what the pot is allowed to pull.
    expect(plan.calls[0]?.args).toEqual([ALL_LAUNCHED.crowdPots, 1n * IMD]);
    const [terms, spec, firstChip] = plan.calls[1]!.args as [Record<string, unknown>, Hex, bigint];
    expect(Object.keys(terms)[0]).toBe("kind");
    expect(terms.kind).toBe("skill:research-report");
    expect(terms).toMatchObject({ target: 5n * IMD, minPay: 2n * IMD, bond: IMD / 2n, allowClaimed: false });
    expect(hexToString(spec)).toBe(RESEARCH_SPEC);
    expect(firstChip).toBe(1n * IMD);
    // The contract derives the two hashes from the text, so neither is an argument of the call.
    expect(plan.summary.join(" ")).toContain("skill:research-report");
    const flat = JSON.stringify(plan.calls[1]!.args, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(flat).not.toContain(kindHash("skill:research-report"));
    expect(flat).not.toContain(specHash(RESEARCH_SPEC));
    const command = castCommand(plan.calls[1]!, "RPC");
    expect(command).toContain("'(skill:research-report,");
  });

  it("opens with no first chip in one call, and refuses a pot the contract would refuse", () => {
    const plan = ok(open.plan({ ...FILLED["open-pot"]!, firstChip: "0" }, ctx()));
    expect(plan.calls.map((c) => c.functionName)).toEqual(["openPot"]);
    expect(problems(open.plan({ ...FILLED["open-pot"]!, target: "0.5" }, ctx())).join(" ")).toContain(
      "at least 1 IMD",
    );
    expect(problems(open.plan({ ...FILLED["open-pot"]!, spec: "" }, ctx()))).toContain(
      "The job text is empty.",
    );
  });
});

describe("Zap: the visitor's minimum and a deadline a few minutes ahead, shown", () => {
  it.each([
    ["zap-chip-in", "chipIn", [4n]],
    ["zap-fund-meter", "fundMeter", [HOUSE_FEEDS.payrolls.id]],
    ["zap-buy", "buy", []],
  ] as const)("%s sends ETH with %s(…, minImdOut, deadline)", (id, functionName, head) => {
    const flow = flowById(id)!;
    const plan = ok(flow.plan({ ...initialValues(flow), ...FILLED[id] }, ctx(ALL_LAUNCHED)));
    const call = plan.calls.at(-1)!;
    expect(call.signature).toBe(signatureOf(zapAbi, functionName));
    // Ten minutes ahead unless the visitor says otherwise.
    const deadline = BigInt(NOW_SECONDS + 600);
    expect(call.args).toEqual([...head, 8n * IMD, deadline]);
    expect(call.value).toBe(10n ** 16n);
    // The plan a visitor reads states the deadline as a time and as the number that is sent.
    const said = plan.summary.join(" ");
    expect(said).toContain(`timestamp ${deadline}`);
    expect(said).toContain("10 Oct 2026, 21:40 UTC");
    expect(said).toContain("10 minutes after this plan was made");
    // The cast command works its deadline out when it is run, so it is never already late.
    const command = castCommand(call, "RPC");
    expect(command).toContain("$(($(date +%s) + 600))");
    expect(command).toContain("--value 10000000000000000");
    expect(command).not.toContain(String(deadline));
  });

  it("takes the visitor's own number of minutes, within bounds", () => {
    const flow = flowById("zap-buy")!;
    const plan = ok(flow.plan({ eth: "0.01", minImdOut: "8", deadlineMinutes: "3" }, ctx()));
    expect((plan.calls[0]!.args as bigint[])[1]).toBe(BigInt(NOW_SECONDS + 180));
    expect(castCommand(plan.calls[0]!, "RPC")).toContain("$(($(date +%s) + 180))");
    expect(problems(flow.plan({ eth: "0.01", minImdOut: "8", deadlineMinutes: "0" }, ctx()))).toContain(
      "Set the deadline between 1 and 120 minutes ahead.",
    );
    expect(problems(flow.plan({ eth: "0.01", minImdOut: "8", deadlineMinutes: "500" }, ctx()))).toContain(
      "Set the deadline between 1 and 120 minutes ahead.",
    );
  });

  it("refuses a minimum of zero, which would accept any price", () => {
    for (const id of ["zap-chip-in", "zap-fund-meter", "zap-buy"]) {
      const flow = flowById(id)!;
      expect(
        problems(flow.plan({ ...initialValues(flow), ...FILLED[id], minImdOut: "0" }, ctx())).join(" "),
      ).toContain("It cannot be zero: a minimum of zero would accept any price.");
    }
  });
});

describe("a feed's meter and the keeper tip", () => {
  it("funds a house feed by name: allow the amount, then fund(feedId, amount)", () => {
    const flow = flowById("fund-feed")!;
    const plan = ok(flow.plan({ feed: "hires", amount: "5" }, ctx(ALL_LAUNCHED)));
    expect(plan.calls.map((c) => c.signature)).toEqual(["approve(address,uint256)", "fund(bytes32,uint256)"]);
    expect(plan.calls[0]?.args).toEqual([ALL_LAUNCHED.questions, 5n * IMD]);
    expect(plan.calls[1]?.args).toEqual([HOUSE_FEEDS.hires.id, 5n * IMD]);
    // What a request costs is read first, so a funder knows how many requests the amount buys.
    expect(castReadCommand(plan.reads![0]!, "RPC")).toBe(
      `cast call ${ALL_LAUNCHED.questions} "costOf(bytes32)(uint256)" ${HOUSE_FEEDS.hires.id} --rpc-url RPC`,
    );
    // Any other feed by its id.
    const other = `0x${"11".repeat(32)}`;
    expect(ok(flow.plan({ feed: "other", feedId: other, amount: "5" }, ctx())).calls[1]?.args).toEqual([
      other,
      5n * IMD,
    ]);
  });

  it("says what the tip is: set aside at the request, earned only by an answered round", () => {
    const request = ok(flowById("request-feed")!.plan({ feed: "payrolls" }, ctx()));
    expect(request.calls[0]?.signature).toBe("request(bytes32)");
    expect(request.calls[0]?.args).toEqual([HOUSE_FEEDS.payrolls.id]);
    const said = request.summary.join(" ");
    expect(said).toMatch(/tip/);
    expect(said).toMatch(/only (if|when|by)/);
    expect(said).not.toMatch(/you are paid the tip at once|paid for asking/);
    // As launched: the tip is the opener's whoever delivers the answer. submit earns nothing.
    expect(said).toContain("the tip is the opener's: handing an answer in earns nothing");
    expect(said).not.toMatch(/submit earns that round's tip|earns that round's tip instead/);

    const collect = ok(flowById("collect-tips")!.plan({}, ctx(ALL_LAUNCHED)));
    expect(collect.calls.map((c) => c.signature)).toEqual([signatureOf(questionsAbi, "collectTips")]);
    expect(collect.calls[0]?.signature).toBe("collectTips()");
    expect(collect.calls[0]?.args).toEqual([]);
    expect(castReadCommand(collect.reads![0]!, "RPC")).toBe(
      `cast call ${ALL_LAUNCHED.questions} "tipsOf(address)(uint256,uint256)" <your-address> --rpc-url RPC`,
    );
  });

  it("claims a seat's share and an agent's tip from Payroll, to the owner; a contract that holds a seat claims for itself", () => {
    const seat = ok(flowById("claim-seat")!.plan({ tokenId: "1998" }, ctx(ALL_LAUNCHED)));
    expect(seat.calls[0]).toMatchObject({ signature: "claimSeat(uint256)", to: ALL_LAUNCHED.payroll });
    const seatSaid = seat.summary.join(" ");
    expect(seatSaid).toMatch(/owner/);
    // As launched: anyone may claim for an ordinary wallet; a contract owner must claim itself.
    expect(seatSaid).toContain("For a seat held by an ordinary wallet, anyone may send the claim.");
    expect(seatSaid).toContain("must be claimed by that contract itself");
    expect(seatSaid).toContain("ContractOwnerMustClaim");
    expect(seatSaid).not.toMatch(/Anyone may call this\./);
    const tip = ok(flowById("claim-tip")!.plan({ agentId: "52211" }, ctx(ALL_LAUNCHED)));
    expect(tip.calls[0]).toMatchObject({ signature: "claimTip(uint256)", args: [52211n] });
    expect(tip.summary.join(" ")).toContain("ContractOwnerMustClaim");
  });

  it("closes a silent round in one call, at the deadline the contract computes", () => {
    const abandon = ok(flowById("abandon-feed")!.plan({ feed: "employers" }, ctx(ALL_LAUNCHED)));
    expect(abandon.calls[0]).toMatchObject({
      signature: "abandon(bytes32)",
      args: [HOUSE_FEEDS.employers.id],
    });
    const said = abandon.summary.join(" ");
    // 12 h to sign, the answer's validity (one day on the house feeds), 5 min of tolerance, 1 s.
    expect(silenceSeconds(HOUSE_FEEDS.employers.params.validFor)).toBe(129_901n);
    expect(said).toContain(
      "One call closes a round once 12 h, the time the feed's answers stay valid, 5 min and one second",
    );
    expect(said).toContain("36 h 5 min and one second for a house feed");
    expect(said).toContain("that takes two calls");
    expect(said).not.toContain("twelve hours after its request");
    // The moment itself is read from the contract first.
    expect(castReadCommand(abandon.reads![0]!, "RPC")).toBe(
      `cast call ${ALL_LAUNCHED.questions} "canAbandon(bytes32)(uint8,uint256)" ${HOUSE_FEEDS.employers.id} --rpc-url RPC`,
    );
  });
});

describe("rules and endowments (launch C)", () => {
  it("creates a rule with its condition, its order terms and its escrow in one call", () => {
    const flow = flowById("create-rule")!;
    const plan = ok(flow.plan(FILLED["create-rule"]!, ctx(ALL_LAUNCHED)));
    expect(plan.calls.map((c) => c.functionName)).toEqual(["approve", "createRule"]);
    expect(plan.calls[1]?.signature).toBe(signatureOf(rulesAbi, "createRule"));
    // The deposit is what the rule is allowed to pull: one order's ceiling and one tip.
    expect(plan.calls[0]?.args).toEqual([ALL_LAUNCHED.rules, 5_050_000_000_000_000_000n]);
    const [params, spec, deposit] = plan.calls[1]!.args as [Record<string, unknown>, Hex, bigint];
    expect(deposit).toBe(5_050_000_000_000_000_000n);
    expect(hexToString(spec)).toBe(RESEARCH_SPEC);
    expect(JSON.stringify(params, (_, v) => (typeof v === "bigint" ? v.toString() : v))).toContain(
      MAINNET.SIMD,
    );
    const flat = JSON.stringify(params, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(flat).toContain("2000000000000000000000000");
    expect(RULE).toEqual({ COND_VIEW: 1, COND_FEED: 2, ACT_HIRE: 1, ACT_PAY: 2 });
    expect(plan.summary.join(" ")).toContain("One fire costs the rule 5.05 IMD; you deposit 5.05 IMD.");
    // A rule may be created short of one fire (anyone can top it up); the plan says that it will wait.
    const short = ok(flow.plan({ ...FILLED["create-rule"]!, deposit: "1" }, ctx()));
    expect(short.summary.join(" ")).toContain(
      "which is less than one fire, so the rule waits until it is topped up",
    );
  });

  it("fires a HIRE rule with the gas limit the launch document names", () => {
    const plan = ok(flowById("fire-rule")!.plan(FILLED["fire-rule"]!, ctx(ALL_LAUNCHED)));
    const call = plan.calls.at(-1)!;
    expect(call.signature).toBe(signatureOf(rulesAbi, "fire"));
    expect(call.gas).toBe(GAS_LIMIT.FIRE_HIRE);
    expect(castCommand(call, "RPC")).toContain("--gas-limit 700000");
  });

  it("a meter endowment says its harvest stops at a runway of 30 requests", () => {
    const create = ok(flowById("endow-create-meter")!.plan({ feed: "payrolls" }, ctx(ALL_LAUNCHED)));
    expect(create.calls.map((c) => c.signature)).toEqual([
      "approve(address,uint256)",
      signatureOf(endowmentsAbi, "createForMeter"),
    ]);
    // Creating one costs the seed, and nothing else.
    expect(create.calls[0]?.args).toEqual([ALL_LAUNCHED.endowments, ENDOWMENT.SEED]);
    expect(create.calls[1]?.args).toEqual([HOUSE_FEEDS.payrolls.id]);
    expect(ENDOWMENT.METER_RUNWAY).toBe(30);
    expect(create.summary.join(" ")).toContain("30 requests");
    const harvest = ok(flowById("endow-harvest")!.plan({ id: "1" }, ctx()));
    expect(harvest.calls[0]?.signature).toBe("harvest(uint256)");
    expect(harvest.summary.join(" ")).toContain("30 requests");
    // A pot endowment's harvest is sent with the gas limit launch C's document asks for.
    const potHarvest = ok(flowById("endow-harvest")!.plan({ id: "1", pot: "true" }, ctx()));
    expect(potHarvest.calls[0]?.gas).toBe(850_000n);
  });
});

describe("the runner's steps", () => {
  it("claim delivery, then finalize with the gas the desk needs in hand", () => {
    const claimDelivered = ok(
      flowById("runner-claim-delivered")!.plan(FILLED["runner-claim-delivered"]!, ctx(ALL_LAUNCHED)),
    );
    expect(claimDelivered.calls.at(-1)).toMatchObject({
      signature: signatureOf(workOrdersAbi, "claimDelivered"),
      args: [7n, `0x${"cd".repeat(32)}`],
    });
    expect(claimDelivered.summary.join(" ")).toContain("at least 48 hours before the delivery deadline");
    const finalize = ok(flowById("runner-finalize")!.plan({ id: "7" }, ctx(ALL_LAUNCHED)));
    expect(finalize.calls[0]).toMatchObject({ signature: "finalize(uint256)", gas: GAS_LIMIT.FINALIZE });
    expect(castCommand(finalize.calls[0]!, "RPC")).toContain("--gas-limit 2000000");
  });

  it("a challenge posts a bond equal to the runner's, and a timeout is anyone's to call", () => {
    const challenge = ok(flowById("order-challenge")!.plan({ id: "7", bond: "0.25" }, ctx(ALL_LAUNCHED)));
    expect(challenge.calls.map((c) => c.functionName)).toEqual(["approve", "challenge"]);
    expect(challenge.calls[0]?.args).toEqual([ALL_LAUNCHED.workOrders, IMD / 4n]);
    const timeout = ok(flowById("order-timeout")!.plan({ id: "7" }, ctx()));
    expect(timeout.calls[0]?.signature).toBe(signatureOf(workOrdersAbi, "timeout"));
  });
});
