/**
 * What the site says has been proven on the live system, held against where it is written down.
 *
 * `src/config/proofs.ts` copies records from the launch documents; `src/data/index.ts` names the
 * job that carried our order header; `src/models/judges.ts` describes launch B from its README.
 * When the launch projects are in the repository beside this app, each copy is compared with its
 * source here. What can be recomputed is recomputed, with the shared package, from this app's own
 * fixtures: a feed body's hash, a question hash, a record's hash, the header inside a record.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeAbiParameters, keccak256, stringToHex } from "viem";
import { describe, expect, it } from "vitest";
import {
  feedBody,
  feedQuestionHash,
  HOUSE_FEED_NAMES,
  HOUSE_FEEDS,
  orderHeadHash,
  orderHeader,
  parseObjective,
  QUESTIONS_WAITS,
  scanWorkRecord,
  silenceSeconds,
  WORK_RECORD_COMPLETED_HASH,
} from "@help-wanted/shared";
import { IMD_LINK, REFERENCE_JOB } from "~/config/chain";
import {
  AUDITED_COMMIT,
  AUDITS,
  CHANGED_AFTER_AUDITS,
  DESK_ADAPTATION,
  EMPLOYERS_FIRST_ATTEMPT,
  FEED_PROOFS,
  LAUNCH_ADAPTATION,
  PUBLIC_SOURCE,
  sourceWords,
} from "~/config/proofs";
import { HEADER_JOB, headerJobPin, LAUNCH_A_JOB, LAUNCH_B_JOB, referencePin } from "~/data";
import { addressList } from "~/data/house";
import { DESK_FROM_ITS_DOCUMENTS, SUITES } from "~/models/judges";
import { OPEN_POT_EXAMPLE, OPEN_POT_EXAMPLE_NOTE } from "~/models/money";
import { BANNED, fixtureJson, HEADER_RECORD, RECORD } from "./helpers";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFileSync(`${ROOT}${path}`, "utf8");
const oneLine = (text: string) => text.replace(/`/g, "").replace(/\*\*/g, "").replace(/\s+/g, " ");

