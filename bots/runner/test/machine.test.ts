import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESK as DESK_CONST, ORDER_FLAG, ORDER_STATE, kindHash, orderTicket } from "@help-wanted/shared";
import { ChainWriteError } from "../src/chain.js";
import { Machine, type MachineConfig } from "../src/machine.js";
import { spentToday } from "../src/store.js";
import { objectiveFor } from "./fakes.js";
import { NOW, QUOTE_URL, finishJob, raw, ticks, world, type World } from "./harness.js";
import { DESK, JOB_ID, ORDER_ID, PRICE, RUNNER, SPEC, TEST_PRIVATE_KEY } from "./world.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW * 1000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("dry run", () => {
  it("reads, decides and says what it would do; it signs nothing and sends nothing", async () => {
    const w = world({ mode: "dry-run" });
    w.desk.open(ORDER_ID);
    await ticks(w, 3);
    expect(w.desk.writes()).toEqual([]);
    expect(w.api.checks).toEqual([]);
    expect(w.requests).toEqual([]);
    expect(w.record()?.status).toBe("seen");
    const plans = w.log.lines.filter((l) => l.includes("dry run: would take this order"));
    expect(plans).toHaveLength(1); // said once, though three passes ran
    const plan = plans[0];
    expect(plan).toContain(objectiveFor(ORDER_ID, 1));
    expect(plan).toContain(`claim(${ORDER_ID})`);
    expect(plan).toContain("DRY_RUN_PREFLIGHT=1");
    expect(spentToday(w.store, NOW)).toBe(0n);
  });

  it("makes no POST at all, the free preflight included, unless a flag asks for it", async () => {
    const silent = world({ mode: "dry-run" });
    silent.desk.open(ORDER_ID);
    await silent.machine.tick();
    expect(silent.api.checks).toEqual([]);

    const asking = world({ mode: "dry-run", dryRunPreflight: true });
    asking.desk.open(ORDER_ID);
    asking.api.checkKind = "skill:research-report";
    await asking.machine.tick();
    // The one free POST, with the objective the job would have; still nothing signed or sent.
    expect(asking.api.checks).toHaveLength(1);
    expect((asking.api.checks[0] as { objective: string }).objective).toBe(objectiveFor(ORDER_ID, 1));
    expect(asking.requests).toEqual([]);
    expect(asking.desk.writes()).toEqual([]);
    const plan = asking.log.lines.find((l) => l.includes("dry run: would take this order"));
    expect(plan).toContain('"preflight":{"blockers":[],"kind":"skill:research-report"}');
  });

  it("is what a live configuration without a payment flow falls back to", async () => {
    const w = world();
    const machine = new Machine({
      config: w.config,
      store: w.store,
      desk: w.desk,
      api: w.api,
      payFlow: null,
      now: () => NOW,
      log: w.log,
      killed: () => false,
    });
    w.desk.open(ORDER_ID);
    await machine.tick();
    expect(w.desk.writes()).toEqual([]);
    expect(w.record()?.status).toBe("seen");
  });
});

describe("the claimed path, end to end", () => {
  it("claims, pays, registers, claims delivery and finalizes", async () => {
    const w = world();
    w.desk.open(ORDER_ID);

    await w.machine.tick(); // discover, preflight, quote and challenge, approve, claim
    expect(w.record()?.status).toBe("claimed");
    expect(w.api.checks).toHaveLength(1);
    expect((w.api.checks[0] as { objective: string }).objective).toBe(objectiveFor(ORDER_ID, 1));
    expect(w.desk.writes()).toEqual([`approve ${DESK_CONST.MIN_BOND}`, `claim ${ORDER_ID}`]);
    expect(w.record()?.claim?.seq).toBe(1);
    expect(w.record()?.claim?.ticket).toBe(
      orderTicket({ chainId: 1, workOrders: DESK, orderId: ORDER_ID, claimSeq: 1, runner: RUNNER }),
    );
    // The quote and its challenge were read before the bond was posted, and nothing was signed.
    expect(w.quotes()).toHaveLength(1);
    expect(w.paying()).toEqual([]);
    expect(w.record()?.pay?.stage).toBe("quoted");

    await w.machine.tick(); // challenge again, sign, submit, poll
    expect(w.record()?.status).toBe("paid");
    expect(w.record()?.jobId).toBe(JOB_ID);
    expect(w.paying()).toHaveLength(1);
    expect(w.quotes()).toHaveLength(1); // the order quoted before the claim is the one paid
    expect(w.record()?.spent).toBe(PRICE.toString());
    expect(spentToday(w.store, NOW)).toBe(PRICE);

    await w.machine.tick(); // register
    expect(w.record()?.status).toBe("registered");
    expect(w.desk.writes().at(-1)).toBe(`register ${ORDER_ID} ${JOB_ID}`);

    await w.machine.tick(); // the job is still running
    expect(w.record()?.status).toBe("registered");

    const { hash } = finishJob(w);
    await w.machine.tick(); // completed, no receipt on chain: bonded claim
    expect(w.record()?.status).toBe("asserted");
    expect(w.record()?.recordHash).toBe(hash);
    expect(w.desk.writes().at(-1)).toBe(`claimDelivered ${ORDER_ID} ${hash}`);

    await w.machine.tick(); // inside the challenge window: nothing to do
    expect(w.desk.writes().at(-1)).toBe(`claimDelivered ${ORDER_ID} ${hash}`);

    w.setTime(NOW + DESK_CONST.CHALLENGE_WINDOW + 1);
    await w.machine.tick();
    // Paid, and not yet matched to a receipt: the order is watched for its receipt from here.
    expect(w.record()?.status).toBe("unproven");
    expect(w.record()?.outcome).toContain("finalized unchallenged");
    expect(w.desk.writes().at(-1)).toBe(`finalize ${ORDER_ID}`);
    expect(w.desk.orders.get(ORDER_ID)?.order.state).toBe(ORDER_STATE.Delivered);
    expect(w.desk.orders.get(ORDER_ID)?.order.proven).toBe(false);
    // No bond is posted on it any more.
    expect(w.machine.bondsAtRisk()).toBe(0n);

    await ticks(w, 2); // with no receipt there is nothing to send
    expect(w.desk.writes().at(-1)).toBe(`finalize ${ORDER_ID}`);
    expect(w.paying()).toHaveLength(1);
  });

  it("settles with the receipt instead, as soon as it lands", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    await ticks(w, 3);
    const { hash } = finishJob(w);
    await w.machine.tick();
    expect(w.record()?.status).toBe("asserted");
    w.desk.receipts.set(JOB_ID, hash);
    await w.machine.tick();
    expect(w.record()?.status).toBe("delivered");
    expect(w.desk.writes().at(-1)).toBe(`settle ${ORDER_ID} ${hash}`);
  });
});

