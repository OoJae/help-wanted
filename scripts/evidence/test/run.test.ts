import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main, settingsFrom } from "../build.js";
import { EVIDENCE_SCHEMA, type EvidenceDocument } from "../document.js";
import { imdReads } from "../imd.js";
import { render } from "../render.js";
import { Rpc } from "../rpc.js";
import { buildEvidence, ChecksFailedError } from "../run.js";
import {
  DEPLOYMENT_BOOK,
  questionsAbi,
  unlaunchedBook,
  viewCallData,
  type DeploymentBook,
} from "../shared.js";
import { replayGet, replayPost, type Tape } from "../tape.js";
import {
  EM_DASH,
  H1,
  HOUSE_FILE,
  privateText,
  REFUSED,
  tape,
  W1,
} from "./helpers.js";

/**
 * The deployments book as it stood when the tape was recorded: launch A live, B and C not. The
 * tests never assume what the real book holds today.
 */
const BOOK: DeploymentBook = { ...unlaunchedBook(), a: DEPLOYMENT_BOOK.a };
const REQUESTS = {
  requests: [{ launch: "b", jobId: "eb0f6c65-174a-45e8-9fe5-9312c66d4880" }],
};
const NOW = new Date("2026-10-13T14:38:00.000Z");
const noSleep = async () => {};

interface Seen {
  rpc: string[];
  api: string[];
}

