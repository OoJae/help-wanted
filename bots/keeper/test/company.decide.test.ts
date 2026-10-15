/**
 * The decision rules of the pots, doorbell, rules and endowments modules: pure functions of a
 * snapshot, each rule with one second (or one block, or one wei) before and at its boundary.
 */
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { ORDER_STATE } from "@help-wanted/shared";
import { decideDoorbell, type DoorbellSnapshot } from "../src/modules/doorbell.js";
import {
  ENDOWMENT_KIND,
  POT_HARVEST_GAS_FLOOR,
  decideEndowments,
  type EndowmentView,
  type EndowmentsSnapshot,
} from "../src/modules/endowments.js";
import {
  LAUNCH_GAS_FLOOR,
  POT_STAGE,
  decidePots,
  type PotView,
  type PotsSnapshot,
} from "../src/modules/pots.js";
import {
  FIRE_GAS_FLOOR,
  RULE_ACTION,
  RULE_STATUS,
  decideRules,
  fireCostInImd,
  type RuleOrderView,
  type RuleView,
  type RulesSnapshot,
} from "../src/modules/rules.js";

const NOW = 1_791_900_000n;
const DAY = 86_400n;
const IMD = (tenths: number): bigint => BigInt(tenths) * 10n ** 17n;
const POTS: Address = "0x0000000000000000000000000000000000009075";
const RULES: Address = "0x0000000000000000000000000000000000002013";
const ENDOWMENTS: Address = "0x000000000000000000000000000000000000E9D0";
const ALICE: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const BOB: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const CAROL: Address = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const SPEC: Hex = "0x57726974652061207265706f72742e";

// ---------------------------------------------------------------------------------------------
// Pots
// ---------------------------------------------------------------------------------------------

const pot = (over: Partial<PotView> = {}): PotView => ({
  id: 4n,
  stage: POT_STAGE.Funding,
  liveStage: POT_STAGE.Funding,
  target: IMD(50),
  raised: IMD(20),
  deadline: NOW + DAY,
  specHash: `0x${"aa".repeat(32)}`,
  spec: SPEC,
  orderId: 0n,
  pool: 0n,
  refundable: [],
  contributorsKnown: true,
  ...over,
});
const pots = (list: PotView[], over: Partial<PotsSnapshot> = {}): PotsSnapshot => ({
  now: NOW,
  crowdPots: POTS,
  potCount: BigInt(list.length),
  launchGrace: DAY,
  pots: list,
  ...over,
});
const potsPolicy = { refundBatch: 40, refundMin: 0n };
const potKinds = (snapshot: PotsSnapshot, policy = potsPolicy) =>
  decidePots(snapshot, policy).actions.map((a) => `${a.kind}:${a.subject}`);