describe("the proven path", () => {
  it("settles directly when the receipt is already on chain", async () => {
    const w = world({ receiptOnlyOrders: "always" });
    w.desk.open(ORDER_ID, { flags: 0 });
    await ticks(w, 3);
    const { hash } = finishJob(w);
    await w.machine.tick(); // completed, no receipt: this order allows no claim, so wait
    expect(w.record()?.status).toBe("registered");
    expect(w.desk.writes().some((c) => c.startsWith("claimDelivered"))).toBe(false);
    w.desk.receipts.set(JOB_ID, hash);
    await w.machine.tick();
    expect(w.record()?.status).toBe("delivered");
    expect(w.desk.writes().at(-1)).toBe(`settle ${ORDER_ID} ${hash}`);
  });

  it("neither settles nor claims delivery while the registry holds a receipt it cannot read", async () => {
    const w = world();
    w.desk.open(ORDER_ID); // allows the bonded claim
    await ticks(w, 3);
    finishJob(w);
    // The registry answers for this job with a hash no served record has. Whatever the API lists,
    // what the registry holds is what can be proven, so nothing is staked on the listed record.
    w.desk.receipts.set(JOB_ID, `0x${"11".repeat(32)}`);
    await ticks(w, 2);
    expect(w.record()?.status).toBe("registered");
    expect(w.desk.writes().some((c) => c.startsWith("settle") || c.startsWith("claimDelivered"))).toBe(false);
    expect(w.loud().some((l) => l.includes("receipt whose record is not served yet"))).toBe(true);
  });
});

