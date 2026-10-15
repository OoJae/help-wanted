/**
 * The Jobs Report arithmetic, checked against 99 real Transfer logs (blocks 26,157,493 to
 * 26,164,692, recorded from the public RPC on 10 Oct 2026) whose totals were worked out
 * independently with a ten-line script: 121 IMD, 99 payments, 34 payers.
 */
import { describe, expect, it } from "vitest";
import { MAINNET } from "@help-wanted/shared";
import { RpcChainSource } from "~/data/chain";
import { ChainHouseSource } from "~/data/house";
import type { EthReader, RawLog } from "~/lib/jsonrpc";
import { llmsTxt } from "~/lib/siteDocs";
import {
  computeTally,
  decodePayment,
  HOURS_SHOWN,
  uniquePayments,
  type Payment,
  type TallyWindow,
} from "~/lib/tally";
import { jobsReportPage, paymentsCommand } from "~/models/jobsReport";
import { judgesPage } from "~/models/judges";
import { BOOKS, ctxFor, fakeChain, testSources, TRANSFERS } from "./helpers";

const IMD = 10n ** 18n;
const PAYMENTS = TRANSFERS.logs.map(decodePayment).filter((p): p is Payment => p !== null);
// The window the fake chain reports for the fixture: 12-second blocks anchored on a recorded time.
const WINDOW: TallyWindow = {
  fromBlock: TRANSFERS.fromBlock,
  toBlock: TRANSFERS.toBlock,
  fromTime: 1_791_580_691, // 2026-10-09 21:18:11 UTC
  toTime: 1_791_667_079, // 2026-10-10 21:17:59 UTC
};
const TOP_PAYER = "0x7b8c742f2e1eeb3fb2c10d72967fa6d4a22f0479";

function payment(overrides: Partial<Payment> & { n: number }): Payment {
  const { n, ...rest } = overrides;
  return {
    txHash: `0x${n.toString(16).padStart(64, "0")}`,
    logIndex: 0,
    block: 1000 + n,
    timestamp: 1_800_000_000 + n * 12,
    from: `0x${"a".repeat(39)}${(n % 10).toString()}`,
    amountWei: IMD / 2n,
    ...rest,
  };
}

function transferLog(overrides: Partial<RawLog> = {}): RawLog {
  return {
    address: MAINNET.IMD.toLowerCase(),
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      `0x${"0".repeat(24)}${"c".repeat(40)}`,
      `0x${"0".repeat(24)}${MAINNET.FEE_PAYEE.slice(2).toLowerCase()}`,
    ],
    data: `0x${(IMD / 2n).toString(16).padStart(64, "0")}`,
    blockNumber: "0x10",
    blockTimestamp: "0x6ac95ad3",
    transactionHash: `0x${"9".repeat(64)}`,
    logIndex: "0x2",
    ...overrides,
  };
}