async function run(
  recorded: Tape,
  options: {
    book?: DeploymentBook;
    api?: boolean;
    block?: number | null;
    seen?: Seen;
  } = {},
): Promise<EvidenceDocument> {
  const seen = options.seen ?? { rpc: [], api: [] };
  return buildEvidence(
    {
      book: options.book ?? BOOK,
      houseFile: HOUSE_FILE,
      launchRequests: REQUESTS,
    },
    { chunkSize: 2000, block: options.block ?? null },
    {
      rpc: new Rpc(["https://tape.example"], {
        post: replayPost(recorded, seen.rpc),
        sleep: noSleep,
      }),
      imd:
        options.api === false
          ? null
          : imdReads({
              get: replayGet(recorded, seen.api),
              gapMs: 0,
              sleep: noSleep,
            }),
      now: () => NOW,
      say: () => {},
    },
  );
}

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "hw-evidence-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("a real run, replayed from its recording (13 October 2026, block 26,184,132)", () => {
  it("pins the node's finalized block and says which", async () => {
    const doc = await run(tape());
    expect(doc.schema).toBe(EVIDENCE_SCHEMA);
    expect(doc.chainId).toBe(1);
    expect(doc.pinnedBlock).toEqual({
      number: 26_184_132,
      hash: "0xeb5233f9cad9efe4411619588f6fb1c720cd27eaf32363cdbd7d10947a1a7c33",
      timestamp: 1_791_901_271,
      time: "2026-10-13T14:21:11Z",
      finality: "finalized",
    });
  });

  it("finds launch A live, with code at each address, and launches B and C not launched", async () => {
    const doc = await run(tape());
    expect(doc.headline).toEqual({
      contractsInTheBook: 10,
      contractsLaunched: 3,
      contractsWithCode: 3,
      transactions: { total: 12, house: 12, outside: 0, byIdentityMd: 0 },
    });
    const a = doc.launches.a;
    expect(a).toMatchObject({
      launched: true,
      launchNumber: 1531,
      project: "launches/a-payroll",
    });
    expect(a.transaction).toEqual({
      hash: "0x9ce6111c9f454373ac208cc9b54ebd0a4b09e58706f20e568f0f9e8bbb392c58",
      block: 26_182_869,
      time: "2026-10-13T10:07:59Z",
      from: "0xcECc29B037f5064fCdF45a5C318F132ef76aA551",
      to: "0xfF03410d0Fe5fa8f7F59F743de35E333D9857120",
      succeeded: true,
      factoryLaunchNumber: 1531,
    });
    expect(
      a.contracts.map((c) => [
        c.name,
        c.address,
        c.code?.bytes,
        c.code?.nonEmpty,
        c.namedInLaunchTransaction,
      ]),
    ).toEqual([
      [
        "Questions",
        "0xEECE4628ceb091C13393fc64056Be8b8501fD3F6",
        22_233,
        true,
        true,
      ],
      [
        "JobsReport",
        "0x58963B57E179f7fE4E95090C21E8e9D75353BCE4",
        9_320,
        true,
        true,
      ],
      [
        "Payroll",
        "0x6e4362a5cEc59Eb3F611af6b2d81915CF5b45f1F",
        11_846,
        true,
        true,
      ],
    ]);
    // The code hashes `scripts/repro.sh` printed for the same addresses on the same day.
    expect(a.contracts.map((c) => c.code?.keccak256)).toEqual([
      "0xf876f5265e4ae5015645fbbee2c47e280391c23fc8256b46b688688a388618f7",
      "0xb050a81690b40963e1cbdffb17aafb3fcdf42ddd432a05023be7e23873207432",
      "0xa962b0633998d594b2720984ad5f76fce369148592da0762b9d9acf399367236",
    ]);
    expect(a.logs).toEqual({
      fromBlock: 26_182_869,
      toBlock: 26_184_132,
      count: 16,
      transactions: 13,
    });

    for (const launch of [doc.launches.b, doc.launches.c]) {
      expect(launch).toMatchObject({
        launched: false,
        evidence: null,
        transaction: null,
        logs: null,
        launchNumber: null,
      });
      expect(launch.status).toBe(
        "not launched: the deployments book holds no address for it",
      );
      // Not launched is null, never a zero that could be read as a measurement.
      for (const contract of launch.contracts) {
        expect(contract).toMatchObject({
          address: null,
          code: null,
          events: null,
          imdHeldWei: null,
          namedInLaunchTransaction: null,
        });
      }
    }
    expect(doc.launches.b.contracts.map((c) => c.name)).toEqual([
      "WorkProof",
      "WorkOrders",
      "CrowdPots",
      "Doorbell",
    ]);
    expect(doc.launches.c.contracts.map((c) => c.name)).toEqual([
      "Rules",
      "Endowments",
      "Zap",
    ]);
  });

  it("counts the feeds, the three oracle requests and how each ended, all HOUSE", async () => {
    const q = (await run(tape())).launches.a.evidence?.questions;
    expect(q?.feedsCreated).toEqual({ total: 3, house: 3, outside: 0 });
    expect(q?.roundsOpened).toEqual({ total: 3, house: 3, outside: 0 });
    expect(q?.endings).toEqual({
      answeredBySubmit: { total: 2, house: 2, outside: 0 },
      answeredByCallback: { total: 0, house: 0, outside: 0 },
      closedWithoutAnswer: { total: 0, house: 0, outside: 0 },
      pending: { total: 1, house: 1, outside: 0 },
    });
    expect(q?.submits).toEqual({ total: 2, house: 2, outside: 0 });
    expect(
      q?.rounds.map((r) => [
        r.houseFeed,
        r.request.block,
        r.request.tx.slice(0, 10),
        r.ending,
        r.ended?.block ?? null,
      ]),
    ).toEqual([
      ["payrolls", 26_183_619, "0x9fea43c9", "answered by submit", 26_183_772],
      ["hires", 26_183_621, "0x943a2652", "answered by submit", 26_183_780],
      ["employers", 26_183_622, "0x4ef3313d", "pending", null],
    ]);
    for (const round of q?.rounds ?? [])
      expect(round.opener.toLowerCase()).toBe(H1);
    expect(q?.rounds[0]?.answer).toMatchObject({
      value: "112000000000000000000",
      oracleRequestId: "f8ffb991-55b7-4316-9461-44a94d5270aa",
    });
    expect(q?.rounds[1]?.answer).toMatchObject({
      value: "223",
      oracleRequestId: "0a94afe2-c48e-4254-9184-79de6d8f98a1",
    });
    expect(q?.rounds[0]?.ended?.by.toLowerCase()).toBe(H1);
    expect(
      q?.feeds.map((f) => [
        f.houseFeed,
        f.createdBlock,
        f.meterWei,
        f.latest?.value ?? null,
      ]),
    ).toEqual([
      ["payrolls", 26_183_604, "0", "112000000000000000000"],
      ["hires", 26_183_605, "0", "223"],
      ["employers", 26_183_608, "0", null],
    ]);
    expect(q?.meterFunding).toMatchObject({
      total: 3,
      house: 3,
      outside: 0,
      imd: { totalWei: "1650000000000000000" },
    });
    expect(q?.paidToIntake.totalWei).toBe("1500000000000000000");
    expect(q?.keeperTips.earned).toMatchObject({
      total: 2,
      house: 2,
      imd: { totalWei: "100000000000000000" },
    });
  });

  it("reads print no. 1 of the Jobs Report with its numbers and both windows", async () => {
    const j = (await run(tape())).launches.a.evidence?.jobsReport;
    expect(j?.prints).toEqual({ total: 1, house: 1, outside: 0 });
    expect(j?.printRows).toEqual([
      {
        index: 0,
        tx: "0x691890b4affed91496538e012610b632c72a739b5a2ec703b285d51961edb192",
        block: 26_183_781,
        time: "2026-10-13T13:10:35Z",
        printedBy: "0x60CcC928eb8EEE1d64CA0164565BfA9858669560",
        side: "HOUSE",
        amountWei: "112000000000000000000",
        payrollsRound: 1,
        fromBlock: 26_176_608,
        toBlock: 26_183_607,
        totalWei: "112000000000000000000",
        streak: 1,
        bestDay: true,
        count: {
          count: "223",
          hiresRound: 1,
          fromBlock: 26_176_610,
          toBlock: 26_183_609,
        },
      },
    ]);
    expect(j?.summary).toMatchObject({
      prints: 1,
      totalWei: "112000000000000000000",
      counts: 1,
      totalCount: "223",
      crowns: 0,
    });
  });

  it("writes Payroll's ledger as zeros, because that is what was read", async () => {
    const p = (await run(tape())).launches.a.evidence?.payroll;
    expect(new Set(Object.values(p?.ledger ?? {}))).toEqual(new Set(["0"]));
    expect(p?.unbookedWei).toBe("0");
    expect(p?.tips).toEqual({
      total: 0,
      house: 0,
      outside: 0,
      imd: { totalWei: "0", houseWei: "0", outsideWei: "0" },
    });
    expect(p?.paid).toEqual({
      total: 0,
      house: 0,
      outside: 0,
      imd: { totalWei: "0", houseWei: "0", outsideWei: "0" },
    });
  });

  it("holds every count against the contracts and lists what it compared", async () => {
    const doc = await run(tape());
    expect(doc.checks).toHaveLength(32);
    expect(doc.checks.every((check) => check.agree)).toBe(true);
    expect(doc.checks.map((check) => check.what)).toContain(
      "Launch A: the launch number in the ProjectFactory's log",
    );
  });

  it("names the house: the two published wallets and the three launched contracts", async () => {
    const doc = await run(tape());
    expect(
      doc.house.map((entry) => [
        entry.label,
        entry.kind,
        entry.address.toLowerCase(),
      ]),
    ).toEqual([
      ["W1", "wallet", W1],
      ["H1", "wallet", H1],
      ["Questions", "contract", "0xeece4628ceb091c13393fc64056be8b8501fd3f6"],
      ["JobsReport", "contract", "0x58963b57e179f7fe4e95090c21e8e9d75353bce4"],
      ["Payroll", "contract", "0x6e4362a5cec59eb3f611af6b2d81915cf5b45f1f"],
    ]);
  });

  it("keeps what IdentityMD's API said apart, and asks it with GET only", async () => {
    const seen: Seen = { rpc: [], api: [] };
    const doc = await run(tape(), { seen });
    expect(doc.identitymd).toMatchObject({
      read: true,
      base: "https://api.imd.fun",
      fetchedAt: NOW.toISOString(),
    });
    expect(doc.identitymd.launches).toEqual([
      expect.objectContaining({
        launch: "a",
        launchNumber: 1531,
        id: "92bb495f-f565-414a-9b0d-d4bc62e699ac",
        status: "live",
        sourceCommit: "3507c0e002c14ce8cde713bd7c62e6e6e522db4b",
        addressesMatchTheBook: true,
      }),
    ]);
    expect(doc.identitymd.pendingRounds).toEqual([
      {
        feedId:
          "0x22ad8df0e0af07aa59e29aa7f5540e0022fbfda0651ccae3eccb968553a14835",
        houseFeed: "employers",
        round: 1,
        requestTx:
          "0x4ef3313d793940eca2847b7d01969ea76c56f92fab92aa7601e863dd92660204",
        intakeState: "completing",
        oracleRequestId: "4831e033-1ddd-4308-9d26-396a8d340e82",
        oracleStatus: "attested",
        attestedAt: "2026-10-13T12:42:29.256Z",
      },
    ]);
    expect(doc.identitymd.launchRequests).toEqual([
      {
        launch: "b",
        jobId: "eb0f6c65-174a-45e8-9fe5-9312c66d4880",
        state: "executing",
        paidBy: "0x871e507B6a70F858Ad4B414bddb77473630C366b",
        paidBySide: "HOUSE",
        createdAt: "2026-10-13T12:56:18.798Z",
        launchStatus: null,
      },
    ]);
    // Four reads: the launch record, the pending round's Intake entry and oracle request, the job.
    expect(seen.api).toHaveLength(4);
    expect(seen.rpc.length).toBeGreaterThan(40);
    expect(new Set(seen.rpc.map((key) => key.split(" ")[0]))).toEqual(
      new Set([
        "eth_chainId",
        "eth_getBlockByNumber",
        "eth_getTransactionByHash",
        "eth_getTransactionReceipt",
        "eth_getCode",
        "eth_call",
        "eth_getLogs",
      ]),
    );
  });

  it("can leave the API out, and then says so", async () => {
    const seen: Seen = { rpc: [], api: [] };
    const doc = await run(tape(), { api: false, seen });
    expect(seen.api).toEqual([]);
    expect(doc.identitymd).toMatchObject({
      read: false,
      launches: [],
      pendingRounds: [],
      launchRequests: [],
    });
    expect(doc.identitymd.reason).toMatch(/switched off/);
    expect(render(doc)).toContain("Not read in this run");
    // The chain part is the same either way.
    expect(doc.launches.a.evidence).toEqual(
      (await run(tape())).launches.a.evidence,
    );
  });

  it("gives the same document for the same recording", async () => {
    expect(JSON.stringify(await run(tape()))).toBe(
      JSON.stringify(await run(tape())),
    );
  });
});