describe("orders the runner leaves alone", () => {
  const skip = async (configure: (w: World) => void, overrides: Partial<MachineConfig> = {}) => {
    const w = world(overrides);
    configure(w);
    await ticks(w, 2);
    expect(w.desk.writes()).toEqual([]);
    expect(w.requests).toEqual([]);
    return w.record();
  };

  it.each([
    [
      "a kind that is not in the shared table of kinds a runner can open",
      (w: World) => void w.desk.open(ORDER_ID, {}, { kind: "skill:build-website" }),
      "not in the shared table of kinds the swarm is known to write",
    ],
    [
      "a kind the swarm never writes",
      (w: World) => void w.desk.open(ORDER_ID, {}, { kind: "skill:no-such-skill" }),
      "no job this runner could buy would settle it",
    ],
    [
      "a kind that is not on the allow-list",
      (w: World) => void w.desk.open(ORDER_ID, {}, { kind: "skill:create-image" }),
      "its kind (skill:create-image) is not on this runner's allow-list",
    ],
    ["a bond above the limit", (w: World) => void w.desk.open(ORDER_ID, { bond: 2n * 10n ** 18n }), "bond"],
    [
      "no bonded claim path",
      (w: World) => void w.desk.open(ORDER_ID, { flags: ORDER_FLAG.CALLBACK }),
      "bonded claim",
    ],
    [
      "an arbiter the runner does not know",
      (w: World) => void w.desk.open(ORDER_ID, { arbiter: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" }),
      "arbiter",
    ],
    [
      "another runner reserved",
      (w: World) => void w.desk.open(ORDER_ID, { runnerOnly: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" }),
      "reserved",
    ],
    [
      "too little time left",
      (w: World) => void w.desk.open(ORDER_ID, { expiresAt: NOW + 600 }),
      "expires too soon",
    ],
    [
      "an earlier release by this runner",
      (w: World) => {
        w.desk.open(ORDER_ID);
        w.desk.barredFor.add(ORDER_ID);
      },
      "released the order before",
    ],
    [
      "already paid out",
      (w: World) => void w.desk.open(ORDER_ID, { state: ORDER_STATE.Delivered }),
      "Delivered",
    ],
  ])("skips an order with %s, for good", async (_note, configure, words) => {
    const rec = await skip(configure);
    expect(rec?.status).toBe("skipped");
    expect(rec?.skip?.permanent).toBe(true);
    expect(rec?.skip?.reason).toContain(words);
    // A skipped order no longer carries its text: it is never needed again.
    expect(rec?.spec).toBe("");
  });

  it("skips a spec whose text does not hash to the order, or that the desk could not settle", async () => {
    const tampered = await skip((w) => {
      const entry = w.desk.open(ORDER_ID);
      entry.spec = `${SPEC} and more`;
    });
    expect(tampered?.status).toBe("skipped");
    expect(tampered?.skip?.reason).toContain("specHash");

    const unsettleable = await skip((w) => void w.desk.open(ORDER_ID, {}, { spec: 'say "hi"' }));
    expect(unsettleable?.skip?.reason).toContain("not one the desk accepts");
  });

  it("skips an audit whose spec names no repository, or names it in the old spelling", async () => {
    const none = await skip(
      (w) => void w.desk.open(ORDER_ID, {}, { kind: "audit", spec: "Audit something." }),
    );
    expect(none?.status).toBe("skipped");
    expect(none?.skip?.reason).toContain("repoUrl");
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const old = await skip(
      (w) =>
        void w.desk.open(
          ORDER_ID,
          {},
          { kind: "audit", spec: `Audit. Inputs: repoUrl=https://github.com/o/r baseCommit=${commit}` },
        ),
    );
    expect(old?.status).toBe("skipped");
    expect(old?.skip?.reason).toContain("repoUrl");
  });

  it("skips an order of a kind with large records when it allows no bonded claim", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const rec = await skip(
      (w) =>
        void w.desk.open(
          ORDER_ID,
          { flags: 0 },
          { kind: "audit", spec: `Audit. Inputs: repoUrl=https://github.com/o/r; baseCommit=${commit}` },
        ),
      { receiptOnlyOrders: "always" },
    );
    // An audit's record is more than one transaction carries; with no claim path it could not be settled.
    expect(rec?.status).toBe("skipped");
    expect(rec?.skip?.reason).toContain("records of kind audit have run to 255000 bytes");
    expect(rec?.skip?.reason).toContain("against this runner's limit of 3000000");
  });

  it("accepts an arbiter that is on the runner's list", async () => {
    const arbiter = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
    const w = world({ arbiters: new Set([arbiter]) });
    w.desk.open(ORDER_ID, { arbiter });
    await w.machine.tick();
    expect(w.record()?.status).toBe("claimed");
  });

  it("takes only listed employers' orders when a list is set", async () => {
    const other = await skip((w) => void w.desk.open(ORDER_ID), {
      employers: new Set(["0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"]),
    });
    expect(other?.status).toBe("skipped");
    expect(other?.skip?.reason).toContain("not on this runner's list");

    const w = world({ employers: new Set(["0x70997970c51812dc3a010c7d01b50e0d17dc79c8"]) });
    w.desk.open(ORDER_ID); // the fake employer, spelled in lowercase in the list
    await w.machine.tick();
    expect(w.record()?.status).toBe("claimed");
  });

  it("waits while the price leaves no margin, and takes the order once it does", async () => {
    const w = world();
    // The runner's 90% of 0.6 IMD is 0.54: the 0.5 fee leaves less than the 0.05 margin.
    const entry = w.desk.open(ORDER_ID, {}, { price: 6n * 10n ** 17n });
    await w.machine.tick();
    expect(w.record()?.status).toBe("seen");
    expect(w.record()?.skip).toMatchObject({ permanent: false });
    expect(w.record()?.skip?.reason).toContain("margin");
    expect(w.desk.writes()).toEqual([]);
    entry.price = 10n ** 18n; // the price ramped up
    await w.machine.tick();
    expect(w.record()?.status).toBe("claimed");
    expect(w.record()?.skip).toBeUndefined();
  });

  it("asks the price to cover an allowance for failures, in proportion to what a failure costs", async () => {
    // 5% of (bond 0.25 + fee 0.5) is 0.0375. With the fee and the margin: 0.5875 needed.
    const w = world({ failureBps: 500n });
    const entry = w.desk.open(ORDER_ID, {}, { price: 65n * 10n ** 16n }); // pays the runner 0.585
    await w.machine.tick();
    expect(w.record()?.status).toBe("seen");
    expect(w.record()?.skip?.reason).toContain("allowance for failures");
    entry.price = 66n * 10n ** 16n; // pays 0.594
    await w.machine.tick();
    expect(w.record()?.status).toBe("claimed");
  });

  it("waits for a condition that does not hold yet", async () => {
    const w = world();
    const entry = w.desk.open(ORDER_ID, {
      condTarget: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
      condMet: false,
    });
    entry.conditionHolds = false;
    await w.machine.tick();
    expect(w.record()?.skip?.reason).toContain("condition");
    expect(w.record()?.status).toBe("seen");
    entry.conditionHolds = true;
    await w.machine.tick();
    expect(w.record()?.status).toBe("claimed");
  });

  it("waits when the wallet cannot cover the bond and the fee", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    w.desk.balance = DESK_CONST.MIN_BOND;
    await w.machine.tick();
    expect(w.record()?.status).toBe("seen");
    expect(w.record()?.skip?.reason).toContain("less than the bond plus the fee");
    expect(w.desk.writes()).toEqual([]);
  });

  it("counts the fees of orders already claimed and not yet paid for against the wallet", async () => {
    const w = world({ maxConcurrent: 5 });
    w.desk.open(7n);
    w.desk.open(8n, {}, { spec: "Another report, on another subject." });
    // Enough for one bond and one fee, and for a second bond, but not for a second fee as well.
    w.desk.balance = 2n * DESK_CONST.MIN_BOND + PRICE + 1n;
    w.desk.permit2Allowance = 10n * PRICE;
    await w.machine.tick();
    expect(w.record(7n)?.status).toBe("claimed");
    expect(w.record(8n)?.status).toBe("seen");
    expect(w.record(8n)?.skip?.reason).toContain("owed for orders already claimed");

    // The same with Permit2's allowance: it covers one fee, and one is already owed.
    const v = world({ maxConcurrent: 5 });
    v.desk.open(7n);
    v.desk.open(8n, {}, { spec: "Another report, on another subject." });
    v.desk.permit2Allowance = PRICE;
    await v.machine.tick();
    expect(v.record(7n)?.status).toBe("claimed");
    expect(v.record(8n)?.skip?.reason).toContain("Permit2 is approved for");
  });

  it("waits when the wallet has too little ETH for the steps after a claim", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    w.desk.eth = 10n ** 15n;
    await w.machine.tick();
    expect(w.record()?.status).toBe("seen");
    expect(w.record()?.skip?.reason).toContain("kept for gas");
    expect(w.desk.writes()).toEqual([]);
    expect(w.api.checks).toEqual([]);
    w.desk.eth = 10n ** 16n;
    await w.machine.tick();
    expect(w.record()?.status).toBe("claimed");
  });

  it("waits until Permit2 is approved for the fee", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    w.desk.permit2Allowance = 0n;
    await w.machine.tick();
    expect(w.record()?.status).toBe("seen");
    expect(w.record()?.skip?.reason).toContain("bootstrap");
    expect(w.desk.writes()).toEqual([]);
  });

  it.each([
    ["another recipient", { payTo: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" }, "the fee goes to"],
    ["another token", { asset: "0x9efa934d9fad4ae28c998a40195646b965a97247" }, "priced in"],
    ["another network", { network: "eip155:4663" }, "sold on"],
    ["a fee above the per-order cap", { amount: "600000000000000000" }, "above the per-order cap"],
  ])("claims nothing while the protocol's payment terms name %s", async (_note, change, words) => {
    const w = world();
    w.desk.open(ORDER_ID);
    Object.assign(w.api.terms, change);
    await ticks(w, 2);
    expect(w.record()?.status).toBe("seen");
    expect(w.record()?.skip?.reason).toContain(words);
    expect(w.desk.writes()).toEqual([]);
    expect(w.requests).toEqual([]);
  });

  it("claims nothing when the payment terms cannot be read, and reads them again next pass", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    const good = w.api.capabilities.bind(w.api);
    w.api.capabilities = async () => {
      throw new Error("503");
    };
    await w.machine.tick();
    expect(w.record()?.status).toBe("seen");
    expect(w.desk.writes()).toEqual([]);
    w.api.capabilities = good;
    await w.machine.tick();
    expect(w.record()?.status).toBe("claimed");
  });

  it("uses the live fee for the margin, and reads the terms at most once in ten minutes", async () => {
    const w = world({ orderCap: 10n ** 18n });
    // The runner's 90% of 0.7 IMD is 0.63: enough over a 0.5 fee, not over a 0.6 fee.
    w.desk.open(ORDER_ID, {}, { price: 7n * 10n ** 17n });
    w.api.terms.amount = "600000000000000000";
    await ticks(w, 3);
    expect(w.record()?.status).toBe("seen");
    expect(w.record()?.skip?.reason).toContain("margin");
    expect(w.desk.writes()).toEqual([]);
    expect(w.api.capabilitiesCalls).toBe(1);
  });

  it("resume has a put-off order looked at again at once, breaker or not", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    w.api.blockers = [{ code: "busy", detail: "try later" }];
    const good = w.api.capabilities.bind(w.api);
    w.api.capabilities = async () => {
      throw new Error("503");
    };
    await ticks(w, 3);
    expect(w.record()?.status).toBe("seen");
    expect(w.record()?.nextLookAt ?? 0).toBeGreaterThan(NOW);
    w.api.capabilities = good;
    w.api.blockers = [];
    expect(w.machine.resume()).toBe(false);
    expect(w.record()?.nextLookAt).toBeUndefined();
    await w.machine.tick();
    expect(w.record()?.status).toBe("claimed");
  });

  it("with LOOK_ONLY it asks for the quote and the challenge, checks them, and claims nothing", async () => {
    const w = world({ lookOnly: true });
    w.desk.open(ORDER_ID);
    await ticks(w, 2);
    expect(w.desk.writes()).toEqual([]);
    expect(w.record()?.status).toBe("seen");
    expect(w.record()?.skip?.reason).toContain("LOOK_ONLY");
    expect(w.record()?.pay).toBeUndefined();
    expect(w.record()?.nextLookAt).toBeUndefined();
    // The quote and the challenge were asked for; no paying request was sent.
    expect(w.requests.some((r) => r.url === QUOTE_URL)).toBe(true);
    expect(w.requests.some((r) => r.url.endsWith("/submit"))).toBe(true);
    expect(w.requests.every((r) => r.headers["payment-signature"] === undefined)).toBe(true);
  });

  it("does not claim when the protocol's preflight names a blocker", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    w.api.blockers = [{ code: "content_screen", detail: "objective refused" }];
    await ticks(w, 2);
    expect(w.record()?.status).toBe("skipped");
    expect(w.record()?.skip?.reason).toContain("content_screen");
    expect(w.desk.writes()).toEqual([]);
    expect(w.requests).toEqual([]);
  });

  it("leaves for good an order whose job the protocol refuses at the quote", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    w.protocol.quote = () => ({
      status: 422,
      headers: {},
      text: '{"error":"invalid_input","detail":"objective refused by the content screen","problems":[]}',
    });
    await ticks(w, 2);
    expect(w.record()?.status).toBe("skipped");
    expect(w.record()?.skip?.reason).toContain("input_refused");
    expect(w.desk.writes()).toEqual([]);
    expect(w.quotes()).toHaveLength(1); // not asked again
  });

  it("does not claim when the preflight would open a job of another kind", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    w.api.checkKind = "research"; // a work-record kind, and not the order's
    await ticks(w, 2);
    expect(w.record()?.status).toBe("skipped");
    expect(w.record()?.skip?.reason).toContain('kind "research"');
    expect(w.desk.writes()).toEqual([]);
    expect(w.requests).toEqual([]);
  });

  it("goes on when the preflight's kind is the order's, or is a word of another vocabulary", async () => {
    const same = world();
    same.desk.open(ORDER_ID);
    same.api.checkKind = "skill:research-report";
    await same.machine.tick();
    expect(same.record()?.status).toBe("claimed");

    // The live preflight answered `report` for a research-report job that carried our header (11
    // October 2026): a word of another vocabulary. A value that is not spelled like a work-record
    // kind cannot be compared with one, so it is said, quietly, and not acted on.
    const other = world();
    other.desk.open(ORDER_ID);
    other.api.checkKind = "report";
    await other.machine.tick();
    expect(other.record()?.status).toBe("claimed");
    expect(other.visible().some((l) => l.includes("not a work-record kind") && l.includes('"report"'))).toBe(
      true,
    );
    expect(other.loud().some((l) => l.includes("not a work-record kind"))).toBe(false);
  });

  it("looks at skipped orders again when the settings that decide what is taken change", async () => {
    // A runner set to write reports skips a picture order for good, and forgets its text.
    const first = world();
    first.desk.open(ORDER_ID, {}, { kind: "skill:create-image" });
    await first.machine.tick();
    expect(first.record()?.status).toBe("skipped");
    expect(first.record()?.spec).toBe("");
    // The operator adds pictures to the allow-list and starts it again on the same store.
    const second = world(
      {
        templates: new Map([
          [kindHash("skill:research-report"), "skill:research-report"],
          [kindHash("skill:create-image"), "skill:create-image"],
        ]),
      },
      { store: first.store, desk: first.desk, api: first.api },
    );
    await second.machine.tick();
    expect(second.record()?.status).toBe("claimed");
    expect(second.visible().some((l) => l.includes("looking at skipped orders again"))).toBe(true);
    // An order in hand is never dropped, whatever the settings become: here they change back,
    // and the claim made under the wider list is still the runner's to finish.
    const third = world({}, { store: first.store, desk: first.desk, api: first.api });
    await third.machine.tick();
    expect(third.record()?.claim?.seq).toBe(1);
    expect(third.visible().some((l) => l.includes("looking at skipped orders again"))).toBe(false);
  });

  it("does not read the logs again while the settings stay as they were", async () => {
    const first = world();
    first.desk.open(ORDER_ID, {}, { kind: "skill:create-image" });
    await first.machine.tick();
    const cursor = first.store.data.cursor;
    const second = world({}, { store: first.store, desk: first.desk, api: first.api });
    await second.machine.tick();
    expect(second.record()?.status).toBe("skipped");
    expect(second.visible().some((l) => l.includes("looking at skipped orders again"))).toBe(false);
    expect(BigInt(second.store.data.cursor ?? "0")).toBeGreaterThanOrEqual(BigInt(cursor ?? "0"));
  });
});

