import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CLAIM_END,
  DESK,
  JOB_TEMPLATES,
  ORDER_FLAG,
  ORDER_STATE,
  buildJobInput,
  formatSpecInputs,
  isTerminalOrderState,
  kindHash,
  orderStateName,
  parseSpecInputs,
  priceAt,
  releaseCut,
  splitPrice,
  templateByKindHash,
  checkSpec,
  type JobTemplate,
} from "../src/index.js";
import { repoFile, vector } from "./paths.js";

describe("desk constants and arithmetic", () => {
  it("names the states in the order the interface declares them", () => {
    expect(Object.keys(ORDER_STATE)).toEqual([
      "None",
      "Open",
      "Claimed",
      "Registered",
      "Asserted",
      "Disputed",
      "Delivered",
      "Cancelled",
      "Refunded",
    ]);
    expect(Object.values(ORDER_STATE)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(orderStateName(3)).toBe("Registered");
    expect(() => orderStateName(9)).toThrow(RangeError);
    expect([6, 7, 8].every(isTerminalOrderState)).toBe(true);
    expect([0, 1, 2, 3, 4, 5].some(isTerminalOrderState)).toBe(false);
    expect(ORDER_FLAG).toEqual({ ALLOW_CLAIMED: 1, CALLBACK: 2, COND_ARG: 4 });
    expect(CLAIM_END.DisputeExpired).toBe(6);
  });

  it("splits a price into runner pay, fee and tip that always sum to the price", () => {
    expect(splitPrice(10n ** 18n)).toEqual({
      runnerPay: 9n * 10n ** 17n,
      fee: 5n * 10n ** 16n,
      tip: 5n * 10n ** 16n,
    });
    // Each of fee and tip is rounded up to the next wei.
    expect(splitPrice(1n)).toEqual({ runnerPay: 0n, fee: 1n, tip: 0n });
    expect(splitPrice(19n)).toEqual({ runnerPay: 17n, fee: 1n, tip: 1n });
    expect(splitPrice(21n)).toEqual({ runnerPay: 17n, fee: 2n, tip: 2n });
    expect(splitPrice(0n)).toEqual({ runnerPay: 0n, fee: 0n, tip: 0n });
    for (const price of [1n, 2n, 3n, 19n, 20n, 21n, 999n, 10n ** 18n + 1n, 2n ** 96n - 1n]) {
      const s = splitPrice(price);
      expect(s.runnerPay + s.fee + s.tip).toBe(price);
      expect(s.runnerPay >= 0n && s.fee >= 0n && s.tip >= 0n).toBe(true);
    }
    expect(() => splitPrice(-1n)).toThrow(RangeError);
  });

  it("prices along the ramp as priceNow does", () => {
    const ramp = { minPay: 100n, maxPay: 200n, rampSecs: 100, rampFrom: 1000 };
    expect(priceAt({ ...ramp, now: 1000 })).toBe(100n);
    expect(priceAt({ ...ramp, now: 1050 })).toBe(150n);
    expect(priceAt({ ...ramp, now: 1099 })).toBe(199n);
    expect(priceAt({ ...ramp, now: 1100 })).toBe(200n);
    expect(priceAt({ ...ramp, now: 99999 })).toBe(200n);
    // A conditional order that has not been triggered sits at the start of its ramp.
    expect(priceAt({ ...ramp, rampFrom: 0, now: 99999 })).toBe(100n);
    // No ramp at all: the full price at once.
    expect(priceAt({ ...ramp, rampSecs: 0, now: 1000 })).toBe(200n);
    // A clock read before the ramp started prices at its start, never below.
    expect(priceAt({ ...ramp, now: 900 })).toBe(100n);
  });

  it("prices an untriggered conditional order with no ramp at maxPay, as the contract does", () => {
    // WorkOrders._price: `elapsed = from == 0 ? 0 : now - from; price = maxPay; if (elapsed <
    // rampSecs) price = minPay + ...`. With rampSecs zero the branch is never taken, triggered or
    // not. A helper that answered minPay here showed a 9 IMD order as paying 1.
    expect(priceAt({ minPay: 1n, maxPay: 9n, rampSecs: 0, rampFrom: 0, now: 1_791_662_400 })).toBe(9n);
    expect(
      priceAt({ minPay: 1n, maxPay: 9n, rampSecs: 0, rampFrom: 1_791_000_000, now: 1_791_662_400 }),
    ).toBe(9n);
    expect(priceAt({ minPay: 1n, maxPay: 9n, rampSecs: 10, rampFrom: 0, now: 1_791_662_400 })).toBe(1n);
  });

  it("carries the windows and limits the desk source declares, when it is there", (ctx) => {
    const path = repoFile("launches", "b-desk", "src", "desk", "WorkOrders.sol");
    if (!path) return ctx.skip();
    const source = readFileSync(path, "utf8");
    const seconds = (name: string): number => {
      const m = new RegExp(`constant ${name} = (\\d+) (hours|days);`).exec(source);
      if (!m) throw new Error(`${name} not found in WorkOrders.sol`);
      return Number(m[1]) * (m[2] === "hours" ? 3600 : 86400);
    };
    const number = (name: string): bigint => {
      const m = new RegExp(`constant ${name} = ([0-9_]+);`).exec(source);
      if (!m) throw new Error(`${name} not found in WorkOrders.sol`);
      return BigInt((m[1] as string).replaceAll("_", ""));
    };
    expect(DESK.CLAIM_WINDOW).toBe(seconds("CLAIM_WINDOW"));
    expect(DESK.CHALLENGE_WINDOW).toBe(seconds("CHALLENGE_WINDOW"));
    expect(DESK.DISPUTE_WINDOW).toBe(seconds("DISPUTE_WINDOW"));
    expect(DESK.MIN_DELIVERY).toBe(seconds("MIN_DELIVERY"));
    expect(DESK.MAX_DELIVERY).toBe(seconds("MAX_DELIVERY"));
    expect(DESK.FEE_BPS).toBe(number("FEE_BPS"));
    expect(DESK.TIP_BPS).toBe(number("TIP_BPS"));
    expect(DESK.RELEASE_BPS).toBe(number("RELEASE_BPS"));
    expect(DESK.CALLBACK_GAS).toBe(number("CALLBACK_GAS"));
    expect(DESK.CONDITION_GAS).toBe(number("CONDITION_GAS"));
    expect(DESK.PAYROLL_GAS).toBe(number("PAYROLL_GAS"));
    expect(/constant MIN_BOND = 0\.25e18;/.test(source)).toBe(true);
    // The claim-end reasons, in the order the contract's enum declares them. The enum is declared
    // in the runner's interface file, which the desk implements; older trees had it in the desk.
    const runnerInterface = repoFile("launches", "b-desk", "src", "interfaces", "IWorkOrdersRunner.sol");
    const declarations = [source, runnerInterface ? readFileSync(runnerInterface, "utf8") : ""]
      .join("\n")
      .replace(/\/\/\/.*$/gm, "")
      .replace(/\/\/.*$/gm, "");
    const end = /enum End \{([\s\S]*?)\}/.exec(declarations);
    expect(end?.[1]?.split(",").map((part) => part.trim())).toEqual(Object.keys(CLAIM_END));
  });

  it("takes a tenth of the bond on a release", () => {
    expect(releaseCut(DESK.MIN_BOND)).toBe(25_000_000_000_000_000n);
    expect(releaseCut(9n)).toBe(0n);
  });
});

describe("job input", () => {
  const audit = JOB_TEMPLATES.audit as JobTemplate;
  const report = JOB_TEMPLATES["skill:research-report"] as JobTemplate;
  const header = `[help-wanted order ${"ab".repeat(32)}] `;
  const commit = "0123456789abcdef0123456789abcdef01234567";

  it("finds a template by the kind hash an order carries", () => {
    const golden = vector<{ hashes: Record<string, string> }>("abi-selectors.json").hashes;
    expect(templateByKindHash(golden['keccak256("audit")'] as `0x${string}`)).toBe(audit);
    expect(templateByKindHash(kindHash("skill:research-report"))).toBe(report);
    expect(templateByKindHash(kindHash("skill:unknown"))).toBeUndefined();
    for (const [key, template] of Object.entries(JOB_TEMPLATES)) expect(template.kind).toBe(key);
  });

  it("every template's kind is one a real work record carries", () => {
    const kinds = new Set(
      vector<{ vectors: { kind: string }[] }>("work-record-vectors.json").vectors.map((v) => v.kind),
    );
    for (const template of Object.values(JOB_TEMPLATES)) {
      if (template.kindVerified) expect(kinds.has(template.kind), template.kind).toBe(true);
    }
  });

  it("reads the trailing Inputs clause: pairs separated by a semicolon and a space", () => {
    const spec = `Audit the staking vault. Inputs: repoUrl=https://github.com/owner/repo; baseCommit=${commit}`;
    expect(checkSpec(spec).ok).toBe(true);
    expect(parseSpecInputs(spec)).toEqual({
      ok: true,
      inputs: { repoUrl: "https://github.com/owner/repo", baseCommit: commit },
    });
    expect(parseSpecInputs("No inputs here.")).toEqual({ ok: true, inputs: {} });
    expect(parseSpecInputs("MoreInputs: x")).toEqual({ ok: true, inputs: {} });
    expect(parseSpecInputs(`Inputs: baseCommit=${commit}`)).toEqual({
      ok: true,
      inputs: { baseCommit: commit },
    });
    // Any key of letters and digits; a value may hold spaces and anything but a semicolon.
    expect(parseSpecInputs("Build a page for a bakery. Inputs: name=Crumb & Co; city=Lagos")).toEqual({
      ok: true,
      inputs: { name: "Crumb & Co", city: "Lagos" },
    });
    expect(parseSpecInputs("x Inputs: a=1=2; b2=two words")).toEqual({
      ok: true,
      inputs: { a: "1=2", b2: "two words" },
    });
  });

  it("reads the example the header vectors carry, and every area's fixtures that use the clause", () => {
    const example = vector<{ objectiveExample: { spec: string; inputs: Record<string, string> } }>(
      "header-vectors.json",
    ).objectiveExample;
    expect(parseSpecInputs(example.spec)).toEqual({ ok: true, inputs: example.inputs });
    const built = buildJobInput(audit, header + example.spec, example.spec);
    expect(built.ok && built.input.repoUrl).toBe(example.inputs.repoUrl);
    const pots = repoFile("launches", "b-desk", "test", "fixtures", "pots", "specs.json");
    if (pots) {
      const valid = (JSON.parse(readFileSync(pots, "utf8")) as { validText: string[] }).validText;
      for (const text of valid.filter((t) => t.includes("Inputs: "))) {
        expect(parseSpecInputs(text).ok, text).toBe(true);
      }
    }
  });

  it("refuses a clause that does not follow the format", () => {
    // The older spelling, pairs separated by a space alone: the second pair lands in the first value.
    const old = parseSpecInputs(`x Inputs: repoUrl=https://github.com/o/r baseCommit=${commit}`);
    expect(old).toEqual({
      ok: true,
      inputs: { repoUrl: `https://github.com/o/r baseCommit=${commit}` },
    });
    // So an audit written the old way is left alone, not opened against a wrong repository.
    expect(
      buildJobInput(audit, `${header}x`, `x Inputs: repoUrl=https://github.com/o/r baseCommit=${commit}`),
    ).toEqual({ ok: false, reason: 'input "repoUrl" has an invalid value' });
    expect(parseSpecInputs(`x Inputs: baseCommit=${commit}; baseCommit=${commit}`).ok).toBe(false);
    expect(parseSpecInputs("x Inputs: ").ok).toBe(false);
    expect(parseSpecInputs("x Inputs: novalue").ok).toBe(false);
    expect(parseSpecInputs("x Inputs: =1").ok).toBe(false);
    expect(parseSpecInputs("x Inputs: a=").ok).toBe(false);
    expect(parseSpecInputs("x Inputs: a=1;b=2").ok).toBe(false); // a semicolon inside a value
    expect(parseSpecInputs("x Inputs: a=1;  b=2").ok).toBe(false); // two spaces
    expect(parseSpecInputs("x Inputs: a-b=1").ok).toBe(false);
    expect(parseSpecInputs("x Inputs: a b=1").ok).toBe(false);
    expect(parseSpecInputs("x Inputs: __proto__=1").ok).toBe(false);
  });

  it("writes the clause it reads", () => {
    const inputs = { baseCommit: commit, repoUrl: "https://github.com/owner/repo" };
    const clause = formatSpecInputs(inputs);
    expect(clause).toBe(`Inputs: repoUrl=https://github.com/owner/repo; baseCommit=${commit}`);
    expect(parseSpecInputs(`Audit. ${clause}`)).toEqual({ ok: true, inputs });
    expect(formatSpecInputs({})).toBe("");
    expect(formatSpecInputs({ city: "Lagos", name: "Crumb & Co" })).toBe(
      "Inputs: city=Lagos; name=Crumb & Co",
    );
    expect(() => formatSpecInputs({ "a-b": "1" })).toThrow(RangeError);
    expect(() => formatSpecInputs({ a: "1; b=2" })).toThrow(RangeError);
    expect(() => formatSpecInputs({ a: "" })).toThrow(RangeError);
    expect(() => formatSpecInputs({ a: " padded" })).toThrow(RangeError);
  });

  it("builds an audit body as the protocol's guide shows it", () => {
    const spec = `Audit the staking vault. Inputs: repoUrl=https://github.com/owner/repo; baseCommit=${commit}`;
    const built = buildJobInput(audit, header + spec, spec);
    expect(built).toEqual({
      ok: true,
      input: {
        objective: header + spec,
        template: "audit",
        repoUrl: "https://github.com/owner/repo",
        baseCommit: commit,
      },
    });
    expect(buildJobInput(audit, `${header}Audit something.`, "Audit something.")).toEqual({
      ok: false,
      reason: "the spec names no repoUrl",
    });
  });

  it("refuses audit inputs a job body would not take, and inputs the template has no field for", () => {
    const body = (clause: string) => {
      const spec = `Audit. Inputs: ${clause}`;
      return buildJobInput(audit, header + spec, spec);
    };
    const good = `repoUrl=https://github.com/o/r; baseCommit=${commit}`;
    expect(body(good).ok).toBe(true);
    expect(body(`repoUrl=https://github.com/o/r; baseCommit=HEAD`).ok).toBe(false);
    expect(body(`repoUrl=http://github.com/o/r; baseCommit=${commit}`).ok).toBe(false);
    expect(body(`repoUrl=https://github.com/o/r?token=1; baseCommit=${commit}`).ok).toBe(false);
    expect(body(`repoUrl=https://user:pw@github.com/o/r; baseCommit=${commit}`).ok).toBe(false);
    expect(body(`repoUrl=https://evil.example/o/r; baseCommit=${commit}`).ok).toBe(false);
    expect(body(`repoUrl=https://github.com/o/r; baseCommit=${commit.toUpperCase()}`).ok).toBe(false);
    // Two runners must build the same job: a key the template cannot place is not skipped over.
    expect(body(`${good}; contracts=src/Vault.sol`)).toEqual({
      ok: false,
      reason: 'the audit template takes no input named "contracts"',
    });
  });

  it("marks the kinds whose records outgrow one transaction", () => {
    expect(audit.largeRecords).toBe(true);
    expect(report.largeRecords).toBe(false);
  });

  it("builds a one-skill body, and sends prose that mentions inputs as plain text", () => {
    const spec = "Build a page for a bakery. Inputs: name=Crumb & Co; city=Lagos";
    const built = buildJobInput(report, header + spec, spec);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.input).toEqual({
      objective: header + spec,
      skill: "research-report",
      outputs: [{ name: "report", path: "artifacts/report.md", mediaType: "text/markdown" }],
      github: false,
    });
    expect("onchain" in built.input).toBe(false);
    // The template's own object is never handed out for a caller to change.
    (built.input.outputs as unknown[]).push("x");
    expect((report.input.outputs as unknown[]).length).toBe(1);
  });

  it("refuses an objective over the template's limit", () => {
    const long = "a".repeat(8001);
    expect(buildJobInput(report, long, "spec").ok).toBe(false);
  });
});