describe("the three house feed questions, answered by the live oracle", () => {
  it("each record's two hashes are the ones this feed's own text gives", () => {
    for (const name of HOUSE_FEED_NAMES) {
      const proof = FEED_PROOFS[name];
      const feed = HOUSE_FEEDS[name];
      const window = { fromBlock: proof.fromBlock, toBlock: proof.toBlock };
      expect(proof.feed).toBe(name);
      // The body the contract assembles for that window is the body that was bought.
      expect(keccak256(stringToHex(feedBody(feed, window))), name).toBe(proof.bodyHash);
      // And the question hash the contract builds from it is the one the oracle attested.
      expect(feedQuestionHash(feed, window), name).toBe(proof.questionHash);
      expect(proof.agreed).toBeGreaterThanOrEqual(feed.params.quorum);
      expect(proof.agreed).toBeLessThanOrEqual(feed.params.panelSize);
      expect(proof.oracleRequestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(IMD_LINK.oracleRequest(proof.oracleRequestId)).toBe(
        `https://api.imd.fun/oracle/requests/${proof.oracleRequestId}`,
      );
    }
  });

  it("each answer decodes under its feed's answer type", () => {
    const [payrolls] = decodeAbiParameters([{ type: "uint256" }], FEED_PROOFS.payrolls.answer);
    expect(payrolls).toBe(114n * 10n ** 18n);
    const [hires] = decodeAbiParameters([{ type: "uint256" }], FEED_PROOFS.hires.answer);
    expect(hires).toBe(228n);
    expect(addressList(FEED_PROOFS.employers.answer)).toEqual([
      "0x21919137e69ed667ac404c7fcb71b8179b645f46",
      "0x9fadab91f6fa03dbd7f4f8a08a338704baacf63f",
      "0x7b8c742f2e1eeb3fb2c10d72967fa6d4a22f0479",
    ]);
  });

  it("the three requests are the ones the task names, viewable at IdentityMD", () => {
    expect(HOUSE_FEED_NAMES.map((name) => FEED_PROOFS[name].oracleRequestId)).toEqual([
      "3744d864-8cbf-4fcf-8a8c-3529fb1736cb",
      "df50bf76-41a0-4596-ae9e-9dcfd0e1ccd5",
      "2cbe6bb3-13f9-4617-98b9-5d83754f9e1a",
    ]);
    // Attested on 12 and 13 October 2026.
    expect(HOUSE_FEED_NAMES.map((name) => FEED_PROOFS[name].attestedAt.slice(0, 10))).toEqual([
      "2026-10-12",
      "2026-10-12",
      "2026-10-13",
    ]);
  });

  const launchDoc = "launches/a-payroll/docs/LAUNCH.md";
  it.skipIf(!existsSync(`${ROOT}${launchDoc}`))("are the records launch A's launch document states", () => {
    const text = read(launchDoc);
    const block = text.match(/<!-- proofs -->\s*```json\s*([\s\S]*?)```/);
    expect(block, "the proofs block of LAUNCH.md").not.toBeNull();
    const stated = JSON.parse(block![1]!) as Record<string, unknown>[];
    expect(stated.map((entry) => entry.feed)).toEqual([...HOUSE_FEED_NAMES]);
    for (const entry of stated) {
      const name = entry.feed as (typeof HOUSE_FEED_NAMES)[number];
      const ours = FEED_PROOFS[name];
      expect(entry.feedId).toBe(HOUSE_FEEDS[name].id);
      expect(entry.status).toBe("attested");
      for (const key of [
        "transaction",
        "block",
        "oracleRequestId",
        "fromBlock",
        "toBlock",
        "questionHash",
        "bodyHash",
        "answer",
        "agreed",
        "attestedAt",
      ] as const) {
        expect(ours[key], `${name}.${key}`).toBe(entry[key]);
      }
    }
    // The first body of the employers feed, which was not attested, is in the same document.
    expect(text).toContain(EMPLOYERS_FIRST_ATTEMPT.oracleRequestId);
    expect(text).toContain(EMPLOYERS_FIRST_ATTEMPT.transaction);
    expect(oneLine(text)).toContain("Not attested: status mismatch");
  });
});

describe("IdentityMD's two audits of launch A", () => {
  it("are the two jobs the task names, each with its report's address", () => {
    expect(AUDITS.map((audit) => audit.jobId)).toEqual([
      "be91e8ae-9f45-495f-a318-60fab672a92e",
      "22624be0-d2da-400e-91c4-51dac0a9a7f5",
    ]);
    expect(IMD_LINK.jobReport(AUDITS[0]!.jobId)).toBe(
      "https://api.imd.fun/jobs/be91e8ae-9f45-495f-a318-60fab672a92e/report.md",
    );
    const ids = AUDITS.flatMap((audit) => audit.findings.map((finding) => finding.id));
    expect(ids).toEqual(["1.1", "1.2", "1.3", "1.4", "2.1", "2.2", "2.3", "2.4", "2.5"]);
    // No finding is given without what was done about it, and none left open is called fixed.
    for (const finding of AUDITS.flatMap((audit) => audit.findings)) {
      expect(finding.done.length, finding.id).toBeGreaterThan(20);
      expect(["fixed", "documents corrected", "left open", "left"]).toContain(finding.outcome);
    }
    expect(CHANGED_AFTER_AUDITS).toContain("have not been audited again");
  });

  const auditsDoc = "launches/a-payroll/docs/AUDITS.md";
  it.skipIf(!existsSync(`${ROOT}${auditsDoc}`))(
    "state each finding and its outcome as AUDITS.md does",
    () => {
      const text = read(auditsDoc);
      expect(text).toContain(AUDITED_COMMIT);
      for (const audit of AUDITS) expect(text).toContain(audit.jobId);
      const rows = new Map<string, { severity: string; finding: string; outcome: string }>();
      for (const line of text.split("\n")) {
        const cells = line.split("|").map((cell) => cell.trim());
        if (!/^\d\.\d$/.test(cells[1] ?? "")) continue;
        rows.set(cells[1]!, {
          severity: (cells[2] ?? "").toLowerCase(),
          finding: oneLine(cells[3] ?? ""),
          outcome: oneLine(cells[4] ?? ""),
        });
      }
      expect([...rows.keys()]).toEqual(AUDITS.flatMap((audit) => audit.findings.map((f) => f.id)));
      for (const finding of AUDITS.flatMap((audit) => audit.findings)) {
        const row = rows.get(finding.id)!;
        expect(finding.severity, finding.id).toBe(row.severity);
        // The finding is the auditors' sentence, with the document's cross-reference ("THREATS P3")
        // said in words a reader of this site has ("the threats document").
        const ours = finding.finding.replace(/\.$/, "").replace(/the threats document/g, "THREATS P3");
        expect(row.finding, finding.id).toBe(ours);
        // The outcome follows the document's own word for it.
        const said = row.outcome.toLowerCase();
        if (finding.outcome === "fixed") expect(said, finding.id).toMatch(/^fixed/);
        if (finding.outcome === "left open") expect(said, finding.id).toMatch(/^acknowledged and left/);
        if (finding.outcome === "left") expect(said, finding.id).toMatch(/^left;/);
        if (finding.outcome === "documents corrected") {
          expect(said, finding.id).toMatch(/corrected|the same as 1\.3/);
        }
      }
      // What changed after the audits is in the same document, under its own heading.
      expect(text).toContain("## Changed after the audits, and not because of a finding");
    },
  );
});

describe("what IdentityMD's launch pipeline changed in launch A before it launched it", () => {
  it("names the four findings of the pipeline's own audit, three changed and one kept", () => {
    expect(LAUNCH_ADAPTATION.findings.map((f) => [f.title, f.outcome])).toEqual([
      ["keeper tip", "changed"],
      ["premature closure", "changed"],
      ["fixed signer", "kept"],
      ["escrow claims", "changed"],
    ]);
    for (const finding of LAUNCH_ADAPTATION.findings) {
      expect(finding.id).toMatch(/^[0-9a-f]{64}$/);
      expect(finding.done.length, finding.title).toBeGreaterThan(60);
    }
    // What the launched contracts do, said once here and nowhere contradicted.
    const said = LAUNCH_ADAPTATION.findings.map((f) => f.done).join(" ");
    expect(said).toContain("settle the reserved tip to the keeper that opened the round");
    expect(said).toContain("36 hours, 5 minutes and 1 second");
    expect(said).toContain("ContractOwnerMustClaim");
    expect(CHANGED_AFTER_AUDITS).toContain("IdentityMD's launch pipeline then read the code itself");
  });

  const adaptation = "launches/a-payroll/ADAPTATION.md";
  it.skipIf(!existsSync(`${ROOT}${adaptation}`))("is what ADAPTATION.md records, finding by finding", () => {
    expect(LAUNCH_ADAPTATION.document).toBe(adaptation);
    const text = read(adaptation);
    // Each finding is a heading of the document: its id in full, then the document's name for it.
    const headings = [...text.matchAll(/^### `([0-9a-f]{64})` — (.+)$/gm)].map((m) => [m[1], m[2]]);
    expect(headings).toEqual(LAUNCH_ADAPTATION.findings.map((f) => [f.id, f.title]));
    const flat = oneLine(text);
    for (const phrase of [
      "both callback and submission now settle the reserved tip to the recorded opener",
      "requestedAt + ABANDON_AFTER_SILENCE + feed.validFor + ISSUED_AT_TOLERANCE + 1",
      "For all three house feeds the deadline is 36 hours, 5 minutes, 1 second after the request.",
      "Single claims revert ContractOwnerMustClaim; batch claims skip that seat and pay the others.",
      "Reproduced as the explicitly requested immutable dependency, and retained.",
    ]) {
      expect(flat, phrase).toContain(phrase);
    }
  });

  const questionsSol = "launches/a-payroll/src/questions/Questions.sol";
  it.skipIf(!existsSync(`${ROOT}${questionsSol}`))(
    "the waits this site prints are the constants of the launched Questions",
    () => {
      const source = read(questionsSol);
      const constant = (name: string) => {
        const match = new RegExp(`uint256 public constant ${name} = (\\d+) (minutes|hours);`).exec(source);
        expect(match, name).not.toBeNull();
        return Number(match![1]) * (match![2] === "hours" ? 3600 : 60);
      };
      expect(QUESTIONS_WAITS.SUBMIT_AFTER_SILENCE).toBe(constant("SUBMIT_AFTER_SILENCE"));
      expect(QUESTIONS_WAITS.ABANDON_AFTER_SILENCE).toBe(constant("ABANDON_AFTER_SILENCE"));
      expect(QUESTIONS_WAITS.ABANDON_AFTER_COMPLETED).toBe(constant("ABANDON_AFTER_COMPLETED"));
      expect([
        QUESTIONS_WAITS.ABANDON_AFTER_COMPLETED,
        QUESTIONS_WAITS.ABANDON_AFTER_SILENCE,
        QUESTIONS_WAITS.SUBMIT_AFTER_SILENCE,
      ]).toEqual([30 * 60, 12 * 3600, 30 * 60]);
      // One call closes a silent round at requestedAt + silence + validFor + tolerance + 1.
      expect(source).toContain(
        "closableAt = uint256(r.requestedAt) + ABANDON_AFTER_SILENCE + validFor + ISSUED_AT_TOLERANCE + 1;",
      );
      for (const name of HOUSE_FEED_NAMES) {
        expect(silenceSeconds(HOUSE_FEEDS[name].params.validFor), name).toBe(129_901n);
      }
      // The tip of an answered round goes to the keeper recorded when the round was opened.
      expect(source).toContain("_tips[h.keeper] += h.tip;");
      expect(source).not.toMatch(/_tips\[earner\]|_tips\[msg\.sender\] \+= h\.tip/);
    },
  );

  const payrollSol = "launches/a-payroll/src/payroll/Payroll.sol";
  it.skipIf(!existsSync(`${ROOT}${payrollSol}`))(
    "a contract that holds a seat claims for itself, as the launched Payroll has it",
    () => {
      const source = read(payrollSol);
      expect(source).toContain(
        "return msg.sender == owner || owner == address(this) || owner.code.length == 0;",
      );
      expect(source).toContain("if (!_claimAllowed(owner)) revert ContractOwnerMustClaim(owner);");
    },
  );
});

describe("what IdentityMD's launch pipeline found in launch B before it launched it", () => {
  const severities = DESK_ADAPTATION.findings.map((f) => f.severity);

  it("is one medium finding and six at level info, and no finding changed contract code", () => {
    expect(DESK_ADAPTATION.launchNumber).toBe(1573);
    expect(severities.filter((s) => s === "medium")).toHaveLength(1);
    expect(severities.filter((s) => s === "info")).toHaveLength(6);
    // No outcome of this launch is a change to a contract: words were corrected, or nothing was.
    for (const finding of DESK_ADAPTATION.findings) {
      expect(finding.id).toMatch(/^[0-9a-f]{8}$/);
      expect(["words corrected", "left"]).toContain(finding.outcome);
      expect(finding.done.length, finding.id).toBeGreaterThan(60);
    }
    const medium = DESK_ADAPTATION.findings.find((f) => f.severity === "medium")!;
    expect(medium.raisedBy).toBe("the independent review");
    expect(medium.outcome).toBe("words corrected");
    expect(medium.done).toContain("the words were corrected, not the desk");
    // It is not called fixed, and the limit is said to stand.
    expect(medium.done).not.toMatch(/\bfixed\b/i);
    expect(medium.done).toContain("The limit stands");
    expect(DESK_ADAPTATION.corrected).toContain("The compiled bytecode of all four contracts is the same");
  });

  it("uses none of the words this site does not use", () => {
    for (const finding of DESK_ADAPTATION.findings) {
      expect(`${finding.finding} ${finding.done}`, finding.id).not.toMatch(BANNED);
    }
    expect(DESK_ADAPTATION.corrected).not.toMatch(BANNED);
  });

  const adaptation = "launches/b-desk/ADAPTATION.md";
  it.skipIf(!existsSync(`${ROOT}${adaptation}`))("is what ADAPTATION.md records, finding by finding", () => {
    expect(DESK_ADAPTATION.document).toBe(adaptation);
    const text = read(adaptation);
    // Each finding is a heading of the document: its id, its level where the document gives one,
    // then the document's own words for it.
    const headings = [...text.matchAll(/^### `?([0-9a-f]{8})`?(?: \((medium|info)\))?:? (.+)$/gm)].map(
      (m) => ({
        id: m[1],
        level: m[2] ?? null,
        words: oneLine(m[3]!).replace(/^\(|\)$/g, ""),
      }),
    );
    expect(headings.map((h) => h.id)).toEqual(DESK_ADAPTATION.findings.map((f) => f.id));
    for (const finding of DESK_ADAPTATION.findings) {
      const heading = headings.find((h) => h.id === finding.id)!;
      expect(heading.words, finding.id).toBe(finding.finding);
      // The reviewer's three carry their level in the heading; the imported audit's four are
      // stated by the document to be all at level info.
      if (heading.level) expect(finding.severity, finding.id).toBe(heading.level);
      else expect(finding.severity, finding.id).toBe("info");
      expect(finding.raisedBy, finding.id).toBe(
        heading.level ? "the independent review" : "the audit the pipeline imported",
      );
    }
    const flat = oneLine(text);
    for (const phrase of [
      "no contract code, test configuration or build configuration was changed",
      "The audit reported four entries, all at level info",
      "An independent reviewer reopened the accepted work with one medium finding and two advisory notes",
      "What was done: the words were corrected, not the desk.",
      "with the compiled bytecode of all four contracts unchanged",
      "taking its bond for the swarm's failure would make honest runners avoid the desk",
    ]) {
      expect(flat, phrase).toContain(phrase);
    }
    // Every "left" finding is one the document says was not changed; the medium one is the only
    // finding the document answers with corrections.
    for (const id of ["46190b9b", "be85d51c", "157f2546", "bff72b72", "2094daa9"]) {
      const from = text.indexOf(`### ${id}`);
      expect(from, id).toBeGreaterThan(0);
      const next = text.indexOf("\n### ", from + 5);
      expect(text.slice(from, next === -1 ? undefined : next), id).toMatch(/\*\*Not changed\.\*\*/);
    }
  });

  const threats = "launches/b-desk/docs/THREATS.md";
  it.skipIf(!existsSync(`${ROOT}${threats}`))(
    "the limit the medium finding describes is disclosed where the site says it is",
    () => {
      const flat = oneLine(read(threats));
      expect(flat).toContain(
        "A receipt-only pot can also be ended in a refund with no bond forfeited at all, whatever bond the opener chose.",
      );
      expect(flat).toContain("No IMD is lost.");
      expect(flat).toContain("Audited by IdentityMD's launch pipeline before it was deployed");
    },
  );
});

describe("the first pot and the Doorbell, as launch B's launch document gives them", () => {
  const launchDoc = "launches/b-desk/docs/LAUNCH.md";
  const present = existsSync(`${ROOT}${launchDoc}`);
  const block = (text: string, name: string) => {
    const match = new RegExp("<!-- " + name + " -->\\s*```(?:json|text)\\s*([\\s\\S]*?)```").exec(text);
    expect(match, name).not.toBeNull();
    return match![1]!.trim();
  };

  it.skipIf(!present)("the pot the pots page proposes is the document's first pot, value for value", () => {
    const text = read(launchDoc);
    const terms = JSON.parse(block(text, "firstPot:terms")) as Record<string, string | number | boolean>;
    const imdOf = (amount: string) => (BigInt(Math.round(Number(amount) * 1000)) * 10n ** 15n).toString();
    expect(terms.kind).toBe("skill:research-report");
    expect(OPEN_POT_EXAMPLE.template).toBe("research");
    expect(imdOf(OPEN_POT_EXAMPLE.target)).toBe(terms.target);
    expect(imdOf(OPEN_POT_EXAMPLE.minPay)).toBe(terms.minPay);
    expect(imdOf(OPEN_POT_EXAMPLE.bond)).toBe(terms.bond);
    expect(Number(OPEN_POT_EXAMPLE.rampHours) * 3600).toBe(terms.rampSecs);
    expect(Number(OPEN_POT_EXAMPLE.deliveryDays) * 86_400).toBe(terms.deliverySecs);
    expect(Number(OPEN_POT_EXAMPLE.hireDays) * 86_400).toBe(terms.hireSecs);
    expect(Number(OPEN_POT_EXAMPLE.fundDays) * 86_400).toBe(terms.fundSecs);
    expect(OPEN_POT_EXAMPLE.allowClaimed).toBe(String(terms.allowClaimed));
    expect(OPEN_POT_EXAMPLE.spec).toBe(block(text, "firstPot:spec"));
    // A 2 IMD target that starts at 1 IMD and allows claims, and the page says so in words.
    expect([OPEN_POT_EXAMPLE.target, OPEN_POT_EXAMPLE.minPay, OPEN_POT_EXAMPLE.allowClaimed]).toEqual([
      "2",
      "1",
      "true",
    ]);
    expect(OPEN_POT_EXAMPLE_NOTE).toContain("a target of 2 IMD, an order priced from 1 IMD");
    expect(OPEN_POT_EXAMPLE_NOTE).toContain("It allows a bonded delivery claim");
    expect(oneLine(text)).toContain("While receipts are stalled the first pot allows the claimed path.");
  });

  it.skipIf(!present)("the Doorbell was launched with one price of 1 IMD and the claimed path on", () => {
    const text = read(launchDoc);
    expect(block(text, "doorbell:minPay")).toBe("1000000000000000000");
    expect(block(text, "doorbell:maxPay")).toBe("1000000000000000000");
    expect(block(text, "doorbell:bond")).toBe("250000000000000000");
    expect(block(text, "doorbell:deliverySecs")).toBe("604800");
    expect(block(text, "doorbell:allowClaimed")).toBe("1");
    expect(oneLine(text)).toContain("One price: every order pays 1 IMD.");
    // The site holds none of these as its own figures: the page prints what the contract answers.
    const page = readFileSync(`${ROOT}apps/web/src/models/money.ts`, "utf8");
    expect(page).toContain("MIN_PAY() and MAX_PAY(), read from the contract");
    expect(page).not.toContain("pays 1 IMD");
  });
});

describe("where each launch's source is public", () => {
  it("says so launch by launch, from the site's own record, with the day it was checked", () => {
    for (const key of ["A", "B", "C"] as const) {
      const source = PUBLIC_SOURCE[key];
      if (source) {
        expect(source.repository).toMatch(/^https:\/\/github\.com\/[\w-]+\/[\w-]+$/);
        expect(source.branch).toMatch(/^[\w-]+$/);
        expect(sourceWords(key)).toBe(
          `Its source is public: branch ${source.branch} of ${source.repository} (checked ${source.checked}).`,
        );
      } else {
        expect(sourceWords(key)).toBe("Its source is not public yet.");
      }
    }
  });
});

describe("the job that carried our order header", () => {
  it("its record hashes to the hash the API lists, and its objective begins with our 85 bytes", () => {
    expect(HEADER_RECORD).toHaveLength(HEADER_JOB.recordBytes);
    expect(keccak256(HEADER_RECORD)).toBe(HEADER_JOB.recordHash);
    // The copy that ships with the site is the same bytes.
    expect(headerJobPin().bytes).toEqual(HEADER_RECORD);
    const scan = scanWorkRecord(HEADER_RECORD);
    expect(scan.jobId).toBe(HEADER_JOB.jobId);
    expect(scan.jobIdBytes16).toBe(HEADER_JOB.jobIdBytes16);
    expect(scan.kind).toBe("skill:research-report");
    expect(scan.stateHash).toBe(WORK_RECORD_COMPLETED_HASH);
    // What the contract would compare: the hash of the first 85 raw bytes of the objective.
    expect(scan.headHash).toBe(orderHeadHash(HEADER_JOB.ticket));
    expect(scan.objective.slice(0, 85)).toBe(orderHeader(HEADER_JOB.ticket));
    expect(parseObjective(scan.objective)?.ticket).toBe(HEADER_JOB.ticket);
  });

  it("IdentityMD's API listed the record as queued, with no transaction: not a receipt on chain", () => {
    const list = fixtureJson<{ records: { hash: string; status: string; txHash: string | null }[] }>(
      "job-records-e70c56ce.json",
    );
    expect(list.records).toHaveLength(1);
    expect(list.records[0]).toMatchObject({
      hash: HEADER_JOB.recordHash.slice(2),
      status: "queued",
      txHash: null,
    });
    const job = fixtureJson<{
      id: string;
      state: string;
      template: string;
      paidBy: string;
      objective: string;
    }>("job-e70c56ce.json");
    expect(job).toMatchObject({
      id: HEADER_JOB.jobId,
      state: "completed",
      template: "skill:research-report",
    });
    expect(job.objective.startsWith(orderHeader(HEADER_JOB.ticket))).toBe(true);
  });

  it("the reference job, by contrast, has its receipt: the record hashes to it", () => {
    expect(keccak256(RECORD)).toBe(REFERENCE_JOB.receipt);
    expect(referencePin().bytes).toEqual(RECORD);
  });

  it("launch A's job in the pipeline is the one the task names", () => {
    expect(LAUNCH_A_JOB.jobId).toBe("d8bb3d81-820d-42f4-ad7c-1d3ed96b1da8");
    const job = fixtureJson<{ id: string; launch: { requested: boolean; kind: string } }>(
      "job-d8bb3d81.json",
    );
    expect(job.id).toBe(LAUNCH_A_JOB.jobId);
    expect(job.launch).toMatchObject({ requested: true, kind: "evm_contracts" });
  });

  it("launch B's job in the pipeline is the one that became launch 1573", () => {
    expect(LAUNCH_B_JOB.jobId).toBe("eb0f6c65-174a-45e8-9fe5-9312c66d4880");
    // Recorded from IdentityMD's public API on 13 October 2026, after the launch.
    const job = fixtureJson<{
      id: string;
      state: string;
      paidBy: string;
      objective: string;
      launch: { requested: boolean; kind: string; status: string };
      nodes: { key: string; state: string }[];
    }>("job-eb0f6c65.json");
    expect(job.id).toBe(LAUNCH_B_JOB.jobId);
    expect(job.state).toBe("completed");
    expect(job.launch).toMatchObject({ requested: true, kind: "evm_contracts", status: "live" });
    expect(job.objective).toContain("WorkProof, WorkOrders, CrowdPots, Doorbell");
    // Its audit steps are the pipeline's, each accepted: the audit of the imported code, the four
    // specialists and the judge.
    const accepted = job.nodes.filter((node) => node.state === "accepted").map((node) => node.key);
    for (const key of [
      "audit_imported_code",
      "adapt_contract_project",
      "audit_math",
      "audit_permissions",
      "audit_economics",
      "audit_flow",
      "audit_judge",
    ]) {
      expect(accepted, key).toContain(key);
    }
  });
});

describe("what the judges page says of the launch projects is what their READMEs say", () => {
  const readmes = {
    A: "launches/a-payroll/README.md",
    B: "launches/b-desk/README.md",
    C: "launches/c-company/README.md",
  } as const;

  it.skipIf(!existsSync(`${ROOT}${readmes.B}`))("launch B is described in its README's own words", () => {
    const text = oneLine(read(readmes.B));
    for (const phrase of [
      "is a job board on which the employer can be a contract: an employer escrows IMD against a pinned job text, a bonded runner opens the job with IdentityMD's swarm, and the escrow pays when the job's work record is proven on chain against IdentityMD's WorkRegistry",
      "keccak256 of a job's work record, as served, equals WorkRegistry.latest(jobId) on Ethereum mainnet",
      "lets many wallets commission one job together",
      "is a contract anyone can ring until it hires",
      "A runner must put 85 bytes at the start of the job's objective",
      "It pays its fees into Payroll (the first launch) and needs nothing else from the other two.",
    ]) {
      expect(text, phrase).toContain(phrase);
    }
    // Every sentence of the status list is the README's, word for word: the page adds none.
    for (const line of DESK_FROM_ITS_DOCUMENTS.status) {
      for (const sentence of line.split(/(?<=\.)\s+(?=[A-Z])/)) {
        expect(text, sentence).toContain(sentence.replace(/\.$/, ""));
      }
    }
    const status = DESK_FROM_ITS_DOCUMENTS.status.join(" ");
    expect(status).toContain("Live on Ethereum mainnet since 13 October 2026.");
    expect(status).toContain("The desk's first order was settled by a real job, on proof.");
    expect(status).toContain("IdentityMD's receipts stalled from about 8 to 14 October 2026.");
    expect(status).toContain("Audited by IdentityMD's launch pipeline, and by nobody else.");
    // The medium finding is named in the README's own words, with where it is disclosed.
    expect(status).toContain(
      "the medium one (a receipt-only pot can be ended in a refund with no bond forfeited) is now stated as a limit in docs/THREATS.md, C2.",
    );
    // What the README no longer says is not on the page either.
    expect(status).not.toMatch(/Not deployed|Not audited by a third party/);
    expect(text).not.toContain("Not deployed");
    // And the page's own sentences carry those words, with no address anywhere in them.
    const ours = [
      DESK_FROM_ITS_DOCUMENTS.what,
      ...DESK_FROM_ITS_DOCUMENTS.points,
      ...DESK_FROM_ITS_DOCUMENTS.status,
    ].join(" ");
    expect(ours).toContain("a job board on which the employer can be a contract");
    expect(ours).toContain("keccak256 of a job's work record, as served, equals WorkRegistry.latest(jobId)");
    expect(ours).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });

  it.each(["A", "B", "C"] as const)("launch %s's test counts are the ones its README gives", (launch) => {
    const path = `${ROOT}${readmes[launch]}`;
    if (!existsSync(path)) return;
    const text = oneLine(readFileSync(path, "utf8"));
    const suite = SUITES[launch];
    expect(suite.project).toBe(readmes[launch].replace("/README.md", ""));
    expect(text).toContain(
      `forge test runs ${suite.tests} tests in ${suite.suites} suites and needs no network`,
    );
    expect(text).toContain(`runs the ${suite.forkTests} fork tests against Ethereum mainnet`);
    expect(text).toContain("FOUNDRY_PROFILE=fork forge test");
  });
});