describe("what the protocol makes of the job is learned before the bond is posted", () => {
  const rewriting = (w: World, rewrite: (input: Record<string, unknown>) => unknown) => {
    const quote = w.protocol.quote;
    w.protocol.quote = (request) => {
      const answer = quote(request);
      const body = JSON.parse(answer.text) as { order: { inputJson: string } };
      body.order.inputJson = JSON.stringify(
        rewrite(JSON.parse(body.order.inputJson) as Record<string, unknown>),
      );
      return { ...answer, text: JSON.stringify(body) };
    };
  };

  it("claims nothing when the quote changed the objective", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    rewriting(w, () => ({ objective: SPEC, skill: "research-report" }));
    await ticks(w, 2);
    expect(w.record()?.status).toBe("seen");
    expect(w.record()?.skip?.reason).toContain("prepared_objective_lost_header");
    expect(w.desk.writes()).toEqual([]); // no bond posted, so nothing to give back
    expect(w.paying()).toEqual([]);
    expect(spentToday(w.store, NOW)).toBe(0n);
    expect(w.log.lines.some((l) => l.includes('"level":"error"') && l.includes("did not pass"))).toBe(true);
  });

  it("claims nothing when the quote turned the job into another kind", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    rewriting(w, (input) => ({ objective: input.objective, template: "research" }));
    await ticks(w, 2);
    expect(w.record()?.status).toBe("seen");
    expect(w.record()?.skip?.reason).toContain("prepared_input");
    expect(w.desk.writes()).toEqual([]);
    expect(w.paying()).toEqual([]);
  });

  it("claims nothing when the payment window is as long as the quote lives", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    const challenge = w.protocol.challenge;
    w.protocol.challenge = () => {
      const answer = challenge();
      const body = JSON.parse(answer.text) as { accepts: { maxTimeoutSeconds: number }[] };
      (body.accepts[0] as { maxTimeoutSeconds: number }).maxTimeoutSeconds = 600;
      return { ...answer, text: JSON.stringify(body) };
    };
    for (let pass = 0; pass < 8; pass++) {
      await w.machine.tick();
      w.wait(120);
    }
    // A permit signed under such a challenge would outlive its quote, so none is signed, and
    // because this was found out before the claim, it cost nothing.
    expect(w.record()?.status).toBe("seen");
    expect(w.desk.writes()).toEqual([]);
    expect(w.paying()).toEqual([]);
    expect(w.loud().some((l) => l.includes("challenge_window"))).toBe(true);
  });

  it("does not claim on a quote that is about to run out, and asks for another", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    w.desk.failNext = new ChainWriteError("fee_too_high", "the network asks 9 gwei; the cap is 3");
    w.desk.allowance = 10n ** 18n;
    await w.machine.tick(); // quoted, then the claim could not be sent
    expect(w.record()?.status).toBe("seen");
    expect(w.record()?.pay?.stage).toBe("quoted");
    w.wait(400); // 200 seconds of the quote left: a payment signed on it would outlive it
    await w.machine.tick();
    expect(w.record()?.status).toBe("seen");
    expect(w.desk.writes().filter((c) => c.startsWith("claim "))).toHaveLength(1); // only the failed one
    expect(w.record()?.pay?.attempt).toBe(2);
    await w.machine.tick(); // a new quote under a new key, and the claim on that
    expect(w.record()?.status).toBe("claimed");
    expect(w.quotes()).toHaveLength(2);
    await w.machine.tick();
    expect(w.record()?.status).toBe("paid");
    expect(w.paying()).toHaveLength(1);
  });

  it("gives the order back if the job is changed between the quote and the payment", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    await w.machine.tick();
    expect(w.record()?.status).toBe("claimed");
    // After the claim, the challenge carries another input than the quote did.
    const challenge = w.protocol.challenge;
    w.protocol.challenge = () => {
      const answer = challenge();
      const body = JSON.parse(answer.text) as { input: unknown };
      body.input = { objective: SPEC, skill: "research-report" };
      return { ...answer, text: JSON.stringify(body) };
    };
    await w.machine.tick();
    expect(w.record()?.status).toBe("releasing");
    expect(w.paying()).toEqual([]);
    expect(spentToday(w.store, NOW)).toBe(0n);
    await w.machine.tick();
    expect(w.record()?.status).toBe("released");
    expect(w.desk.writes().at(-1)).toBe(`release ${ORDER_ID}`);
    expect(w.record()?.outcome).toContain("prepared_objective_lost_header");
  });
});