describe("a run that must not write", () => {
  const without = (recorded: Tape, prefix: string): Tape => {
    const key = Object.keys(recorded.rpc).find((k) => k.startsWith(prefix));
    if (!key) throw new Error(`the tape has no ${prefix}`);
    delete recorded.rpc[key];
    return recorded;
  };
  const set = (recorded: Tape, prefix: string, result: unknown): Tape => {
    const key = Object.keys(recorded.rpc).find((k) => k.startsWith(prefix));
    if (!key) throw new Error(`the tape has no ${prefix}`);
    recorded.rpc[key] = { result };
    return recorded;
  };

  it("fails when a read fails, whichever read it is", async () => {
    for (const prefix of [
      "eth_getLogs",
      "eth_getCode",
      "eth_getTransactionReceipt",
      "eth_call",
      'eth_getBlockByNumber ["finalized"',
      "eth_chainId",
    ]) {
      await expect(run(without(tape(), prefix)), prefix).rejects.toThrow(
        /could not be read/,
      );
    }
    // One of the twelve senders, too: a count without its side is not a count.
    await expect(
      run(without(tape(), 'eth_getTransactionByHash ["0x691890b4')),
    ).rejects.toThrow(/transaction 0x691890b4.* could not be read/);
  });

  it("fails when the API is asked and does not answer", async () => {
    const recorded = tape();
    delete recorded.api["/launches?limit=1&before=1532"];
    await expect(run(recorded)).rejects.toThrow(/failed after 3 tries/);
  });

  it("fails when the logs disagree with a contract's own counter", async () => {
    // feedCount() answers 4 where the logs hold three FeedCreated.
    const feedCount = `eth_call [{"to":"0xeece4628ceb091c13393fc64056be8b8501fd3f6","data":"${viewCallData(questionsAbi, "feedCount")}"}`;
    const recorded = set(tape(), feedCount, `0x${"0".repeat(63)}4`);
    const failure = await run(recorded).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChecksFailedError);
    expect(
      (failure as ChecksFailedError).failed.map((check) => check.what),
    ).toEqual(["Questions: feeds created"]);
    expect((failure as Error).message).toMatch(/nothing is written/);
  });

  it("fails when a node leaves logs out", async () => {
    const recorded = tape();
    const key = Object.keys(recorded.rpc).find((k) =>
      k.startsWith("eth_getLogs"),
    ) as string;
    const logs = (recorded.rpc[key] as { result: unknown[] }).result;
    // Without the last four logs there is no print, and the contract says there is one.
    recorded.rpc[key] = { result: logs.slice(0, logs.length - 4) };
    const failure = await run(recorded).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChecksFailedError);
    expect(
      (failure as ChecksFailedError).failed.map((check) => check.what),
    ).toContain("JobsReport: prints");
  });

  it("fails on a log that is not an event of the contract's ABI", async () => {
    const recorded = tape();
    const key = Object.keys(recorded.rpc).find((k) =>
      k.startsWith("eth_getLogs"),
    ) as string;
    const logs = (recorded.rpc[key] as { result: Record<string, unknown>[] })
      .result;
    logs[1] = { ...logs[1], topics: [`0x${"ab".repeat(32)}`] };
    await expect(run(recorded)).rejects.toThrow(
      /is not an event of its ABI in packages\/shared/,
    );
  });

  it("fails when the book names an address that holds no code", async () => {
    const recorded = set(tape(), 'eth_getCode ["0x58963b57', "0x");
    await expect(run(recorded)).rejects.toThrow(
      /the deployments book says JobsReport is at 0x58963B57.*there is no code at that address/,
    );
  });

  it("fails when the book and the chain disagree about the launch", async () => {
    const otherBlock: DeploymentBook = {
      ...BOOK,
      a: { ...BOOK.a, block: 26_182_870 },
    };
    await expect(run(tape(), { book: otherBlock })).rejects.toThrow(
      /the book says block 26182870, the node says the launch transaction is in block 26182869/,
    );
    const otherNumber: DeploymentBook = {
      ...BOOK,
      a: { ...BOOK.a, launchNumber: 1530 },
    };
    const failure = await run(tape(), { book: otherNumber, api: false }).catch(
      (error: unknown) => error,
    );
    expect(
      (failure as ChecksFailedError).failed.map((check) => check.what),
    ).toEqual(["Launch A: the launch number in the ProjectFactory's log"]);
  });

  it("fails on a book that holds some of a launch's addresses and not others", async () => {
    const half: DeploymentBook = {
      ...BOOK,
      b: {
        ...BOOK.b,
        contracts: {
          ...BOOK.b.contracts,
          workOrders: "0x00000000000000000000000000000000000b0002",
        },
      },
    };
    await expect(run(tape(), { book: half })).rejects.toThrow(
      /launch B: the deployments book holds an address for some of its contracts and not for others/,
    );
    const noTransaction: DeploymentBook = {
      ...BOOK,
      a: { ...BOOK.a, transaction: null },
    };
    await expect(run(tape(), { book: noTransaction })).rejects.toThrow(
      /launch A: the deployments book holds addresses and no launch transaction or block/,
    );
  });

  it("fails when a launch is newer than the pinned block", async () => {
    const future: DeploymentBook = {
      ...BOOK,
      a: { ...BOOK.a, block: 26_184_133 },
    };
    await expect(run(tape(), { book: future })).rejects.toThrow(
      /launch A was mined in block 26184133, after the pinned block 26184132/,
    );
  });

  it("fails on another chain", async () => {
    await expect(run(set(tape(), "eth_chainId", "0xaa36a7"))).rejects.toThrow(
      /the node is on chain 11155111 and the deployments book is for chain 1/,
    );
  });
});