describe("crowd pots", () => {
  it("launches a pot that is full, with its pinned spec and room for the desk's order", () => {
    const decision = decidePots(pots([pot({ raised: IMD(50) })]), potsPolicy);
    expect(decision.actions.map((a) => a.kind)).toEqual(["launch"]);
    expect(decision.actions[0]?.call).toMatchObject({
      address: POTS,
      functionName: "launch",
      args: [4n, SPEC],
    });
    expect(decision.actions[0]?.gasFloor).toBe(LAUNCH_GAS_FLOOR);
    expect(decision.actions[0]?.module).toBe("pots");
  });

  it("does not launch a pot one wei short of its target", () => {
    const decision = decidePots(pots([pot({ raised: IMD(50) - 1n })]), potsPolicy);
    expect(decision.actions).toEqual([]);
    expect(decision.waiting[0]?.reason).toContain("collects until");
  });

  it("launches a full pot until one day after its deadline, not one second later", () => {
    const full = { raised: IMD(50), deadline: NOW - DAY };
    expect(potKinds(pots([pot(full)]))).toEqual(["launch:pot 4"]);
    // One second past the grace the pot can no longer hire: its chips are refundable.
    const late = pot({ raised: IMD(50), deadline: NOW - DAY - 1n, liveStage: POT_STAGE.Refundable });
    late.refundable = [{ contributor: ALICE, amount: IMD(50) }];
    expect(potKinds(pots([late]))).toEqual(["claimRefunds:pot 4"]);
  });

  it("asks for attention when a full pot's spec text cannot be found", () => {
    const decision = decidePots(pots([pot({ raised: IMD(50), spec: null })]), potsPolicy);
    expect(decision.actions).toEqual([]);
    expect(decision.waiting[0]).toMatchObject({ attention: true });
    expect(decision.waiting[0]?.reason).toContain("SpecPinned");
  });

  it("refunds the contributors of a pot that did not fill in time, each their own chip", () => {
    const expired = pot({
      deadline: NOW - 1n,
      liveStage: POT_STAGE.Refundable,
      refundable: [
        { contributor: ALICE, amount: IMD(12) },
        { contributor: BOB, amount: IMD(8) },
      ],
    });
    const decision = decidePots(pots([expired]), potsPolicy);
    expect(decision.actions.map((a) => a.kind)).toEqual(["claimRefunds"]);
    expect(decision.actions[0]?.call.args).toEqual([4n, [ALICE, BOB]]);
    expect(decision.actions[0]?.reason).toContain("it did not hire in time");
    expect(decision.actions[0]?.reason).toContain("the money goes to each contributor");
    // The keeper pays gas only: no action of this module carries IMD of its own.
    expect(decision.actions.every((a) => a.postsImd === undefined)).toBe(true);
  });

  it("settles the books of a hiring pot whose order was delivered, paying the change", () => {
    const delivered = pot({
      stage: POT_STAGE.Hiring,
      liveStage: POT_STAGE.Delivered,
      raised: IMD(50),
      orderId: 9n,
      refundable: [{ contributor: ALICE, amount: IMD(6) }],
    });
    const decision = decidePots(pots([delivered]), potsPolicy);
    expect(decision.actions.map((a) => a.kind)).toEqual(["claimRefunds"]);
    expect(decision.actions[0]?.reason).toContain("its order 9 was delivered");
    expect(decision.actions[0]?.reason).toContain("change");
  });

  it("reconciles alone when the order was delivered at the full price and nothing comes back", () => {
    const delivered = pot({
      stage: POT_STAGE.Hiring,
      liveStage: POT_STAGE.Delivered,
      raised: IMD(50),
      orderId: 9n,
    });
    const decision = decidePots(pots([delivered]), potsPolicy);
    expect(decision.actions.map((a) => a.kind)).toEqual(["reconcile"]);
    expect(decision.actions[0]?.call.args).toEqual([4n]);
    expect(decision.actions[0]?.reason).toContain("still reads Hiring and is Delivered now");
  });

  it("refunds a pot whose order ended without a delivery, forfeited bonds included", () => {
    const refunded = pot({
      stage: POT_STAGE.Hiring,
      liveStage: POT_STAGE.Refundable,
      raised: IMD(50),
      orderId: 9n,
      refundable: [{ contributor: ALICE, amount: IMD(52) }],
    });
    const decision = decidePots(pots([refunded]), potsPolicy);
    expect(decision.actions[0]?.reason).toContain("ended without a delivery");
  });

  it("leaves a hiring pot alone while its order goes on", () => {
    const hiring = pot({
      stage: POT_STAGE.Hiring,
      liveStage: POT_STAGE.Hiring,
      raised: IMD(50),
      orderId: 9n,
    });
    const decision = decidePots(pots([hiring]), potsPolicy);
    expect(decision.actions).toEqual([]);
    expect(decision.waiting[0]?.reason).toContain("order 9, which has not ended");
  });

  it("pays the remaining contributors of a pot that is already settled, in batches", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      contributor: `0x${(i + 1).toString(16).padStart(40, "0")}` as Address,
      amount: IMD(1),
    }));
    const settled = pot({
      stage: POT_STAGE.Refundable,
      liveStage: POT_STAGE.Refundable,
      pool: IMD(5),
      refundable: many,
    });
    const decision = decidePots(pots([settled]), { refundBatch: 2, refundMin: 0n });
    expect(decision.actions).toHaveLength(1);
    expect((decision.actions[0]?.call.args[1] as Address[]).length).toBe(2);
    expect(decision.actions[0]?.label).toBe("pay 2 contributors of pot 4");
  });

  it("leaves a refund below the operator's minimum to its contributor", () => {
    const settled = pot({
      stage: POT_STAGE.Refundable,
      liveStage: POT_STAGE.Refundable,
      pool: IMD(1),
      refundable: [
        { contributor: ALICE, amount: 5n },
        { contributor: CAROL, amount: IMD(1) },
      ],
    });
    const decision = decidePots(pots([settled]), { refundBatch: 40, refundMin: IMD(1) });
    expect(decision.actions[0]?.call.args).toEqual([4n, [CAROL]]);
    expect(decidePots(pots([settled]), { refundBatch: 40, refundMin: IMD(1) + 1n }).actions).toEqual([]);
  });

  it("says so when a settled pot holds IMD and its contributors could not be read", () => {
    const blind = pot({
      stage: POT_STAGE.Refundable,
      liveStage: POT_STAGE.Refundable,
      pool: IMD(5),
      contributorsKnown: false,
    });
    const decision = decidePots(pots([blind]), potsPolicy);
    expect(decision.actions).toEqual([]);
    expect(decision.waiting[0]).toMatchObject({ attention: true });
    expect(decision.waiting[0]?.reason).toContain("ChippedIn");
  });

  it("does nothing with a series, which holds no money", () => {
    expect(
      decidePots(pots([pot({ stage: POT_STAGE.Series, liveStage: POT_STAGE.Series })]), potsPolicy),
    ).toEqual({
      actions: [],
      waiting: [],
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The Doorbell
// ---------------------------------------------------------------------------------------------

const doorbell = (over: Partial<DoorbellSnapshot> = {}): DoorbellSnapshot => ({
  doorbell: "0x000000000000000000000000000000000000be11",
  workOrders: "0x000000000000000000000000000000000000dE5c",
  rings: 30n,
  hires: 1n,
  receipts: 0n,
  ringsUntilHire: 20n,
  funded: true,
  balance: IMD(60),
  maxPay: IMD(30),
  minPay: IMD(10),
  bond: IMD(2) + IMD(1) / 2n,
  deliverySecs: 7n * DAY,
  kindHash: `0x${"76".repeat(32)}`,
  allowClaimed: false,
  lastOrderId: 3n,
  lastOrderState: "Open",
  ...over,
});

describe("the doorbell", () => {
  it("never asks for a transaction: ringing is for people", () => {
    for (const snapshot of [
      doorbell(),
      doorbell({ funded: false, balance: 0n }),
      doorbell({ ringsUntilHire: 1n }),
    ]) {
      expect(decideDoorbell(snapshot).actions).toEqual([]);
    }
  });

  it("says how far the next hire is and how many orders it can pay for", () => {
    const note = decideDoorbell(doorbell()).waiting[0]?.reason ?? "";
    expect(note).toContain("20 rings until the next hire");
    expect(note).toContain("enough for 2 orders");
    expect(note).toContain("Ringing is left to people");
  });

  it("says when it holds too little to hire", () => {
    const note = decideDoorbell(doorbell({ funded: false, balance: IMD(29) })).waiting[0]?.reason ?? "";
    expect(note).toContain("hires nothing until it is funded");
  });

  it("points at the watch on delivery claims when its orders accept them", () => {
    const notes = decideDoorbell(doorbell({ allowClaimed: true })).waiting.map((w) => w.reason);
    expect(notes.some((n) => n.includes("CHALLENGE_FLOAT_IMD"))).toBe(true);
    expect(decideDoorbell(doorbell({ allowClaimed: false })).waiting).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

const rule = (over: Partial<RuleView> = {}): RuleView => ({
  id: 2n,
  status: RULE_STATUS.Armed,
  action: RULE_ACTION.Hire,
  tip: IMD(1) / 2n,
  escrow: IMD(50) + IMD(1) / 2n,
  cost: IMD(50) + IMD(1) / 2n,
  canFire: true,
  met: true,
  value: 2_000_001n,
  fires: 0,
  maxFires: 1,
  readyAt: 0n,
  spec: SPEC,
  ...over,
});
const rules = (
  list: RuleView[],
  orders: RuleOrderView[] = [],
  over: Partial<RulesSnapshot> = {},
): RulesSnapshot => ({
  now: NOW,
  rules: RULES,
  ruleCount: BigInt(list.length),
  feePerGas: 10n ** 9n,
  list,
  orders,
  ...over,
});
/** One ETH is worth 20,000 IMD, and a tip must just cover the gas. */
const rulesPolicy = (over: Partial<Parameters<typeof decideRules>[1]> = {}) => ({
  house: new Set<string>(),
  imdPerEth: 20_000n * 10n ** 18n,
  tipCoverBps: 10_000n,
  ...over,
});

describe("rules", () => {
  it("fires a house rule whose condition holds, whatever its tip", () => {
    const decision = decideRules(
      rules([rule({ tip: 0n })]),
      rulesPolicy({ house: new Set(["2"]), imdPerEth: null }),
    );
    expect(decision.actions.map((a) => a.kind)).toEqual(["fire"]);
    expect(decision.actions[0]?.call).toMatchObject({
      address: RULES,
      functionName: "fire",
      args: [2n, SPEC],
    });
    // launch C's documents: send 700,000 for a HIRE rule.
    expect(decision.actions[0]?.gasFloor).toBe(FIRE_GAS_FLOOR.hire);
    expect(decision.actions[0]?.reason).toContain("on the house list");
  });

  it("never fires a rule the contract says cannot fire", () => {
    const policy = rulesPolicy({ house: new Set(["2"]) });
    expect(decideRules(rules([rule({ canFire: false, met: false })]), policy).actions).toEqual([]);
    // Condition true, escrow one wei short of a fire.
    const short = decideRules(rules([rule({ canFire: false, escrow: IMD(50) })]), policy);
    expect(short.actions).toEqual([]);
    expect(short.waiting[0]).toMatchObject({ attention: true });
    expect(short.waiting[0]?.reason).toContain("below the");
    // Condition true, inside the cooldown.
    const cooling = decideRules(
      rules([rule({ canFire: false, fires: 1, maxFires: 3, readyAt: NOW + 60n })]),
      policy,
    );
    expect(cooling.actions).toEqual([]);
    expect(cooling.waiting[0]?.until).toBe(Number(NOW + 60n));
  });

  it("fires an outside rule only when its tip covers the gas at the current fee", () => {
    // A HIRE fire is priced at 450,000 gas: at 1 gwei that is 0.00045 ETH, or 9 IMD at 20,000.
    expect(fireCostInImd(RULE_ACTION.Hire, 10n ** 9n, 20_000n * 10n ** 18n)).toBe(IMD(90));
    const exact = decideRules(rules([rule({ tip: IMD(90) })]), rulesPolicy());
    expect(exact.actions.map((a) => a.kind)).toEqual(["fire"]);
    expect(exact.actions[0]?.reason).toContain("covers the gas at the current fee");
    const short = decideRules(rules([rule({ tip: IMD(90) - 1n })]), rulesPolicy());
    expect(short.actions).toEqual([]);
    expect(short.waiting[0]?.reason).toContain("does not cover the gas");
  });

  it("follows the fee: the same tip that covered a fire stops covering it when gas doubles", () => {
    const tipped = rule({ tip: IMD(90) });
    expect(decideRules(rules([tipped]), rulesPolicy()).actions).toHaveLength(1);
    expect(decideRules(rules([tipped], [], { feePerGas: 2n * 10n ** 9n }), rulesPolicy()).actions).toEqual(
      [],
    );
    // A PAY rule costs a third of the gas.
    expect(fireCostInImd(RULE_ACTION.Pay, 10n ** 9n, 20_000n * 10n ** 18n)).toBe(IMD(30));
  });

  it("can be told to ask for more than break-even", () => {
    const policy = rulesPolicy({ tipCoverBps: 15_000n });
    expect(decideRules(rules([rule({ tip: IMD(135) - 1n })]), policy).actions).toEqual([]);
    expect(decideRules(rules([rule({ tip: IMD(135) })]), policy).actions).toHaveLength(1);
  });

  it("does not fire an outside rule without a rate for IMD, or without a reading of the fee", () => {
    const noRate = decideRules(rules([rule({ tip: IMD(900) })]), rulesPolicy({ imdPerEth: null }));
    expect(noRate.actions).toEqual([]);
    expect(noRate.waiting[0]?.reason).toContain("RULES_IMD_PER_ETH");
    const noFee = decideRules(rules([rule({ tip: IMD(900) })], [], { feePerGas: null }), rulesPolicy());
    expect(noFee.actions).toEqual([]);
    expect(noFee.waiting[0]?.reason).toContain("fee could not be read");
  });

  it("fires a PAY rule with no job text, and with a smaller floor", () => {
    const pay = rule({ action: RULE_ACTION.Pay, spec: null, tip: IMD(30) });
    const decision = decideRules(rules([pay]), rulesPolicy());
    expect(decision.actions[0]?.call.args).toEqual([2n, "0x"]);
    expect(decision.actions[0]?.gasFloor).toBe(FIRE_GAS_FLOOR.pay);
    expect(decision.actions[0]?.reason).toContain("It makes its payment");
  });

  it("asks for attention when a HIRE rule could fire and its job text was not found", () => {
    const decision = decideRules(rules([rule({ spec: null })]), rulesPolicy({ house: new Set(["2"]) }));
    expect(decision.actions).toEqual([]);
    expect(decision.waiting[0]).toMatchObject({ attention: true });
    expect(decision.waiting[0]?.reason).toContain("RuleCreated");
  });

  it("does nothing with a rule that is exhausted or cancelled", () => {
    const policy = rulesPolicy({ house: new Set(["2"]) });
    expect(decideRules(rules([rule({ status: RULE_STATUS.Exhausted })]), policy).actions).toEqual([]);
    expect(decideRules(rules([rule({ status: RULE_STATUS.Cancelled })]), policy).actions).toEqual([]);
  });

  it("hands back what the desk returned once an order of a rule has ended", () => {
    const refunded: RuleOrderView = {
      ruleId: 2n,
      orderId: 11n,
      state: ORDER_STATE.Refunded,
      returned: IMD(50),
      credited: 0n,
    };
    const decision = decideRules(rules([], [refunded]), rulesPolicy());
    expect(decision.actions.map((a) => a.kind)).toEqual(["reconcile"]);
    expect(decision.actions[0]?.call).toMatchObject({ functionName: "reconcile", args: [2n, 11n] });
    expect(decision.actions[0]?.reason).toContain("the order is Refunded");
  });

  it("does not reconcile an order with nothing new to hand back", () => {
    const even: RuleOrderView = {
      ruleId: 2n,
      orderId: 11n,
      state: ORDER_STATE.Delivered,
      returned: IMD(5),
      credited: IMD(5),
    };
    expect(decideRules(rules([], [even]), rulesPolicy())).toEqual({ actions: [], waiting: [] });
  });

  it("waits for the order to end before handing back a bond the desk awarded on the way", () => {
    const reopened: RuleOrderView = {
      ruleId: 2n,
      orderId: 11n,
      state: ORDER_STATE.Open,
      returned: IMD(2),
      credited: 0n,
    };
    const decision = decideRules(rules([], [reopened]), rulesPolicy());
    expect(decision.actions).toEqual([]);
    expect(decision.waiting[0]?.reason).toContain("when the order ends");
    // The same amount is handed back the moment the order is over.
    const ended = decideRules(rules([], [{ ...reopened, state: ORDER_STATE.Cancelled }]), rulesPolicy());
    expect(ended.actions.map((a) => a.kind)).toEqual(["reconcile"]);
  });

  it("fires before it reconciles: a fire can be raced", () => {
    const order: RuleOrderView = {
      ruleId: 2n,
      orderId: 11n,
      state: ORDER_STATE.Refunded,
      returned: 5n,
      credited: 0n,
    };
    const decision = decideRules(rules([rule({ tip: IMD(90) })], [order]), rulesPolicy());
    expect(decision.actions.map((a) => a.kind)).toEqual(["fire", "reconcile"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Endowments
// ---------------------------------------------------------------------------------------------

const endowment = (over: Partial<EndowmentView> = {}): EndowmentView => ({
  id: 1n,
  kind: ENDOWMENT_KIND.Meter,
  target: `0x${"4b".repeat(32)}`,
  principal: IMD(1000),
  harvestable: 0n,
  ...over,
});
const endowments = (over: Partial<EndowmentsSnapshot> = {}): EndowmentsSnapshot => ({
  now: NOW,
  block: 1_000n,
  endowments: ENDOWMENTS,
  endowmentCount: 1n,
  pendingTotal: 0n,
  nextStakeBlock: 1_000n,
  lastStakeBlock: 950n,
  priceBelowMark: false,
  vaultHold: false,
  list: [endowment()],
  ...over,
});
const endowmentsPolicy = { stakeMin: IMD(1) / 10n, harvestMin: IMD(5) };
const endowmentKinds = (snapshot: EndowmentsSnapshot, policy = endowmentsPolicy) =>
  decideEndowments(snapshot, policy).actions.map((a) => `${a.kind}:${a.subject}`);

describe("endowments", () => {
  it("stakes when the buffer is not empty and the gap has passed, not one block before", () => {
    const waiting = decideEndowments(endowments({ pendingTotal: IMD(100), block: 999n }), endowmentsPolicy);
    expect(waiting.actions).toEqual([]);
    expect(waiting.waiting[0]?.reason).toContain("from block 1000");
    const decision = decideEndowments(endowments({ pendingTotal: IMD(100) }), endowmentsPolicy);
    expect(decision.actions.map((a) => a.kind)).toEqual(["stake"]);
    expect(decision.actions[0]?.call).toMatchObject({ address: ENDOWMENTS, functionName: "stake", args: [] });
    expect(decision.actions[0]?.module).toBe("endowments");
  });

  it("does not stake an empty buffer, or one below the operator's minimum", () => {
    expect(endowmentKinds(endowments({ pendingTotal: 0n }))).toEqual([]);
    const dust = decideEndowments(endowments({ pendingTotal: IMD(1) / 10n - 1n }), endowmentsPolicy);
    expect(dust.actions).toEqual([]);
    expect(dust.waiting[0]?.reason).toContain("once at least");
    expect(endowmentKinds(endowments({ pendingTotal: IMD(1) / 10n }))).toEqual(["stake:stake"]);
  });

  it("neither stakes nor harvests while sIMD's price is below the mark", () => {
    const snapshot = endowments({
      pendingTotal: IMD(100),
      priceBelowMark: true,
      list: [endowment({ harvestable: IMD(50) })],
    });
    const decision = decideEndowments(snapshot, endowmentsPolicy);
    expect(decision.actions).toEqual([]);
    expect(decision.waiting.some((w) => w.attention && w.reason.includes("below the highest"))).toBe(true);
  });

  it("harvests when there is something to harvest and the target has room, at the minimum and not below", () => {
    // `harvestable` is the contract's own figure for both: cut to the meter's room or the pot's need.
    expect(endowmentKinds(endowments({ list: [endowment({ harvestable: IMD(5) - 1n })] }))).toEqual([]);
    const decision = decideEndowments(
      endowments({ list: [endowment({ harvestable: IMD(5) })] }),
      endowmentsPolicy,
    );
    expect(decision.actions.map((a) => a.kind)).toEqual(["harvest"]);
    expect(decision.actions[0]?.call).toMatchObject({ functionName: "harvest", args: [1n] });
    expect(decision.actions[0]?.gasFloor).toBeUndefined();
    expect(decision.actions[0]?.reason).toContain("the target has room for it");
  });

  it("does not harvest a full meter or a pot that needs nothing: the contract reports zero", () => {
    expect(
      decideEndowments(endowments({ list: [endowment({ harvestable: 0n })] }), endowmentsPolicy),
    ).toEqual({
      actions: [],
      waiting: [],
    });
  });

  it("sends a pot harvest with the gas the pot must be handed", () => {
    const potEndowment = endowment({ id: 3n, kind: ENDOWMENT_KIND.Pot, harvestable: IMD(9) });
    const decision = decideEndowments(endowments({ list: [potEndowment] }), endowmentsPolicy);
    expect(decision.actions[0]?.gasFloor).toBe(POT_HARVEST_GAS_FLOOR);
    expect(decision.actions[0]?.reason).toContain("to its pot");
  });

  it("does not harvest while sIMD is holding the contract, or in the block of a stake", () => {
    const ready = [endowment({ harvestable: IMD(9) })];
    const held = decideEndowments(endowments({ list: ready, vaultHold: true }), endowmentsPolicy);
    expect(held.actions).toEqual([]);
    expect(held.waiting[0]?.reason).toContain("on the next pass");
    expect(endowmentKinds(endowments({ list: ready, block: 950n, lastStakeBlock: 950n }))).toEqual([]);
    expect(endowmentKinds(endowments({ list: ready, block: 951n, lastStakeBlock: 950n }))).toEqual([
      "harvest:endowment 1",
    ]);
  });

  it("harvests before it stakes: a stake puts the contract on hold for its block", () => {
    const snapshot = endowments({
      pendingTotal: IMD(100),
      list: [
        endowment({ harvestable: IMD(9) }),
        endowment({ id: 2n, kind: ENDOWMENT_KIND.Recipient, harvestable: IMD(7) }),
      ],
    });
    expect(endowmentKinds(snapshot)).toEqual(["harvest:endowment 1", "harvest:endowment 2", "stake:stake"]);
    // Nothing here spends the keeper's own IMD.
    expect(decideEndowments(snapshot, endowmentsPolicy).actions.every((a) => a.postsImd === undefined)).toBe(
      true,
    );
  });
});