describe("limits", () => {
  it("holds no more orders at once than it may", async () => {
    const w = world({ maxConcurrent: 1 });
    w.desk.open(7n);
    w.desk.open(8n);
    await w.machine.tick();
    expect(w.record(7n)?.status).toBe("claimed");
    expect(w.record(8n)?.status).toBe("seen");
    expect(w.record(8n)?.skip?.reason).toContain("already holds");
    expect(w.desk.writes().filter((c) => c.startsWith("claim "))).toEqual(["claim 7"]);
  });

  it("keeps the bonds it has posted under a limit", async () => {
    const w = world({ maxConcurrent: 5, maxBondsAtRisk: 4n * 10n ** 17n });
    w.desk.open(7n);
    w.desk.open(8n, {}, { spec: "Another report, on another subject." });
    await w.machine.tick();
    expect(w.record(7n)?.status).toBe("claimed");
    expect(w.machine.bondsAtRisk()).toBe(DESK_CONST.MIN_BOND);
    // A second 0.25 IMD bond would make 0.5, above the 0.4 allowed.
    expect(w.record(8n)?.status).toBe("seen");
    expect(w.record(8n)?.skip?.reason).toContain("bonds this runner has posted");
  });

  it("stops taking orders when today's cap is used up", async () => {
    const w = world({ dailyCap: PRICE });
    w.store.data.spend["2026-10-10"] = PRICE.toString();
    w.desk.open(ORDER_ID);
    await w.machine.tick();
    expect(w.record()?.status).toBe("seen");
    expect(w.record()?.skip?.reason).toContain("today's spending cap");
    expect(w.desk.writes()).toEqual([]);
  });

  const blank = (id: string) => ({
    id,
    status: "claimed" as const,
    employer: DESK,
    kindHash: kindHash("audit"),
    specHash: kindHash("x"),
    spec: "x",
    openedBlock: "1",
    spent: "0",
    updatedAt: NOW,
  });

  it("the cap hooks refuse a payment over the order's cap or the day's, and give back a release", () => {
    const w = world({ dailyCap: PRICE * 2n, orderCap: PRICE });
    w.store.data.orders["7"] = blank("7");
    const rec = w.record();
    if (!rec) throw new Error("no record");
    const caps = w.machine.capsFor(rec);
    expect(caps.reserve(PRICE + 1n)).toBe(false);
    expect(caps.reserve(PRICE)).toBe(true);
    expect(rec.spent).toBe(PRICE.toString());
    expect(caps.reserve(1n)).toBe(false); // the order's cap is used up
    expect(spentToday(w.store, NOW)).toBe(PRICE);
    caps.release(PRICE);
    expect(rec.spent).toBe("0");
    expect(spentToday(w.store, NOW)).toBe(0n);
    // The day's cap, across orders.
    w.store.data.spend["2026-10-10"] = (PRICE * 2n).toString();
    expect(caps.reserve(PRICE)).toBe(false);
  });

  it("takes a reservation given back after midnight off the day it was booked on", () => {
    const w = world();
    w.store.data.orders["7"] = blank("7");
    w.store.data.orders["8"] = blank("8");
    const a = w.machine.capsFor(w.store.data.orders["7"]);
    const b = w.machine.capsFor(w.store.data.orders["8"]);
    const beforeMidnight = Date.UTC(2026, 9, 10, 23, 59, 30) / 1000;
    const afterMidnight = beforeMidnight + 120;
    w.setTime(beforeMidnight);
    expect(a.reserve(PRICE)).toBe(true); // order 7 signs at 23:59:30
    w.setTime(afterMidnight);
    expect(b.reserve(PRICE)).toBe(true); // order 8 pays at 00:01:30, and is charged
    a.release(PRICE, "2026-10-10"); // order 7's quote ran out unpaid
    expect(spentToday(w.store, afterMidnight)).toBe(PRICE); // what was paid today is still counted
    expect(spentToday(w.store, beforeMidnight)).toBe(0n); // and nothing was paid yesterday
  });

  it("counts spending by UTC day", () => {
    const w = world();
    w.store.data.spend["2026-10-10"] = "5";
    expect(spentToday(w.store, NOW)).toBe(5n);
    expect(spentToday(w.store, NOW + 4 * 3600)).toBe(0n); // 00:00 UTC on the 11th
  });
});