describe("with nothing launched", () => {
  it("writes a document that says so, after reading the chain id and the pinned block only", async () => {
    const seen: Seen = { rpc: [], api: [] };
    const doc = await run(tape(), { book: unlaunchedBook(), seen });
    expect(doc.headline).toEqual({
      contractsInTheBook: 10,
      contractsLaunched: 0,
      contractsWithCode: 0,
      transactions: { total: 0, house: 0, outside: 0, byIdentityMd: 0 },
    });
    expect(doc.checks).toEqual([]);
    expect(doc.launches.a.evidence).toBeNull();
    expect(seen.rpc).toEqual([
      "eth_chainId []",
      'eth_getBlockByNumber ["finalized",false]',
    ]);
    // Only the requested launch is looked up at IdentityMD.
    expect(seen.api).toEqual(["/jobs/eb0f6c65-174a-45e8-9fe5-9312c66d4880"]);
    const text = render(doc);
    expect(text).toContain("**0 of 10 contracts are launched**");
    expect(text.match(/\*\*Not launched\.\*\*/g)).toHaveLength(3);
    expect(text).toContain(
      "Nothing is launched, so there was nothing to check.",
    );
  });
});

describe("EVIDENCE.md", () => {
  it("says what the JSON says, in sentences a reader can check", async () => {
    const text = render(await run(tape()));
    expect(text.startsWith("# HELP WANTED: evidence\n")).toBe(true);
    expect(text).toContain(
      "at **block 26,184,132**, hash `0xeb5233f9cad9efe4411619588f6fb1c720cd27eaf32363cdbd7d10947a1a7c33`",
    );
    expect(text).toContain("**3 of 10 contracts are launched**");
    expect(text).toContain(
      "after their launch: 12. HOUSE 12, OUTSIDE 0.** Every one was sent by the team's own wallets: nobody outside the team has used these contracts yet.",
    );
    expect(text).toContain(
      "3 oracle requests bought (HOUSE 3, OUTSIDE 0), of which 2 answered by `submit`, 0 by the Intake's callback, 0 closed without an answer and 1 pending.",
    );
    expect(text).toContain(
      "| no. 1 (index 0) | [`0x691890b4affed91496538e012610b632c72a739b5a2ec703b285d51961edb192`]",
    );
    expect(text).toContain(
      "| 112 | 26,176,608 to 26,183,607 | 223 | 26,176,610 to 26,183,609 |",
    );
    expect(text).toContain("| Feeds created | 3 | 3 | 0 |");
    // A zero is printed as a zero.
    expect(text).toContain(
      "| Of those: answered by the Intake's callback | 0 | 0 | 0 |",
    );
    expect(text).toContain("| Tips through `tip`, by payer | 0 | 0 | 0 |");
    expect(text).toContain("| `Payroll` | `Paid` | 0 | 0 | 0 |");
    expect(text).toContain(
      "## Launch B: WorkProof, the hire desk, crowd pots and the Doorbell\n\n**Not launched.**",
    );
    expect(text).toContain("A requested launch is not a launch");
    expect(text).toContain(
      "## Launch C: Rules, Endowments and Zap\n\n**Not launched.**",
    );
    expect(text).toContain("| B | `WorkOrders` | not launched |");
    expect(text).toContain(
      "| employers | 1 | `0x4ef3313d793940eca2847b7d01969ea76c56f92fab92aa7601e863dd92660204` | completing |",
    );
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toMatch(/\n{3,}/);
  });

  it("holds nothing private and none of the words the launch pipeline refuses", async () => {
    const doc = await run(tape());
    for (const text of [render(doc), JSON.stringify(doc)]) {
      expect(privateText(text)).toBeNull();
      expect(text).not.toMatch(EM_DASH);
      expect(text).not.toMatch(REFUSED);
    }
  });

  it("says when a round was answered by somebody outside, and stops saying nobody has used the contracts", async () => {
    const doc = await run(tape());
    doc.headline.transactions = {
      total: 13,
      house: 12,
      outside: 1,
      byIdentityMd: 0,
    };
    const text = render(doc);
    expect(text).toContain("after their launch: 13. HOUSE 12, OUTSIDE 1.**");
    expect(text).not.toContain(
      "nobody outside the team has used these contracts yet",
    );
  });

  it("counts IdentityMD's own deliveries apart, and still says nobody outside has used the contracts", async () => {
    const doc = await run(tape());
    doc.headline.transactions = {
      total: 13,
      house: 12,
      outside: 0,
      byIdentityMd: 1,
    };
    const text = render(doc);
    expect(text).toContain(
      "after their launch: 13. HOUSE 12, OUTSIDE 0, and 1 sent by IdentityMD's own service.**",
    );
    expect(text).toContain(
      "Every other one was sent by the team's own wallets",
    );
  });
});