describe("decodePayment", () => {
  it("reads sender, amount, block, time and position from a Transfer log", () => {
    expect(decodePayment(TRANSFERS.logs[0]!)).toEqual({
      txHash: "0x095c72c13f3c02691ca89d8ae0668fdadee974bcda0c4c27436592edc5c6707a",
      logIndex: 0xa7,
      block: 0x18f21c5,
      timestamp: 0x6ac95ad3,
      from: "0xc94400e90bb652afa02740bff50824e14069c133",
      amountWei: 500_000_000_000_000_000n,
    });
  });

  it("decodes every recorded log", () => {
    expect(PAYMENTS).toHaveLength(99);
  });

  it("counts a transfer of zero IMD as a payment, as the on-chain hires feed does", () => {
    const zero = decodePayment(transferLog({ data: `0x${"0".repeat(64)}` }));
    expect(zero?.amountWei).toBe(0n);
    const tally = computeTally([zero!], {
      window: { fromBlock: 0, toBlock: 100, fromTime: null, toTime: null },
    });
    expect(tally.payments).toBe(1);
    expect(tally.totalWei).toBe(0n);
    expect(tally.payers).toBe(1);
  });

  it("returns null for a log that is not a Transfer, or that the node marked removed", () => {
    expect(decodePayment(transferLog({ topics: ["0xddf2"] }))).toBeNull();
    expect(decodePayment(transferLog({ data: "0x" }))).toBeNull();
    expect(decodePayment(transferLog({ data: "0xzz" }))).toBeNull();
    expect(decodePayment(transferLog({ removed: true }))).toBeNull();
  });

  it("returns null for a log of another token, another event or another recipient", () => {
    // What a node that ignored the filter might hand back. None of these is a payment to the swarm.
    expect(decodePayment(transferLog({ address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" }))).toBeNull();
    const [signature, from, to] = transferLog().topics as [string, string, string];
    expect(decodePayment(transferLog({ topics: [`0x${"11".repeat(32)}`, from, to] }))).toBeNull();
    expect(
      decodePayment(transferLog({ topics: [signature, from, `0x${"0".repeat(24)}${"cd".repeat(20)}`] })),
    ).toBeNull();
    // Case does not matter; the same log in upper-case hex is still the payment it is.
    expect(
      decodePayment(
        transferLog({
          address: MAINNET.IMD.toUpperCase().replace("0X", "0x"),
          topics: [signature, from, to.toUpperCase().replace("0X", "0x")],
        }),
      )?.amountWei,
    ).toBe(IMD / 2n);
  });

  it("returns null, and never throws, for a log with a field missing or malformed", () => {
    const broken: Partial<RawLog>[] = [
      { blockNumber: undefined },
      { logIndex: undefined },
      { transactionHash: undefined },
      { transactionHash: "0x1234" },
      { blockNumber: "not hex" },
      { topics: undefined },
      { address: undefined },
      { data: undefined },
    ];
    for (const overrides of broken) {
      expect(
        decodePayment({ ...transferLog(), ...overrides } as RawLog),
        JSON.stringify(overrides),
      ).toBeNull();
    }
    expect(decodePayment(null as unknown as RawLog)).toBeNull();
    // A timestamp the node sent in a shape we cannot read is left empty, not guessed.
    expect(decodePayment(transferLog({ blockTimestamp: "soon" }))?.timestamp).toBeNull();
  });

  it("leaves the time empty when the node put none on the log", () => {
    const log = transferLog();
    delete log.blockTimestamp;
    expect(decodePayment(log)?.timestamp).toBeNull();
  });
});

describe("computeTally on the recorded day", () => {
  const tally = computeTally(PAYMENTS, { window: WINDOW });

  it("totals 121 IMD in 99 payments from 34 payers", () => {
    expect(tally.totalWei).toBe(121n * IMD);
    expect(tally.payments).toBe(99);
    expect(tally.payers).toBe(34);
    expect(tally.largestWei).toBe(10_500_000_000_000_000_000n);
    expect(tally.untimed).toBe(0);
  });

  it("ranks payers by IMD paid, with shares rounded down", () => {
    expect(tally.topPayers).toHaveLength(10);
    expect(tally.topPayers.slice(0, 3).map((p) => [p.rank, p.address, p.totalWei, p.payments])).toEqual([
      [1, TOP_PAYER, 74n * IMD, 8],
      [2, "0x9fadab91f6fa03dbd7f4f8a08a338704baacf63f", 7n * IMD, 14],
      [3, "0x53b4fb24d2f509a0643a9089c7e7a68011f93118", 4n * IMD, 8],
    ]);
    // 74 / 121 = 61.157…%: 6115 basis points, never rounded up.
    expect(tally.topPayers[0]?.shareBps).toBe(6115);
    for (let i = 1; i < tally.topPayers.length; i++) {
      expect(tally.topPayers[i - 1]!.totalWei >= tally.topPayers[i]!.totalWei).toBe(true);
    }
  });

  it("every payer's total adds up to the whole", () => {
    const all = computeTally(PAYMENTS, { window: WINDOW, topPayers: 1000 });
    expect(all.topPayers).toHaveLength(34);
    expect(all.topPayers.reduce((sum, p) => sum + p.totalWei, 0n)).toBe(all.totalWei);
    expect(all.topPayers.reduce((sum, p) => sum + p.payments, 0)).toBe(all.payments);
  });

  it("groups payments by exact size, most frequent first", () => {
    expect(tally.sizes).toEqual([
      { amountWei: IMD / 2n, payments: 91, totalWei: 45_500_000_000_000_000_000n },
      { amountWei: 10_500_000_000_000_000_000n, payments: 7, totalWei: 73_500_000_000_000_000_000n },
      { amountWei: 2n * IMD, payments: 1, totalWei: 2n * IMD },
    ]);
    expect(tally.sizes.reduce((sum, s) => sum + s.totalWei, 0n)).toBe(tally.totalWei);
  });

  it("splits by UTC day, newest first, and marks days the window only partly covers", () => {
    expect(tally.days).toEqual([
      { day: "2026-10-10", totalWei: 41n * IMD, payments: 79, payers: 32, partial: true },
      { day: "2026-10-09", totalWei: 80n * IMD, payments: 20, payers: 7, partial: true },
    ]);
    expect(tally.days.reduce((sum, d) => sum + d.totalWei, 0n)).toBe(tally.totalWei);
    expect(tally.days.reduce((sum, d) => sum + d.payments, 0)).toBe(tally.payments);
  });

  it("splits by clock hour, oldest first, and the hours add up to the whole", () => {
    // 21:18 on the 9th to 21:17 on the 10th touches 25 clock hours.
    expect(tally.hours).toHaveLength(25);
    expect(tally.hours.length).toBeLessThanOrEqual(HOURS_SHOWN);
    expect(tally.hours[0]?.start).toBe(Math.floor(WINDOW.fromTime! / 3600) * 3600);
    expect(tally.hours.at(-1)?.start).toBe(Math.floor(WINDOW.toTime! / 3600) * 3600);
    expect(tally.hours.reduce((sum, h) => sum + h.totalWei, 0n)).toBe(tally.totalWei);
    expect(tally.hours.reduce((sum, h) => sum + h.payments, 0)).toBe(tally.payments);
  });

  it("counts HOUSE payments separately and never loses a wei between the two columns", () => {
    expect(tally.houseWei).toBe(0n);
    expect(tally.outsideWei).toBe(tally.totalWei);
    const withHouse = computeTally(PAYMENTS, { window: WINDOW, house: new Set([TOP_PAYER]) });
    expect(withHouse.houseWei).toBe(74n * IMD);
    expect(withHouse.housePayments).toBe(8);
    expect(withHouse.outsideWei).toBe(47n * IMD);
    expect(withHouse.outsidePayments).toBe(91);
    expect(withHouse.houseWei + withHouse.outsideWei).toBe(withHouse.totalWei);
    expect(withHouse.topPayers[0]?.house).toBe(true);
    expect(withHouse.topPayers[1]?.house).toBe(false);
    // Labelling a payer HOUSE changes no total.
    expect(withHouse.totalWei).toBe(tally.totalWei);
    expect(withHouse.payers).toBe(tally.payers);
  });

  it("gives the same answer whatever order the logs arrive in, and however often they repeat", () => {
    const shuffled = [...PAYMENTS].reverse();
    const doubled = [...PAYMENTS, ...PAYMENTS.slice(0, 40)];
    expect(computeTally(shuffled, { window: WINDOW })).toEqual(tally);
    expect(computeTally(doubled, { window: WINDOW })).toEqual(tally);
  });

  it("counts only what lies inside the block range it states", () => {
    const firstHalf = { ...WINDOW, toBlock: 26_161_000 };
    const secondHalf = { ...WINDOW, fromBlock: 26_161_001 };
    const a = computeTally(PAYMENTS, { window: firstHalf });
    const b = computeTally(PAYMENTS, { window: secondHalf });
    expect(a.payments + b.payments).toBe(99);
    expect(a.totalWei + b.totalWei).toBe(121n * IMD);
    expect(a.payments).toBeGreaterThan(0);
    expect(b.payments).toBeGreaterThan(0);
  });
});

describe("computeTally edge cases", () => {
  it("prints zeros, not blanks, for an empty window", () => {
    const tally = computeTally([], {
      window: { fromBlock: 1, toBlock: 2, fromTime: 86_400 * 100, toTime: 86_400 * 100 + 60 },
    });
    expect(tally).toMatchObject({
      totalWei: 0n,
      payments: 0,
      payers: 0,
      houseWei: 0n,
      outsideWei: 0n,
      largestWei: 0n,
    });
    expect(tally.topPayers).toEqual([]);
    expect(tally.sizes).toEqual([]);
    expect(tally.days).toEqual([{ day: "1970-04-11", totalWei: 0n, payments: 0, payers: 0, partial: true }]);
  });

  it("calls a day whole only when the window covers its first and last second", () => {
    const dayStart = 86_400 * 20_000;
    const window = {
      fromBlock: 0,
      toBlock: 10_000,
      fromTime: dayStart - 3600,
      toTime: dayStart + 2 * 86_400 + 3600,
    };
    const tally = computeTally(
      [
        payment({ n: 1, timestamp: dayStart + 10 }),
        payment({ n: 2, timestamp: dayStart + 86_400 + 10, amountWei: IMD }),
      ],
      { window },
    );
    expect(tally.days.map((d) => [d.payments, d.partial])).toEqual([
      [0, true], // the day the window ends in
      [1, false],
      [1, false],
      [0, true], // the day the window starts in
    ]);
    // A whole day in which nothing was paid still gets its row, as a zero.
    const quiet = computeTally([], { window });
    expect(quiet.days.filter((d) => !d.partial).map((d) => d.payments)).toEqual([0, 0]);
  });

  it("breaks a tie between payers by address, so the ranking is stable", () => {
    const tally = computeTally(
      [payment({ n: 1, from: `0x${"b".repeat(40)}` }), payment({ n: 2, from: `0x${"a".repeat(40)}` })],
      { window: { fromBlock: 0, toBlock: 5000, fromTime: null, toTime: null } },
    );
    expect(tally.topPayers.map((p) => p.address)).toEqual([`0x${"a".repeat(40)}`, `0x${"b".repeat(40)}`]);
    expect(tally.topPayers.map((p) => p.shareBps)).toEqual([5000, 5000]);
  });

  it("totals payments without a time but keeps them out of the day and hour rows", () => {
    const tally = computeTally([payment({ n: 1, timestamp: null }), payment({ n: 2 })], {
      window: { fromBlock: 0, toBlock: 5000, fromTime: null, toTime: null },
    });
    expect(tally.payments).toBe(2);
    expect(tally.untimed).toBe(1);
    expect(tally.days).toHaveLength(1);
    expect(tally.days[0]?.payments).toBe(1);
    expect(tally.hours).toEqual([]);
  });

  it("shows at most the newest 26 clock hours of a longer window", () => {
    const end = 86_400 * 20_000 + 1800;
    const tally = computeTally([payment({ n: 1, timestamp: end - 100 })], {
      window: { fromBlock: 0, toBlock: 5000, fromTime: end - 5 * 86_400, toTime: end },
    });
    expect(tally.hours).toHaveLength(HOURS_SHOWN);
    expect(tally.hours.at(-1)?.payments).toBe(1);
  });

  it("uniquePayments keeps one copy per transaction and log index, in chain order", () => {
    const a = payment({ n: 2 });
    const b = payment({ n: 1 });
    const sameTxOtherLog = { ...b, logIndex: 5 };
    expect(uniquePayments([a, b, a, sameTxOtherLog])).toEqual([b, sameTxOtherLog, a]);
  });
});

describe("/jobs-report, built from the data sources", () => {
  it("prints the recorded day's figures, labelled unofficial, with the exact block range", async () => {
    // A world with no launch in its book: no official print can exist, and the page says why.
    const world = testSources({ book: BOOKS.none });
    const model = await jobsReportPage.load(ctxFor(world, "/jobs-report"), {});
    expect(model?.tally?.totalWei).toBe(121n * IMD);
    expect(model?.tally?.payments).toBe(99);
    expect(model?.tally?.payers).toBe(34);
    expect(model?.tally?.window).toEqual(WINDOW);
    expect(model?.official.launched).toBe(false);
    expect(model?.official.printed).toBe(false);
    expect(model?.official.prints).toEqual([]);
    expect(model?.official.summary).toBeNull();
    expect(model?.releaseNumber).toBe("HW-RJR-2026-10-10-U");
    expect(model?.summary).toContain(
      "121 IMD reached the swarm's fee address in 99 payments from 34 employers",
    );
    expect(model?.summary).toContain("The largest employer paid 74 IMD, 61.1% of the total");
    expect(model?.coverage?.words).toBe(
      "Blocks 26,157,493 to 26,164,692: 9 Oct 2026, 21:18 UTC to 10 Oct 2026, 21:17 UTC. That is the newest 7,200 blocks, one day's worth: a range the public RPC serves, so the commands below reproduce every figure for it.",
    );
    expect(model?.coverage?.archive).toContain("No archive RPC is configured");
    // A server that has just started holds nothing older than the release.
    expect(model?.earlier).toBeNull();

    const markdown = jobsReportPage.markdown(model!);
    expect(markdown.startsWith("**UNOFFICIAL TALLY.**")).toBe(true);
    expect(markdown).toContain("not launched yet");
    expect(markdown).toContain("| Non-human payrolls, IMD | 121 | 0 | 121 |");
    expect(markdown).toContain("| Payments | 99 | 0 | 99 |");
    expect(markdown).toContain(`| 1 | ${TOP_PAYER} | 74 | 8 | 61.1% | OUTSIDE |`);
    expect(markdown).toContain("--from-block 26157493 --to-block 26164692");
    expect(jobsReportPage.meta(model!).title).toContain("unofficial");
  });

  it("labels a house wallet's payments HOUSE once it is one of ours", async () => {
    // A deployment whose Payroll address is the day's top payer: its payments become HOUSE.
    const world = testSources({ env: { HW_ADDR_ZAP: TOP_PAYER } });
    const model = await jobsReportPage.load(ctxFor(world), {});
    expect(model?.tally?.houseWei).toBe(74n * IMD);
    expect(model?.tally?.outsideWei).toBe(47n * IMD);
    expect(jobsReportPage.markdown(model!)).toContain("| Non-human payrolls, IMD | 121 | 74 | 47 |");
  });

  it("says there is no tally, and invents nothing, when the chain cannot be read", async () => {
    const world = testSources({ chain: { failCalls: true } });
    const model = await jobsReportPage.load(ctxFor(world), {});
    expect(model?.tally).toBeNull();
    expect(model?.tallyError).toContain("the RPC is down");
    expect(model?.summary).toBe("The chain could not be read, so there is no tally to print.");
    expect(jobsReportPage.markdown(model!)).toContain("The tally could not be computed");
  });

  it("reads the logs once for many page views, then only the newest blocks", async () => {
    let now = 1_791_667_800_000;
    const world = testSources({ now: () => now });
    const logReads = () => world.chain.calls.filter((c) => c.startsWith("eth_getLogs"));
    for (let i = 0; i < 6; i++) await jobsReportPage.load(ctxFor(world), {});
    expect(logReads()).toEqual([`eth_getLogs ${MAINNET.IMD.toLowerCase()} 26157493-26164692`]);

    // Past the cache's life, the refresh re-reads only the last few blocks (in case of a reorg).
    now += 120_000;
    const model = await jobsReportPage.load(ctxFor(world), {});
    expect(logReads()).toEqual([
      `eth_getLogs ${MAINNET.IMD.toLowerCase()} 26157493-26164692`,
      `eth_getLogs ${MAINNET.IMD.toLowerCase()} 26164681-26164692`,
    ]);
    expect(model?.tally?.payments).toBe(99);
    expect(model?.tally?.totalWei).toBe(121n * IMD);
  });
});

describe("/jobs-report after the server has been up for a while", () => {
  /** A chain whose head can be moved, with payments spread over several days of blocks. */
  function movingChain(start: number, logs: RawLog[]) {
    let head = start;
    const base = fakeChain({ head, transferLogs: logs });
    const reader: EthReader = { ...base.reader, blockNumber: async () => BigInt(head) };
    return { reader, advance: (blocks: number) => (head += blocks), head: () => head };
  }
  // Twelve seconds a block from a fixed point, so two fake chains agree on every block's time.
  const timeOf = (block: number) => 1_790_000_000 + (block - 26_160_000) * 12;
  const at = (block: number, n: number): RawLog =>
    transferLog({
      blockNumber: `0x${block.toString(16)}`,
      blockTimestamp: `0x${timeOf(block).toString(16)}`,
      transactionHash: `0x${n.toString(16).padStart(64, "0")}`,
      logIndex: "0x0",
    });

  function worldWith(chainReader: EthReader, now: () => number) {
    const world = testSources({ now });
    const chain = new RpcChainSource({
      reader: chainReader,
      rpcHost: "rpc.test",
      logWindowBlocks: 7200,
      tallyDays: 14,
      now,
    });
    world.sources.chain = chain;
    world.sources.house = new ChainHouseSource(chain, world.sources.deployments);
    return world;
  }

  it("still prints figures, and a command, for one day of blocks the public RPC serves", async () => {
    let now = 1_800_000_000_000;
    const start = 26_170_000;
    // Two payments in the first day held, three in the ten hours after it.
    const logs = [
      at(start - 7000, 1),
      at(start - 10, 2),
      at(start + 500, 3),
      at(start + 2000, 4),
      at(start + 2999, 5),
    ];
    const chain = movingChain(start, logs);
    const world = worldWith(chain.reader, () => now);

    const first = await jobsReportPage.load(ctxFor(world), {});
    expect(first?.tally?.window.fromBlock).toBe(start - 7199);
    expect(first?.tally?.payments).toBe(2);

    // Ten hours later (3,000 blocks). The server has only ever re-read the newest blocks.
    chain.advance(3000);
    now += 10 * 3_600_000;
    const later = await jobsReportPage.load(ctxFor(world), {});
    const window = later!.tally!.window;
    const head = chain.head();
    // The release covers the newest 7,200 blocks, not everything since the process started.
    expect(window.toBlock).toBe(head);
    expect(window.fromBlock).toBe(head - 7199);
    expect(window.toBlock - window.fromBlock + 1).toBe(7200);
    // So the headline counts the four payments inside that day and not the one before it...
    expect(later?.tally?.payments).toBe(4);
    expect(later?.tally?.totalWei).toBe(2n * IMD);
    expect(later?.summary).toContain("2 IMD reached the swarm's fee address in 4 payments");
    // ...and the command printed for readers asks the public RPC for a range it serves (about the
    // newest 9,000 blocks): the same range as the figures, never the grown one.
    const command = later!.commands[0]!.command;
    expect(command).toContain(`--from-block ${head - 7199} --to-block ${head}`);
    expect(command).toContain("--rpc-url https://ethereum-rpc.publicnode.com");
    expect(head - 7199).toBeGreaterThan(head - 9000);
    expect(command).toBe(`${paymentsCommand(window)} > payments.json`);

    // What the server holds from before the release is shown apart, and says it cannot be
    // reproduced from the public RPC. No payment is counted in both places.
    expect(later?.earlier?.window).toMatchObject({ fromBlock: start - 7199, toBlock: head - 7200 });
    const earlierPayments = later!.earlier!.days.reduce((sum, day) => sum + day.payments, 0);
    expect(earlierPayments).toBe(1);
    expect(earlierPayments + later!.tally!.payments).toBe(5);
    expect(later?.earlier?.note).toContain("needs an archive RPC");
    const markdown = jobsReportPage.markdown(later!);
    expect(markdown).toContain("## Table F. Earlier days held by this server");
    expect(markdown).toContain("That is the newest 7,200 blocks, one day's worth");

    // The fourth claim on /judges and the line in /llms.txt print the same range and the same figure.
    const judges = await judgesPage.load(ctxFor(world), {});
    expect(judges?.claims[3]?.command).toContain(`--from-block ${head - 7199} --to-block ${head}`);
    expect(judges?.claims[3]?.readNow).toContain("2 IMD in 4 payments");
    expect(await llmsTxt(ctxFor(world))).toContain(
      `2 IMD paid to the swarm's fee address in 4 payments from 1 payers, blocks ${head - 7199} to ${head}`,
    );
  });

  it("prints the same release after a restart as before it", async () => {
    const start = 26_170_000;
    const logs = [at(start - 7000, 1), at(start - 10, 2), at(start + 500, 3), at(start + 2000, 4)];
    // A server that has been up for ten hours, and one that started just now at the same block.
    let now = 1_800_000_000_000;
    const longRunning = movingChain(start, logs);
    const old = worldWith(longRunning.reader, () => now);
    await jobsReportPage.load(ctxFor(old), {});
    longRunning.advance(3000);
    now += 10 * 3_600_000;
    const before = await jobsReportPage.load(ctxFor(old), {});

    const restarted = movingChain(start + 3000, logs);
    const fresh = await jobsReportPage.load(ctxFor(worldWith(restarted.reader, () => now)), {});
    expect(fresh?.tally?.window).toEqual(before?.tally?.window);
    expect(fresh?.tally?.payments).toBe(before?.tally?.payments);
    expect(fresh?.tally?.totalWei).toBe(before?.tally?.totalWei);
    expect(fresh?.commands).toEqual(before?.commands);
  });
});