describe("the kill switch", () => {
  it("stops claims and payments while it is on, and lets the runner carry on after", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    w.kill(true);
    await ticks(w, 2);
    expect(w.desk.writes()).toEqual([]);
    expect(w.requests).toEqual([]);
    expect(w.record()?.status).toBe("seen");
    expect(w.log.lines.some((l) => l.includes("kill switch is on"))).toBe(true);
    w.kill(false);
    await w.machine.tick();
    expect(w.record()?.status).toBe("claimed");
    const asked = w.requests.length;
    w.kill(true);
    await ticks(w, 2);
    expect(w.requests).toHaveLength(asked); // nothing more is asked of the paid routes
    expect(w.paying()).toEqual([]);
    expect(w.record()?.status).toBe("claimed");
  });
});

describe("when the job cannot be bought", () => {
  it("gives the order back when the claim window is about to end and nothing was signed", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    await w.machine.tick();
    expect(w.record()?.status).toBe("claimed");
    w.protocol.challenge = () => ({ status: 503, headers: {}, text: '{"error":"paid_request_unavailable"}' });
    await w.machine.tick();
    expect(w.record()?.status).toBe("claimed");
    w.setTime(NOW + DESK_CONST.CLAIM_WINDOW - 300);
    await w.machine.tick();
    expect(w.record()?.status).toBe("releasing");
    await w.machine.tick();
    expect(w.record()?.status).toBe("released");
    expect(w.paying()).toEqual([]);
  });

  it("starts no payment in the last minutes of the window, when it can no longer give the order back", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    await w.machine.tick();
    w.protocol.challenge = () => ({ status: 503, headers: {}, text: '{"error":"paid_request_unavailable"}' });
    await w.machine.tick();
    // The runner was down, or the protocol was, until a minute before the window ends. A job
    // bought now could not be registered in time: the fee would be lost on top of the bond.
    w.protocol.challenge = () => ({ status: 402, headers: {}, text: raw("challenge-402.json") });
    w.setTime(NOW + DESK_CONST.CLAIM_WINDOW - 60);
    await ticks(w, 2);
    expect(w.paying()).toEqual([]);
    expect(w.desk.writes().some((c) => c.startsWith("release"))).toBe(false); // the desk would refuse it
    expect(w.record()?.status).toBe("claimed");
    expect(w.log.lines.filter((l) => l.includes("the claim window is over with no job bought"))).toHaveLength(
      1,
    );
  });

  it("does not sign a payment while the transaction that must follow it could not be sent", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    await w.machine.tick();
    expect(w.record()?.status).toBe("claimed");
    // A paid job must be registered within the hour. With gas above even the higher cap, it could
    // not be, so the 0.5 IMD is not spent yet.
    w.desk.blocked = "the network asks 90 gwei per gas; the cap is 30";
    await ticks(w, 2);
    expect(w.paying()).toEqual([]);
    expect(w.record()?.status).toBe("claimed");
    expect(spentToday(w.store, NOW)).toBe(0n);
    w.desk.blocked = null;
    await w.machine.tick();
    expect(w.paying()).toHaveLength(1);
    expect(w.record()?.status).toBe("paid");
  });

  it("keeps waiting on a signed payment for most of the window, then gives the claim back", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    w.protocol.status = () => ({ status: 200, headers: {}, text: raw("status-payment-pending.json") });
    await ticks(w, 2);
    expect(w.record()?.pay?.stage).toBe("submitted");
    w.setTime(NOW + DESK_CONST.CLAIM_WINDOW - 400);
    await w.machine.tick();
    expect(w.record()?.status).toBe("claimed");
    expect(w.desk.writes().some((c) => c.startsWith("release"))).toBe(false);
    expect(
      w.log.lines.some((l) => l.includes('"level":"error"') && l.includes("claim window is about to end")),
    ).toBe(true);
    // Five minutes from the end with still no job id: past the window anyone may remove the claim
    // for the whole bond, and giving it back costs a tenth.
    w.setTime(NOW + DESK_CONST.CLAIM_WINDOW - 250);
    await w.machine.tick();
    expect(w.record()?.status).toBe("releasing");
    expect(w.record()?.outcome).toContain("fee charged: maybe");
    await w.machine.tick();
    expect(w.record()?.status).toBe("released");
  });

  it("says once that an order it could not give back in time can be removed for the whole bond", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    await w.machine.tick();
    // The paying request is refused outright: nothing was taken, and the order is to be given back.
    w.protocol.submit = () => ({
      status: 400,
      headers: {},
      text: '{"error":"invalid_quote_approval","detail":"signature does not match"}',
    });
    await w.machine.tick();
    expect(w.record()?.status).toBe("releasing");
    expect(w.store.data.breaker?.failures).toBe(1);
    // The release does not get through before the window ends.
    w.desk.release = async () => {
      throw new ChainWriteError("fee_too_high", "the network asks 90 gwei; the cap is 30");
    };
    await ticks(w, 2);
    w.setTime(NOW + DESK_CONST.CLAIM_WINDOW + 5);
    await ticks(w, 4);
    expect(w.record()?.status).toBe("releasing");
    expect(w.log.lines.filter((l) => l.includes("nothing more can be done for this claim"))).toHaveLength(1);
    expect(w.store.data.breaker?.failures).toBe(1);
  });

  it("counts once a payment that ends without a job when the order can no longer be given back", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    w.protocol.status = () => ({ status: 200, headers: {}, text: raw("status-payment-pending.json") });
    await ticks(w, 2);
    expect(w.record()?.pay?.stage).toBe("submitted");
    // Admission is refused a minute before the window ends: the fee is gone, and so is the time.
    w.api.paidOrders = [];
    w.setTime(NOW + DESK_CONST.CLAIM_WINDOW - 60);
    w.protocol.status = () => ({ status: 200, headers: {}, text: raw("status-refused.json") });
    await ticks(w, 5);
    expect(w.record()?.status).toBe("claimed");
    expect(w.record()?.outcome).toContain("admission_refused");
    expect(w.desk.writes().some((c) => c.startsWith("release"))).toBe(false);
    expect(w.store.data.breaker?.failures).toBe(1); // not once per pass
    expect(w.log.lines.filter((l) => l.includes("payment ended without a job"))).toHaveLength(1);
    expect(w.log.lines.filter((l) => l.includes("nothing more can be done for this claim"))).toHaveLength(1);
  });

  it("registers the job after all when it is too late to give the order back", async () => {
    const w = world({ registerAtOnce: false });
    w.desk.open(ORDER_ID);
    await ticks(w, 2);
    expect(w.record()?.status).toBe("paid");
    finishJob(w, { state: "blocked" });
    await w.machine.tick();
    expect(w.record()?.status).toBe("releasing"); // blocked before registration: to be given back
    // The release does not get through before the window ends.
    w.desk.release = async () => {
      throw new ChainWriteError("fee_too_high", "the network asks 90 gwei; the cap is 30");
    };
    await w.machine.tick();
    w.setTime(NOW + DESK_CONST.CLAIM_WINDOW + 5);
    await w.machine.tick();
    // Until somebody removes the runner it can still register, which keeps a way to the bond open.
    expect(w.record()?.status).toBe("paid");
    await w.machine.tick();
    expect(w.record()?.status).toBe("registered");
    expect(w.desk.writes().at(-1)).toBe(`register ${ORDER_ID} ${JOB_ID}`);
  });

  it("quotes again after a failed settlement of the payment, instead of giving the order back", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    let failed = true;
    w.protocol.status = () => ({
      status: 200,
      headers: {},
      text: raw(failed ? "status-payment-failed.json" : "status-admitted.json"),
    });
    await ticks(w, 2);
    // `payment_failed` is an ordinary event (the settlement reverted, or came after the permit ran
    // out), and nothing was taken. The order is kept, and the cap is not charged twice.
    expect(w.record()?.status).toBe("claimed");
    expect(w.record()?.pay?.abandoned).toBe(true);
    expect(w.desk.writes().some((c) => c.startsWith("release"))).toBe(false);
    // No second signature while the first permit could still be settled.
    await w.machine.tick();
    expect(w.paying()).toHaveLength(1);
    w.wait(301); // the first permit's five minutes are over
    await w.machine.tick(); // the failed order is left behind
    expect(w.record()?.pay?.attempt).toBe(2);
    expect(w.record()?.pay?.stage).toBe("new");
    failed = false; // the new order's payment goes through
    await w.machine.tick();
    expect(w.record()?.pay?.attempt).toBe(2);
    expect(w.quotes()).toHaveLength(2);
    expect(w.paying()).toHaveLength(2);
    expect(w.record()?.status).toBe("paid");
    expect(spentToday(w.store, NOW)).toBe(PRICE); // one fee counted, not two
  });

  it("stops taking orders after payments keep failing, until an operator resumes", async () => {
    const w = world({ maxConcurrent: 5, maxPayFailures: 2 });
    w.desk.open(7n);
    await w.machine.tick();
    expect(w.record(7n)?.status).toBe("claimed");
    // The paying request is refused outright: a payload the server will not read.
    w.protocol.submit = () => ({
      status: 400,
      headers: {},
      text: '{"error":"invalid_quote_approval","detail":"signature does not match"}',
    });
    await ticks(w, 2);
    expect(w.record(7n)?.status).toBe("released");
    expect(w.store.data.breaker).toMatchObject({ failures: 1, trippedAt: null });

    w.desk.open(8n, {}, { spec: "Another report, on another subject." });
    w.desk.head += 10n;
    w.desk.orders.get(8n)!.block = w.desk.head - 3n;
    await ticks(w, 3);
    expect(w.record(8n)?.status).toBe("released");
    expect(w.store.data.breaker?.failures).toBe(2);
    expect(w.store.data.breaker?.trippedAt).toBe(NOW);
    expect(
      w.log.lines.some((l) => l.includes('"level":"error"') && l.includes("stopped taking new orders")),
    ).toBe(true);

    // Two bonds cut by a tenth is enough: the third order is not claimed.
    w.desk.open(9n, {}, { spec: "A third report." });
    w.desk.head += 10n;
    w.desk.orders.get(9n)!.block = w.desk.head - 3n;
    await ticks(w, 2);
    expect(w.record(9n)?.status).toBe("seen");
    expect(w.record(9n)?.skip?.reason).toContain("resume");
    expect(w.desk.writes().filter((c) => c === "claim 9")).toEqual([]);

    w.protocol.submit = () => ({ status: 202, headers: {}, text: raw("status-payment-pending.json") });
    expect(w.machine.resume()).toBe(true);
    expect(w.store.data.breaker).toBeUndefined();
    await w.machine.tick();
    expect(w.record(9n)?.status).toBe("claimed");
    expect(w.machine.resume()).toBe(false);
  });
});