describe("the command", () => {
  const io = (recorded: Tape, lines: string[], errors: string[]) => ({
    post: replayPost(recorded),
    get: replayGet(recorded),
    sleep: noSleep,
    now: () => NOW,
    book: BOOK,
    houseFile: HOUSE_FILE,
    launchRequests: REQUESTS,
    say: (line: string) => lines.push(line),
    complain: (line: string) => errors.push(line),
  });

  it("writes both files, prints the pinned block, and writes the same bytes again", async () => {
    const out = scratch();
    const lines: string[] = [];
    const errors: string[] = [];
    const env = {
      EVIDENCE_OUT: out,
      API_GAP_MS: "0",
      RPC_URL: "https://tape.example",
    };
    expect(await main(env, io(tape(), lines, errors))).toBe(0);
    expect(errors).toEqual([]);
    expect(
      lines.some((line) =>
        line.startsWith("pinned block 26184132 (0xeb5233f9"),
      ),
    ).toBe(true);
    expect(lines).toContain("32 checks against the contracts agree");
    expect(readdirSync(out).sort()).toEqual(["EVIDENCE.md", "evidence"]);
    expect(readdirSync(join(out, "evidence"))).toEqual(["evidence.json"]);

    const markdown = readFileSync(join(out, "EVIDENCE.md"), "utf8");
    const json = readFileSync(join(out, "evidence", "evidence.json"), "utf8");
    const doc = JSON.parse(json) as EvidenceDocument;
    expect(doc.pinnedBlock.number).toBe(26_184_132);
    expect(markdown).toBe(render(doc));
    expect(json.endsWith("}\n")).toBe(true);

    expect(await main(env, io(tape(), [], []))).toBe(0);
    expect(readFileSync(join(out, "EVIDENCE.md"), "utf8")).toBe(markdown);
    expect(readFileSync(join(out, "evidence", "evidence.json"), "utf8")).toBe(
      json,
    );
  });

  it("writes nothing and exits 1 when a read fails", async () => {
    const out = scratch();
    const recorded = tape();
    const key = Object.keys(recorded.rpc).find((k) =>
      k.startsWith("eth_getLogs"),
    ) as string;
    delete recorded.rpc[key];
    const errors: string[] = [];
    expect(
      await main(
        { EVIDENCE_OUT: out, API_GAP_MS: "0", RPC_URL: "https://tape.example" },
        io(recorded, [], errors),
      ),
    ).toBe(1);
    expect(errors[0]).toMatch(
      /the logs of blocks 26182869 to 26184132 could not be read/,
    );
    expect(errors[1]).toBe("nothing was written.");
    expect(readdirSync(out)).toEqual([]);
  });

  it("leaves the files of an earlier run untouched when a later run fails", async () => {
    const out = scratch();
    const env = {
      EVIDENCE_OUT: out,
      API_GAP_MS: "0",
      RPC_URL: "https://tape.example",
    };
    expect(await main(env, io(tape(), [], []))).toBe(0);
    const before = readFileSync(join(out, "evidence", "evidence.json"), "utf8");
    const broken = tape();
    delete broken.api["/jobs/eb0f6c65-174a-45e8-9fe5-9312c66d4880"];
    expect(await main(env, io(broken, [], []))).toBe(1);
    expect(readFileSync(join(out, "evidence", "evidence.json"), "utf8")).toBe(
      before,
    );
    expect(existsSync(join(out, "EVIDENCE.md.writing"))).toBe(false);
  });

  it("refuses settings it cannot use, before any read", async () => {
    const errors: string[] = [];
    expect(await main({ CHUNK_SIZE: "many" }, io(tape(), [], errors))).toBe(1);
    expect(errors[0]).toBe("CHUNK_SIZE must be a whole number");
    expect(() => settingsFrom({ RPC_URL: "ftp://node.example" })).toThrow(
      /RPC_URL must be http or https/,
    );
    expect(() => settingsFrom({ RPC_URL: " , " })).toThrow(/RPC_URL is empty/);
    expect(() => settingsFrom({ EVIDENCE_API: "maybe" })).toThrow(
      /EVIDENCE_API must be "on" or "off"/,
    );
    expect(() => settingsFrom({ CHUNK_SIZE: "0" })).toThrow(
      /CHUNK_SIZE must be at least 1/,
    );
  });

  it("reads its settings from the environment, with the defaults the documents give", () => {
    expect(settingsFrom({}, "/repo")).toEqual({
      rpcUrls: ["https://ethereum-rpc.publicnode.com"],
      chunkSize: 2000,
      block: null,
      api: true,
      apiGapMs: 13_000,
      outDir: "/repo",
      tape: null,
    });
    expect(
      settingsFrom({
        RPC_URL:
          "https://ethereum-rpc.publicnode.com, https://rpc.mevblocker.io",
        CHUNK_SIZE: "500",
        EVIDENCE_BLOCK: "26184132",
        EVIDENCE_API: "off",
      }),
    ).toMatchObject({
      rpcUrls: [
        "https://ethereum-rpc.publicnode.com",
        "https://rpc.mevblocker.io",
      ],
      chunkSize: 500,
      block: 26_184_132,
      api: false,
    });
  });
});