describe("faults", () => {
  it("leaves the order where it is when the fee is above the cap, and tries again later", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    w.desk.allowance = 10n ** 18n;
    w.desk.failNext = new ChainWriteError("fee_too_high", "the network asks 9 gwei; the cap is 3");
    await w.machine.tick();
    expect(w.record()?.status).toBe("seen");
    expect(w.record()?.lastError).toContain("fee_too_high");
    await w.machine.tick();
    expect(w.record()?.status).toBe("claimed");
    expect(w.record()?.lastError).toBeUndefined();
    expect(w.quotes()).toHaveLength(1); // the quote made before the first try is the one used
  });

  it("one order's failure does not stop the others", async () => {
    const w = world({ maxConcurrent: 5 });
    w.desk.open(7n);
    w.desk.open(8n, {}, { spec: "Another report, on another subject." });
    w.desk.allowance = 10n ** 18n;
    w.desk.failNext = new ChainWriteError("simulation_reverted", "would revert: BadState");
    await w.machine.tick();
    expect(w.record(7n)?.status).toBe("seen");
    expect(w.record(8n)?.status).toBe("claimed");
  });

  it("never logs the wallet key", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    await ticks(w, 3);
    expect(w.log.lines.join("\n")).not.toContain(TEST_PRIVATE_KEY.slice(2));
  });
});

describe("reading new orders", () => {
  it("reads each block's logs once", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    w.kill(true); // reads only: the chain's head stays where it is
    await w.machine.tick();
    expect(w.store.data.cursor).toBe("998"); // head 1000, two confirmations
    const before = w.desk.calls.filter((c) => c.startsWith("logs ")).length;
    await w.machine.tick();
    expect(w.desk.calls.filter((c) => c.startsWith("logs ")).length).toBe(before);
    w.desk.head = 1_010n;
    await w.machine.tick();
    expect(w.desk.calls.filter((c) => c.startsWith("logs ")).at(-1)).toBe("logs 999-1008");
  });

  it("a node that refuses a log query does not keep the runner from the orders it holds", async () => {
    const w = world();
    w.desk.open(ORDER_ID);
    await w.machine.tick();
    expect(w.record()?.status).toBe("claimed");
    const cursor = w.store.data.cursor;
    w.desk.head = 2_000n;
    w.desk.ordersOpened = async () => {
      throw new Error("Archive requests require a personal token");
    };
    await w.machine.tick();
    expect(w.record()?.status).toBe("paid");
    expect(w.log.lines.some((l) => l.includes("could not read new orders this pass"))).toBe(true);
    expect(w.store.data.cursor).toBe(cursor);
    expect(w.store.data.discoveryFailures).toBe(1);
  });

  it("tries a refused range again in smaller pieces before it calls the read failed", async () => {
    const w = world({ logChunkBlocks: 800n });
    w.desk.open(ORDER_ID);
    w.kill(true);
    const real = w.desk.ordersOpened.bind(w.desk);
    const asked: string[] = [];
    w.desk.ordersOpened = async (from, to) => {
      asked.push(`${from}-${to}`);
      if (to - from + 1n > 100n) throw new Error("query returned more than 100 blocks");
      return real(from, to);
    };
    await w.machine.tick();
    expect(asked[0]).toBe("0-799");
    expect(asked[1]).toBe("0-99"); // an eighth of the configured size
    expect(w.store.data.cursor).toBe("998");
    expect(w.record()?.status).toBe("seen");
    expect(w.store.data.discoveryFailures).toBeUndefined();
  });

  it("says it louder the longer no logs can be read, and stops saying it once they can", async () => {
    const w = world();
    w.kill(true);
    const real = w.desk.ordersOpened.bind(w.desk);
    w.desk.ordersOpened = async () => {
      throw new Error("Archive requests require a personal token");
    };
    await ticks(w, 5);
    expect(w.store.data.discoveryFailures).toBe(5);
    const errors = w.log.lines.filter(
      (l) => l.includes('"level":"error"') && l.includes("have not been read"),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("keyed RPC_URL");
    w.desk.ordersOpened = real;
    await w.machine.tick();
    expect(w.store.data.discoveryFailures).toBeUndefined();
  });
});

describe("many orders the runner will not take", () => {
  it("looks at an order that does not qualify less and less often", async () => {
    const w = world();
    w.desk.open(ORDER_ID, {}, { price: 6n * 10n ** 17n }); // never leaves the margin
    const looks: number[] = [];
    for (let minute = 0; minute < 40; minute++) {
      const before = w.desk.reads;
      await w.machine.tick();
      if (w.desk.reads > before) looks.push(minute);
      w.wait(60);
    }
    // At once, again on the next pass, then after one, two, four, eight, sixteen minutes.
    expect(looks).toEqual([0, 1, 2, 4, 8, 16, 32]);
  });

  it("looks at a bounded number of them each pass, and at the orders in hand every pass", async () => {
    const w = world();
    for (let id = 1n; id <= 60n; id++) w.desk.open(id, {}, { kind: "skill:build-website" });
    w.desk.open(100n); // one worth taking, behind sixty that are not
    await w.machine.tick();
    expect(w.desk.reads).toBe(25);
    await ticks(w, 2);
    expect(w.record(100n)?.status).toBe("claimed");
    const skipped = Object.values(w.store.data.orders).filter((r) => r.status === "skipped");
    expect(skipped).toHaveLength(60);
    const before = w.desk.reads;
    await w.machine.tick();
    // Only the order in hand is read now: the skipped ones are never looked at again.
    expect(w.desk.reads - before).toBeLessThanOrEqual(2);
  });

  it("writes the store only when something changed", async () => {
    const w = world();
    w.kill(true);
    w.desk.open(ORDER_ID, {}, { price: 6n * 10n ** 17n });
    await ticks(w, 2);
    w.wait(30); // inside the order's back-off: nothing is looked at
    const saves = (w.store as unknown as { saves: number }).saves;
    await ticks(w, 3);
    expect((w.store as unknown as { saves: number }).saves).toBe(saves);
  });
});

describe("the summary", () => {
  it("counts orders by where they stand and lists the ones in hand", async () => {
    const w = world();
    w.desk.open(7n);
    w.desk.open(8n, {}, { kind: "skill:build-website" });
    await w.machine.tick();
    expect(w.machine.summary()).toEqual(
      expect.arrayContaining([
        { status: "claimed", count: 1 },
        { status: "skipped", count: 1 },
      ]),
    );
    expect(w.machine.held()).toEqual([
      { order: "7", status: "claimed", bond: DESK_CONST.MIN_BOND.toString() },
    ]);
    expect(w.requests.some((r) => r.url === QUOTE_URL)).toBe(true);
  });
});
