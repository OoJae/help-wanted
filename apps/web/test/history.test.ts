/**
 * The history the site keeps (`src/config/history.ts`) and the pages that show it.
 *
 * The records are held against each other, against the shared package and against the deployments
 * book: the order header recomputed from the order's ticket, the job text's hash, the trail's order,
 * the rounds' feeds. Then the pages are loaded on the real book with a fake chain that answers as
 * mainnet did on 15 October 2026 for order 1 (and on 16 October 2026 for order 2), and must show the
 * trail, hide what no longer applies to a delivered order, and lead the front page with it.
 */
import { encodeEventTopics, encodeAbiParameters, keccak256, stringToHex, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  CHAIN_ID,
  DEPLOYMENT_BOOK,
  doorbellAbi,
  endowmentsAbi,
  HOUSE_FEEDS,
  jobsReportAbi,
  kindHash,
  MAINNET,
  OFFCHAIN,
  orderHeadHash,
  orderTicket,
  payrollAbi,
  questionsAbi,
  REQUEST_BLOCKER,
  ROUND_STATUS,
  rulesAbi,
  workOrdersAbi,
} from "@help-wanted/shared";
import { resolveDeployments } from "~/config/deployments";
import {
  ENDOWMENT_HISTORY,
  HOUSE_X402,
  LAUNCH_C_ON_CHAIN,
  LAUNCH_PRS,
  ORDER_HISTORY,
  pinnedEndowment,
  pinnedOrder,
  pinnedPrint,
  pinnedRounds,
  pinnedRings,
  pinnedRule,
  pinnedTipClaims,
  PRINT_HISTORY,
  RING_HISTORY,
  ROUND_HISTORY,
  RULE_HISTORY,
  UNUSED_FEATURES,
  VERIFIED_SOURCE,
} from "~/config/history";
import { HOUSE_WALLETS } from "~/config/house";
import { llmsTxt } from "~/lib/siteDocs";
import { loadPath, markdownTwin } from "~/lib/twins";
import { CLAIM_TIP_RULE } from "~/models/common";
import {
  HIRE_IS_FOR,
  RUNNER_STATEMENT,
  type HireIndexModel,
  type HireTemplateModel,
  type OrderModel,
  type RunnersModel,
} from "~/models/desk";
import type { JobsReportModel } from "~/models/jobsReport";
import type { JudgesModel } from "~/models/judges";
import { NO_WATCHER, type EndowmentsModel, type RulesNewModel, type SeatModel } from "~/models/money";
import { DESK_ADAPTATION } from "~/config/proofs";
import type { QuestionsModel } from "~/models/questions";
import { LAUNCH_C_LINKS, STATIC_PATHS, isLivePath } from "~/models/registry";
import type { WireModel } from "~/models/wire";
import { BANNED, BOOKS, ctxFor, testSources, type FakeChainOptions } from "./helpers";

const IMD = 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000";
const H1 = HOUSE_WALLETS[1]!.address;
const BOOK = resolveDeployments({}, DEPLOYMENT_BOOK).contracts;
const DESK = BOOK.workOrders.address as string;
const BELL = BOOK.doorbell.address as string;
const PAYROLL = BOOK.payroll.address as string;
const FIRST = ORDER_HISTORY.orders[0]!;
const SECOND = ORDER_HISTORY.orders[1]!;
const RULES = BOOK.rules.address as string;
const RULE_ONE = RULE_HISTORY.entries[0]!;

type Views = NonNullable<FakeChainOptions["views"]>;

/** Order 1 as the desk answered for it on 15 October 2026, after it was settled. */
function orderOne(overrides: { state?: number; proven?: boolean; account?: unknown[] } = {}): Views {
  const state = overrides.state ?? 6;
  return {
    [`${DESK}:orderCount`]: { abi: workOrdersAbi, result: 1n },
    [`${DESK}:accountOf`]: {
      abi: workOrdersAbi,
      result: overrides.account ?? [state, BELL, 0n, IMD, 0n],
    },
    [`${DESK}:orderOf`]: {
      abi: workOrdersAbi,
      result: {
        employer: BELL,
        expiresAt: 1_792_082_771,
        rampFrom: 1_791_910_000,
        state,
        flags: 3,
        kindHash: FIRST.prove.kindHash,
        specHash: FIRST.prove.specHash,
        minPay: IMD,
        maxPay: IMD,
        rampSecs: 0,
        deliverySecs: 604_800,
        runnerOnly: ZERO,
        bond: IMD / 4n,
        arbiter: ZERO,
        escrow: state === 6 ? 0n : IMD,
        condTarget: ZERO,
        condSelector: "0x00000000",
        condCmp: 0,
        condMet: true,
        proven: overrides.proven ?? state === 6,
        notified: state === 6,
        seq: 1,
        condArg: `0x${"0".repeat(64)}`,
        condThreshold: 0n,
        spent: state === 6 ? IMD : 0n,
        returned: 0n,
      },
    },
    [`${DESK}:claimOf`]: {
      abi: workOrdersAbi,
      result: {
        runner: H1,
        claimedAt: 1_791_911_831,
        registeredAt: 1_791_912_371,
        price: IMD,
        jobId: "0xf7bd80ba3e8b483fad026ffbd16fef92",
        challenger: ZERO,
        assertedAt: 1_791_913_079,
        recordHash: FIRST.prove.recordHash,
      },
    },
    [`${PAYROLL}:tipOwed`]: { abi: payrollAbi, result: 0n },
    [`${BELL}:ringsUntilHire`]: { abi: doorbellAbi, result: 25n },
    [`${BELL}:funded`]: { abi: doorbellAbi, result: false },
    [`${BELL}:ALLOW_CLAIMED`]: { abi: doorbellAbi, result: true },
    [`${BELL}:rings`]: { abi: doorbellAbi, result: 25n },
    [`${BELL}:hires`]: { abi: doorbellAbi, result: 1n },
    [`${BELL}:receipts`]: { abi: doorbellAbi, result: 1n },
    [`${BELL}:lastOrderId`]: { abi: doorbellAbi, result: 1n },
    [`${BELL}:MIN_PAY`]: { abi: doorbellAbi, result: IMD },
    [`${BELL}:MAX_PAY`]: { abi: doorbellAbi, result: IMD },
    [`${BELL}:BOND`]: { abi: doorbellAbi, result: IMD / 4n },
    [`${BELL}:DELIVERY_SECS`]: { abi: doorbellAbi, result: 604_800 },
  };
}

/** Order 2 as the desk answered for it on 16 October 2026, after it was settled (orderOf and claimOf read on chain). */
function orderTwo(): Views {
  return {
    [`${DESK}:orderCount`]: { abi: workOrdersAbi, result: 2n },
    [`${DESK}:accountOf`]: {
      abi: workOrdersAbi,
      result: [6, RULES, 0n, 560_050_000_000_000_000n, 39_950_000_000_000_000n],
    },
    [`${DESK}:orderOf`]: {
      abi: workOrdersAbi,
      result: {
        employer: RULES,
        expiresAt: 1_792_405_727,
        rampFrom: 1_792_146_527,
        state: 6,
        flags: 2,
        kindHash: SECOND.prove.kindHash,
        specHash: SECOND.prove.specHash,
        minPay: 560_000_000_000_000_000n,
        maxPay: 600_000_000_000_000_000n,
        rampSecs: 86_400,
        deliverySecs: 604_800,
        runnerOnly: ZERO,
        bond: IMD / 4n,
        arbiter: ZERO,
        escrow: 0n,
        condTarget: ZERO,
        condSelector: "0x00000000",
        condCmp: 0,
        condMet: true,
        proven: true,
        notified: true,
        seq: 1,
        condArg: `0x${"0".repeat(64)}`,
        condThreshold: 0n,
        spent: 560_050_000_000_000_000n,
        returned: 39_950_000_000_000_000n,
      },
    },
    [`${DESK}:claimOf`]: {
      abi: workOrdersAbi,
      result: {
        runner: H1,
        claimedAt: 1_792_146_635,
        registeredAt: 1_792_146_959,
        price: 560_050_000_000_000_000n,
        jobId: "0x42f26c64eea946f2822a33547ec18abf",
        challenger: ZERO,
        assertedAt: 0,
        recordHash: SECOND.prove.recordHash,
      },
    },
    [`${PAYROLL}:tipOwed`]: { abi: payrollAbi, result: 0n },
  };
}

const mainnet = (views: Views = orderOne()) => testSources({ book: DEPLOYMENT_BOOK, chain: { views } });

async function page<M>(world: ReturnType<typeof testSources>, path: string) {
  const loaded = (await loadPath(path, ctxFor(world, path)))!;
  return { loaded, model: loaded.model as M, markdown: markdownTwin(loaded) };
}

describe("the history kept with the site", () => {
  it("belongs to the contracts the deployments book names, and to no stand-in", () => {
    expect(ORDER_HISTORY.workOrders).toBe(DESK);
    expect(ROUND_HISTORY.questions).toBe(BOOK.questions.address);
    expect(PRINT_HISTORY.jobsReport).toBe(BOOK.jobsReport.address);
    expect(pinnedOrder(DESK, 1)).toBe(FIRST);
    expect(pinnedOrder(DESK, 2)).toBe(SECOND);
    expect(pinnedOrder(DESK, 3)).toBeNull();
    expect(RULE_HISTORY.rules).toBe(RULES);
    expect(pinnedRule(RULES, 1)).toBe(RULE_ONE);
    expect(pinnedRule(RULES, 2)).toBeNull();
    // A test book's stand-in desk borrows nothing from mainnet.
    const standIn = resolveDeployments({}, BOOKS.aAndB).contracts;
    expect(pinnedOrder(standIn.workOrders.address, 1)).toBeNull();
    expect(pinnedOrder(standIn.workOrders.address, 2)).toBeNull();
    expect(pinnedRule(resolveDeployments({}, BOOKS.all).contracts.rules.address, 1)).toBeNull();
    expect(pinnedRounds(standIn.questions.address)).toEqual([]);
    expect(pinnedPrint(standIn.jobsReport.address, 0)).toBeNull();
    // The contracts checked on the explorers are the ten the book holds, in its order.
    expect(VERIFIED_SOURCE.contracts.map((c) => [c.name, c.address])).toEqual(
      Object.values(BOOK).map((c) => [c.name, c.address]),
    );
    // Etherscan verified all ten; Sourcify, read the same day, holds three of them.
    expect(VERIFIED_SOURCE.contracts.every((c) => c.etherscan === "Exact Match")).toBe(true);
    expect(VERIFIED_SOURCE.contracts.filter((c) => c.sourcify === "match").map((c) => c.name)).toEqual([
      "CrowdPots",
      "Endowments",
      "Zap",
    ]);
  });

  it("order 1: its header, its job text and its trail agree with each other", () => {
    // The ticket of claim 1 by the runner, recomputed: its header is the one prove hashed.
    const ticket = orderTicket({
      chainId: CHAIN_ID,
      workOrders: DESK as `0x${string}`,
      orderId: FIRST.id,
      claimSeq: 1,
      runner: H1,
    });
    expect(ticket).toBe("0xbd87367fc83372def576d4f8a370d72e295e10e2572f796ec8f1af720fa36d80");
    expect(orderHeadHash(ticket)).toBe(FIRST.prove.headHash);
    expect(keccak256(stringToHex(FIRST.spec))).toBe(FIRST.prove.specHash);
    expect(FIRST.prove.agentIds).toEqual(["51519"]);
    // The steps, in the order they happened, and each a different transaction.
    expect(FIRST.trail.map((s) => s.key)).toEqual([
      "opened",
      "claimed",
      "paid",
      "registered",
      "asserted",
      "receipt",
      "settled",
    ]);
    const blocks = FIRST.trail.map((s) => s.tx.block);
    expect([...blocks].sort((a, b) => a - b)).toEqual(blocks);
    expect(new Set(FIRST.trail.map((s) => s.tx.hash)).size).toBe(FIRST.trail.length);
    for (const step of FIRST.trail) expect(Date.parse(step.tx.at)).toBeGreaterThan(0);
    // Who sent what: the runner its own steps, IdentityMD the payment and the receipt.
    const from = Object.fromEntries(FIRST.trail.map((s) => [s.key, s.tx.from]));
    expect(from).toMatchObject({ claimed: H1, registered: H1, asserted: H1, settled: H1 });
    expect(from.paid).toBe(MAINNET.FEE_PAYEE);
    expect(from.receipt).toBe(MAINNET.WORK_REGISTRY_WRITER);
    expect(FIRST.trail.find((s) => s.key === "paid")?.what).toContain(OFFCHAIN.X402_EXACT_PERMIT2_PROXY);
    // The x402 payment of the trail is the one the house list names for the job.
    const paid = HOUSE_X402.payments.find((p) => p.jobId === FIRST.jobId);
    expect(paid).toMatchObject({ payer: "H1" });
    expect(paid?.tx.hash).toBe(FIRST.trail.find((s) => s.key === "paid")?.tx.hash);
    // The tip was claimed after the settlement, for the agent the record names.
    expect(FIRST.tipClaims.map((c) => c.agentId)).toEqual(FIRST.prove.agentIds);
    expect(FIRST.tipClaims[0]!.tx.block).toBeGreaterThan(blocks.at(-1)!);
  });

  it("order 2: its header, its job text, its trail and its rule agree with each other", () => {
    // The ticket of claim 1 by the runner, recomputed: its header is the one prove hashed, and the
    // one headerOf(2) answered on mainnet.
    const ticket = orderTicket({
      chainId: CHAIN_ID,
      workOrders: DESK as `0x${string}`,
      orderId: SECOND.id,
      claimSeq: 1,
      runner: H1,
    });
    expect(ticket).toBe("0xbd623ece89b1c600768011d08b9f77f00f169c6b6f31d2e3c37d61515189c407");
    expect(orderHeadHash(ticket)).toBe(SECOND.prove.headHash);
    expect(keccak256(stringToHex(SECOND.spec))).toBe(SECOND.prove.specHash);
    expect(kindHash("skill:research-report")).toBe(SECOND.prove.kindHash);
    expect(SECOND.prove.stateHash).toBe(FIRST.prove.stateHash);
    expect(SECOND.prove.agentIds).toEqual(["52142"]);
    expect(SECOND.read).toBe("16 October 2026");
    expect(SECOND.prove.read).toBe(SECOND.read);
    expect(FIRST.read).toBe("15 October 2026");
    // The steps, in the order they happened: the receipt was written before the job was registered.
    expect(SECOND.trail.map((s) => s.key)).toEqual([
      "opened",
      "claimed",
      "paid",
      "receipt",
      "registered",
      "settled",
    ]);
    const blocks = SECOND.trail.map((s) => s.tx.block);
    expect([...blocks].sort((a, b) => a - b)).toEqual(blocks);
    expect(new Set(SECOND.trail.map((s) => s.tx.hash)).size).toBe(SECOND.trail.length);
    for (const step of SECOND.trail) expect(Date.parse(step.tx.at)).toBeGreaterThan(0);
    // Who sent what: H1 fired the rule and ran the runner; IdentityMD sent the payment and the receipt.
    const from = Object.fromEntries(SECOND.trail.map((s) => [s.key, s.tx.from]));
    expect(from).toMatchObject({ opened: H1, claimed: H1, registered: H1, settled: H1 });
    expect(from.paid).toBe(MAINNET.FEE_PAYEE);
    expect(from.receipt).toBe(MAINNET.WORK_REGISTRY_WRITER);
    expect(SECOND.trail.find((s) => s.key === "paid")?.what).toContain(OFFCHAIN.X402_EXACT_PERMIT2_PROXY);
    // A receipt-only order: no delivery claim in its trail.
    expect(SECOND.trail.some((s) => s.key === "asserted")).toBe(false);
    expect(SECOND.trail.find((s) => s.key === "settled")?.what).toContain("the bonded-claim path was off");
    const paid = HOUSE_X402.payments.find((p) => p.jobId === SECOND.jobId);
    expect(paid).toMatchObject({ payer: "H1" });
    expect(paid?.tx.hash).toBe(SECOND.trail.find((s) => s.key === "paid")?.tx.hash);
    // The tip was claimed by H1 after the settlement, for the agent the record names, and paid to
    // an address that had no code.
    expect(SECOND.tipClaims.map((c) => c.agentId)).toEqual(SECOND.prove.agentIds);
    expect(SECOND.tipClaims[0]).toMatchObject({ tokenId: "1978", paidToHasCode: false });
    expect(SECOND.tipClaims[0]!.amountWei).toBe(28_002_500_000_000_000n);
    expect(SECOND.tipClaims[0]!.tx.from).toBe(H1);
    expect(SECOND.tipClaims[0]!.tx.block).toBeGreaterThan(blocks.at(-1)!);
    // The work is a report IdentityMD serves; the order kept for it is a picture's no more.
    expect(SECOND.work?.url).toBe(
      "https://api.imd.fun/artifacts/4dcebdb382dd91a82e53a629dc7620f811feb6146e011d3a6e799fdf7c6482f0",
    );
    expect(FIRST.work).toBeUndefined();
    // Its rule: created and fired by H1, the fire is the order's opening, and the creator took the
    // change back after the settlement.
    expect(RULE_ONE).toMatchObject({ id: 1, creator: H1, orderId: SECOND.id, read: SECOND.read });
    expect(RULE_ONE.trail.map((s) => s.label)).toEqual(["Rule created", "Rule fired", "Change withdrawn"]);
    for (const step of RULE_ONE.trail) {
      expect(step.tx.from).toBe(H1);
      expect(step.tx.block).toBeGreaterThan(LAUNCH_C_ON_CHAIN.tx.block);
    }
    expect(RULE_ONE.trail[1]!.tx).toEqual(SECOND.trail[0]!.tx);
    expect(RULE_ONE.trail[0]!.tx.block).toBeLessThan(SECOND.trail[0]!.tx.block);
    expect(RULE_ONE.trail[2]!.tx.block).toBeGreaterThan(blocks.at(-1)!);
  });

  it("the first rounds: one per house feed, opened by H1, answered twice by submit and once by the callback", () => {
    expect(ROUND_HISTORY.rounds.map((r) => r.feed)).toEqual(["payrolls", "hires", "employers"]);
    for (const r of ROUND_HISTORY.rounds) {
      expect(r.feedId, r.feed).toBe(HOUSE_FEEDS[r.feed].id);
      expect(r.round).toBe(1);
      expect(r.opened.keeper).toBe(H1);
      expect(r.answered.block).toBeGreaterThan(r.opened.block);
      expect(r.answered.byCallback).toBe(r.answered.deliveredBy === MAINNET.INTAKE);
    }
    const byCallback = ROUND_HISTORY.rounds.filter((r) => r.answered.byCallback).map((r) => r.feed);
    expect(byCallback).toEqual(["employers"]);
    expect(ROUND_HISTORY.rounds.find((r) => r.feed === "employers")?.answered.from).toBe(
      MAINNET.INTAKE_WRITER,
    );
    // The payrolls answer is the oracle request the README's check 4 reads.
    expect(ROUND_HISTORY.rounds[0]!.answered.oracleRequestId.slice(0, 34)).toBe(
      "0xf8ffb99155b74316946144a94d5270aa",
    );
  });

  it("x402: eight payments from house wallets, each its own transaction, all sent through IdentityMD", () => {
    expect(HOUSE_X402.payments).toHaveLength(8);
    expect(HOUSE_X402.payments.filter((p) => p.payer === "W1")).toHaveLength(6);
    expect(HOUSE_X402.payments.filter((p) => p.payer === "H1")).toHaveLength(2);
    expect(new Set(HOUSE_X402.payments.map((p) => p.tx.hash)).size).toBe(8);
    expect(HOUSE_X402.read).toBe("16 October 2026");
    for (const p of HOUSE_X402.payments) {
      expect(p.tx.from).toBe(MAINNET.FEE_PAYEE);
      expect(p.tx.block).toBeGreaterThanOrEqual(HOUSE_X402.fromBlock);
      expect(p.tx.block).toBeLessThanOrEqual(HOUSE_X402.toBlock);
    }
  });

  it("quotes the launch pull requests word for word, and invents no finding id", () => {
    expect(LAUNCH_PRS.map((pr) => [pr.launch, pr.launchNumber])).toEqual([
      ["A", 1531],
      ["B", 1573],
      ["C", 1845],
    ]);
    expect(LAUNCH_PRS[0]!.reviewer).toContain("An independent reviewer raised 8 finding(s).");
    expect(LAUNCH_PRS[1]!.reviewer).toContain("An independent reviewer raised 11 finding(s).");
    expect(LAUNCH_PRS[2]!.reviewer).toContain("An independent reviewer raised 13 finding(s).");
    for (const pr of LAUNCH_PRS) expect(pr.reviewer).toContain(`raised ${pr.count} finding(s).`);
    // Launch C's pull request is the one IdentityMD's launch 1845 was made from.
    expect(LAUNCH_PRS[2]!.launchNumber).toBe(LAUNCH_C_ON_CHAIN.launchNumber);
    // The only ids named are the ones launch B's ADAPTATION.md heads its review findings with.
    const ids = LAUNCH_PRS.flatMap((pr) => pr.accounted.match(/\b[0-9a-f]{8}\b/g) ?? []);
    expect([...new Set(ids)]).toEqual(["a96c4f58", "bff72b72", "2094daa9"]);
    // Each account adds up to the PR's own count, and points at the record that holds the findings
    // (the pipeline job the house list paid for) and at our document that lists every one.
    expect(LAUNCH_PRS[0]!.accounted).toContain("holds the 8");
    expect(LAUNCH_PRS[0]!.accounted).toContain(
      "4 from audit_imported_code, 1 from audit_math, 1 from audit_economics, and 2 from audit_judge",
    );
    expect(LAUNCH_PRS[1]!.accounted).toContain("holds the 11");
    expect(LAUNCH_PRS[1]!.accounted).toContain("ADAPTATION.md answers 7 of them");
    expect(LAUNCH_PRS[1]!.accounted).toContain("merged the other 4 into those 3");
    // Launch C: 3 + 2 + 1 + 1 + 1 + 5 = 13, none blocking; launch C's AUDITS.md lists them all.
    expect(LAUNCH_PRS[2]!.accounted).toContain("holds the 13, all in accepted review submissions");
    expect(LAUNCH_PRS[2]!.accounted).toContain(
      "3 from audit_imported_code, 2 from audit_permissions, 1 from audit_flow, 1 from audit_math, 1 from audit_economics, and 5 from audit_judge",
    );
    expect(LAUNCH_PRS[2]!.accounted).toContain("6 are graded low and 7 info, and none was marked blocking");
    expect(LAUNCH_PRS[2]!.accounted).toContain(
      "The other 10 were raised after the pipeline's one adaptation of the code had been accepted, and no node of the job answered them.",
    );
    expect(LAUNCH_PRS[2]!.document).toBe("launches/c-company/docs/AUDITS.md");
    const folders = { A: "a-payroll", B: "b-desk", C: "c-company" } as const;
    for (const pr of LAUNCH_PRS) {
      expect(pr.accounted).not.toMatch(/not (listed|in any public file)|no document of ours/);
      const jobId = pr.record.match(/\/jobs\/([0-9a-f-]{36})\/submissions$/)?.[1];
      expect(HOUSE_X402.payments.find((p) => p.jobId === jobId)?.job, pr.launch).toContain(
        `launch ${pr.launch}`,
      );
      expect(pr.document).toMatch(new RegExp(`^launches/${folders[pr.launch]}/docs/AUDITS\\.md`));
    }
  });

  it("launch C: the deployments book holds what mainnet holds", () => {
    expect(LAUNCH_C_ON_CHAIN.launchNumber).toBe(1845);
    expect(LAUNCH_C_ON_CHAIN.tx.from).toBe(MAINNET.LAUNCH_DEPLOYER);
    // Launch C's job was paid for before launch C was created.
    const job = HOUSE_X402.payments.find((p) => p.job.startsWith("launch C"))!;
    expect(LAUNCH_C_ON_CHAIN.tx.block).toBeGreaterThan(job.tx.block);
    expect(Date.parse(LAUNCH_C_ON_CHAIN.tx.at)).toBeGreaterThan(Date.parse(job.tx.at));
    // The book and the record agree: transaction, block, number and every address.
    expect(DEPLOYMENT_BOOK.c.transaction).toBe(LAUNCH_C_ON_CHAIN.tx.hash);
    expect(DEPLOYMENT_BOOK.c.block).toBe(LAUNCH_C_ON_CHAIN.tx.block);
    expect(DEPLOYMENT_BOOK.c.launchNumber).toBe(LAUNCH_C_ON_CHAIN.launchNumber);
    for (const [key, address] of Object.entries(LAUNCH_C_ON_CHAIN.contracts)) {
      expect(BOOK[key as keyof typeof BOOK].address, key).toBe(address);
    }
  });

  it("endowment 1: the team's drill, created, funded and withdrawn by W1, kept for the real Endowments only", () => {
    const endowments = BOOK.endowments.address as string;
    expect(ENDOWMENT_HISTORY.endowments).toBe(endowments);
    const drill = pinnedEndowment(endowments, 1)!;
    expect(drill.creator).toBe(HOUSE_WALLETS[0]!.address);
    expect(drill.trail.map((s) => s.label)).toEqual([
      "Created",
      "Seed staked",
      "Deposited",
      "Staked",
      "Withdrawn",
    ]);
    // Oldest first, each its own transaction, all sent by W1, all after launch C was created.
    const blocks = drill.trail.map((s) => s.tx.block);
    expect([...blocks].sort((a, b) => a - b)).toEqual(blocks);
    expect(new Set(drill.trail.map((s) => s.tx.hash)).size).toBe(drill.trail.length);
    for (const step of drill.trail) {
      expect(step.tx.from).toBe(HOUSE_WALLETS[0]!.address);
      expect(step.tx.block).toBeGreaterThan(LAUNCH_C_ON_CHAIN.tx.block);
    }
    expect(pinnedEndowment(endowments, 2)).toBeNull();
    const standIn = resolveDeployments({}, BOOKS.all).contracts.endowments.address;
    expect(pinnedEndowment(standIn, 1)).toBeNull();
  });

  it("uses none of the words the site does not use", () => {
    const text = JSON.stringify(
      {
        ORDER_HISTORY,
        ROUND_HISTORY,
        HOUSE_X402,
        LAUNCH_PRS,
        UNUSED_FEATURES,
        ENDOWMENT_HISTORY,
        RULE_HISTORY,
      },
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    );
    expect(text).not.toMatch(BANNED);
  });

  it("says launch B's review counts with the submissions they come from", () => {
    const b = LAUNCH_PRS[1]!.accounted;
    expect(b).toContain("holds the 11 in its accepted review submissions");
    expect(b).toContain("3 from audit_judge's last round (all info)");
    expect(b).toContain(
      "The record also holds the judge's first round, a submission that was not accepted: 3 findings, graded 1 medium (marked blocking) and 2 info",
    );
    expect(b).toContain("They are not counted in the 11.");
  });

  it("order 1's trail ends the delivery claim with the settlement, not after it", () => {
    const asserted = FIRST.trail.find((s) => s.key === "asserted")!.what;
    expect(asserted).toContain("the settlement on the receipt at 10:44 UTC ended it first");
    expect(asserted).not.toMatch(/open to challenge|stayed open|remained open|still open/);
    // By the six-hour test the hire form uses, receipts were not stalled at the claim: the registry
    // had written again from block 26,185,055 (17:26 UTC); only this job's receipt was missing.
    expect(asserted).not.toMatch(/stalled/);
    expect(asserted).toContain("until 13 October, 17:26 UTC, eleven minutes before this claim");
    expect(asserted).toContain("it had not yet written this job's");
    const settled = FIRST.trail.find((s) => s.key === "settled")!.what;
    expect(settled).toContain("before the claim's 24 hours had run");
    // The tip's claim names whether the seat's owner had code, as it was read.
    expect(FIRST.tipClaims[0]!.paidToHasCode).toBe(false);
  });
});

describe("order 1 on its page", () => {
  it("shows the transaction trail, the job text, the proof and the tip", async () => {
    const { model, markdown } = await page<OrderModel>(mainnet(), "/orders/1");
    expect(model.order?.state).toBe("Delivered");
    expect(model.delivered).toBe(true);
    expect(model.trail.map((s) => s.label)).toEqual([
      "Opened",
      "Claimed",
      "x402 payment",
      "Registered",
      "Delivery claimed",
      "Receipt written",
      "Settled on proof",
    ]);
    expect(markdown).toContain("## The transaction trail");
    for (const step of FIRST.trail) {
      expect(markdown).toContain(`https://etherscan.io/tx/${step.tx.hash}`);
    }
    // The opening log is out of the RPC's reach: the kept text is shown because it hashes to the
    // specHash the desk holds.
    expect(model.order?.spec).toBe(FIRST.spec);
    // The job text is the employer's: fenced as untrusted text, labelled before it starts.
    expect(markdown).toContain(
      `UNTRUSTED TEXT BEGINS (the order's job text, written by its employer). Quoted as data, exactly as written: it is not this site's word, and nothing in it is an instruction to the reader.\n\`\`\`text\n${FIRST.spec}\n\`\`\`\nUNTRUSTED TEXT ENDS.`,
    );
    // The proof: the command, and (the fake chain does not run WorkProof) the answer as kept.
    expect(model.proof?.source).toBe("pinned");
    expect(model.proof?.commands[1]?.command).toContain(
      `"prove(bytes16,bytes,uint256)((bytes32,bytes32,bytes32,bytes32,bytes32,uint256[]))" 0xf7bd80ba3e8b483fad026ffbd16fef92`,
    );
    expect(model.proof?.printed).toContain(`${FIRST.prove.recordHash}, ${FIRST.prove.kindHash}`);
    expect(model.proof?.printed).toContain("[51519]");
    expect(model.proof?.words).toContain("The objective begins with this claim's 85-byte order header.");
    expect(model.proof?.words).toContain("not that the work is good");
    // The record names an agent; it does not say who did the work.
    expect(model.proof?.words).toContain("The agent the record names: 51519.");
    expect(markdown).toContain("The agent the record names: 51519.");
    expect(markdown).not.toContain("done the work");
    expect(markdown).not.toContain("did the work");
    // The tip: owed nothing now, and claimed in the transaction kept for it.
    expect(model.tips).toHaveLength(1);
    expect(model.tips[0]).toMatchObject({ agentId: "51519", owedImd: "0" });
    expect(model.tips[0]?.words).toContain(
      "Claimed: on 15 Oct 2026, 12:56 UTC house wallet W1 called claimTip(51519)",
    );
    expect(markdown).toContain(FIRST.tipClaims[0]!.tx.hash);
  });

  it("hides the expiry and the actions once it is delivered", async () => {
    const { model, markdown } = await page<OrderModel>(mainnet(), "/orders/1");
    expect(model.flows).toEqual([]);
    expect(markdown).not.toContain("## What anyone can do");
    expect(markdown).not.toContain("Expires:");
    expect(model.commands.map((c) => c.command).join("\n")).not.toContain("priceNow");
  });

  it("an order that is not delivered keeps its expiry and what anyone can do", async () => {
    const open = mainnet(orderOne({ state: 1, account: [1, BELL, IMD, 0n, 0n] }));
    const { model, markdown } = await page<OrderModel>(open, "/orders/1");
    expect(model.delivered).toBe(false);
    expect(model.flows.length).toBeGreaterThan(0);
    expect(markdown).toContain("## What anyone can do");
    expect(markdown).toContain("Expires:");
    expect(model.proof).toBeNull();
    // Its history is still history: the trail is shown whatever the order's state is now.
    expect(model.trail).toHaveLength(FIRST.trail.length);
  });

  it("on a stand-in desk, an order has no trail and nothing borrowed from mainnet", async () => {
    const standIn = resolveDeployments({}, BOOKS.aAndB).contracts.workOrders.address as string;
    const views: Views = {};
    for (const [key, view] of Object.entries(orderOne())) {
      if (key.startsWith(DESK)) views[key.replace(DESK, standIn)] = view;
    }
    const { model } = await page<OrderModel>(
      testSources({ book: BOOKS.aAndB, chain: { views } }),
      "/orders/1",
    );
    expect(model.order?.state).toBe("Delivered");
    expect(model.trail).toEqual([]);
    expect(model.order?.spec).toBeNull();
    expect(model.proof?.source).toBeNull();
    expect(model.flows).toEqual([]);
  });

  it("is in /llms.txt among what is proven on the live system, with the prove command", async () => {
    const text = await llmsTxt(ctxFor(mainnet()));
    const proven = text.slice(text.indexOf("## Proven on the live system"), text.indexOf("## Addresses"));
    expect(proven).toContain(
      "Order 1 on the hire desk, opened by the Doorbell, was settled on proof on 14 Oct 2026, 10:44 UTC: the desk had WorkProof check swarm job f7bd80ba-3e8b-483f-ad02-6ffbd16fef92's work record against its WorkRegistry receipt, then paid (https://etherscan.io/tx/0xa3f5b783fe194c35f348e411a10f0a199589ea89b668a16d1597794931217628).",
    );
    expect(proven).toContain("The ringer, the runner and the Doorbell's IMD were the team's own.");
    expect(proven).toContain("A proof shows what IdentityMD recorded, not that the work is good.");
    expect(proven).toContain(
      "https://api.imd.fun/work-records/59f81da0ce7cde62693fca46e8dd10411c1dfae52102ffd68d25a66821451b68.json -o record.json",
    );
    expect(proven).toContain(`cast call ${BOOK.workProof.address} "prove(`);
    expect(proven).toContain(
      ` 0xf7bd80ba3e8b483fad026ffbd16fef92 "0x$(xxd -p record.json | tr -d '\\n')" 85 `,
    );
    // Only for mainnet's desk: a book with another desk says nothing of order 1.
    const other = await llmsTxt(ctxFor(testSources({ book: BOOKS.aAndB })));
    expect(other).not.toContain("Order 1 on the hire desk");
  });

  it("/llms.txt discloses launch C's pipeline findings beside launch B's, once the book holds launch C", async () => {
    const text = await llmsTxt(ctxFor(mainnet()));
    const c = LAUNCH_PRS.find((pr) => pr.launch === "C")!;
    expect(text).toContain(
      "Not a proof, a disclosure: before it deployed launch C (IdentityMD launch 1845), IdentityMD's launch pipeline audited the three contracts.",
    );
    expect(text).toContain(
      `Its record of the job, ${c.record}, holds 13 findings, all in accepted review submissions: 6 graded low and 7 info, none marked blocking.`,
    );
    expect(text).toContain(
      "launches/c-company/ADAPTATION.md answers the 3 raised by the audit it imported; no node of the job answered the other 10.",
    );
    expect(text).toContain("launches/c-company/docs/AUDITS.md lists all 13, each with what became of it.");
    // Launch B's disclosure is still there, and a book without launch C says nothing of C's.
    expect(text).toContain("Not a proof, a disclosure: before it deployed launch B");
    const withoutC = await llmsTxt(ctxFor(testSources({ book: BOOKS.aAndB })));
    expect(withoutC).toContain("Not a proof, a disclosure: before it deployed launch B");
    expect(withoutC).not.toContain("before it deployed launch C");
  });
});

describe("order 2 on its page", () => {
  const two = () => testSources({ book: DEPLOYMENT_BOOK, chain: { views: orderTwo() } });

  it("shows the rule's order: its trail, its job text, the proof, the tip and the report, read on 16 October 2026", async () => {
    const { model, markdown } = await page<OrderModel>(two(), "/orders/2");
    expect(model.order?.state).toBe("Delivered");
    expect(model.delivered).toBe(true);
    expect(model.trail.map((s) => s.label)).toEqual([
      "Opened",
      "Claimed",
      "x402 payment",
      "Receipt written",
      "Registered",
      "Settled on proof",
    ]);
    for (const step of SECOND.trail) expect(markdown).toContain(`https://etherscan.io/tx/${step.tx.hash}`);
    // Its trail was read on its own day, not on the day order 1's was.
    expect(model.trailNote).toContain("read from the chain on 16 October 2026");
    expect(model.order?.spec).toBe(SECOND.spec);
    // The ticket of the runner's claim gives the header prove hashed.
    expect(model.ticket).toBe("0xbd623ece89b1c600768011d08b9f77f00f169c6b6f31d2e3c37d61515189c407");
    expect(model.proof?.source).toBe("pinned");
    expect(model.proof?.printed).toContain("[52142]");
    expect(model.proof?.words).toContain("As called on 16 October 2026");
    expect(model.proof?.words).toContain("The objective begins with this claim's 85-byte order header.");
    expect(model.proof?.words).toContain("The kind is the order's.");
    expect(model.tips[0]).toMatchObject({ agentId: "52142", owedImd: "0" });
    expect(model.tips[0]?.words).toContain(
      "Claimed: on 16 Oct 2026, 10:46 UTC house wallet H1 called claimTip(52142)",
    );
    expect(model.tips[0]?.words).toContain("had no code when read on 16 October 2026");
    // A price on a ramp is not a round number: the page gives every amount to the wei.
    expect(model.tips[0]?.words).toContain("Payroll paid the 0.0280025 IMD tip credited for agent 52142");
    expect(Object.fromEntries(model.money.map((m) => [m.label, m.imd]))).toMatchObject({
      "Paid out for delivered work": "0.56005",
      "Sent back to the employer": "0.03995",
      "Price fixed by the runner's claim": "0.56005",
      "of which fee (to Payroll)": "0.0280025",
      "of which to the runner": "0.504045",
    });
    // A report, not a picture: the link is to the file IdentityMD serves, and no copy is kept here.
    expect(model.picture).toBeNull();
    expect(model.work).toMatchObject({ label: "See the report the rule paid for", url: SECOND.work!.url });
    expect(markdown).toContain("## The work");
    expect(markdown).toContain(
      `See the report the rule paid for: [${SECOND.work!.url}](${SECOND.work!.url})`,
    );
    expect(markdown).toContain("This site serves no copy.");
    expect(model.flows).toEqual([]);
  });

  it("/rules/new names rule 1 as the team's own, with its transactions and its order", async () => {
    const { model, markdown } = await page<RulesNewModel>(mainnet(), "/rules/new");
    expect(model.firstRule?.words).toContain("Rule 1 is the team's own.");
    expect(model.firstRule?.words).toContain(
      "House wallet H1 created it on 16 October 2026 (block 26,204,482)",
    );
    expect(model.firstRule?.words).toContain("This is HOUSE use, not outside use.");
    expect(model.firstRule?.links.map((l) => l.url)).toEqual([
      ...RULE_ONE.trail.map((step) => `https://etherscan.io/tx/${step.tx.hash}`),
      "/orders/2",
      `https://etherscan.io/tx/${SECOND.trail.at(-1)!.tx.hash}`,
    ]);
    expect(markdown).toContain("Rule 1 is the team's own.");
    // The form's example is the view-call rule of launch C's document, not called its first rule.
    expect(markdown).not.toContain("the first rule proposed in launch C's launch document");
    expect(markdown).toContain(
      "The example is a rule on a view call, the one launch C's launch document gives in section 6",
    );
    // A book whose Rules is not mainnet's says nothing of rule 1.
    const other = await page<RulesNewModel>(testSources({ book: BOOKS.all }), "/rules/new");
    expect(other.model.firstRule).toBeNull();
  });
});

describe("the front page on mainnet's book", () => {
  it("leads with the order paid on proof, its links, the four lines and the three actions", async () => {
    const { loaded, model, markdown } = await page<WireModel>(mainnet(), "/");
    // A contract hired; the desk paid the runner on proof; the tip was credited for the agent the
    // record names and claimed for that agent's seat owner.
    expect(model.lead?.headline).toBe("A contract hired, and the desk paid the runner on proof.");
    expect(model.lead?.deck).toContain("credited a tip for agent 51519, the agent IdentityMD's record names");
    expect(model.lead?.deck).not.toMatch(/escrow paid out|ownerless contract hired the swarm/);
    expect(model.lead?.orderPath).toBe("/orders/1");
    expect(model.lead?.verifyPath).toBe(`/verify/${FIRST.jobId}`);
    expect(model.lead?.links.map((l) => l.label)).toEqual([
      "the settlement",
      "the x402 payment",
      "the tip for agent 51519, claimed for seat #1049's owner",
    ]);
    expect(model.lead?.now).toBe("Read for this page: order 1 is Delivered and marked proven.");
    // Order 2 follows in the same form: a rule hired, and it was the team's own.
    expect(model.lead?.next?.orderPath).toBe("/orders/2");
    expect(model.lead?.next?.verifyPath).toBe(`/verify/${SECOND.jobId}`);
    expect(model.lead?.next?.deck).toContain(
      "On 16 October 2026 rule 1 on our Rules contract read launch A's hires feed, which reported 223, and opened order 2 for a research report",
    );
    expect(model.lead?.next?.deck).toContain(
      "was paid on IdentityMD's receipt at 10:37 UTC, under nine minutes after the fire",
    );
    expect(model.lead?.next?.deck).toContain(
      "The rule's creator, the wallet that fired it (by hand) and the runner were all house wallet H1.",
    );
    expect(model.lead?.next?.links.map((l) => l.label)).toEqual([
      "the rule's fire",
      "the settlement",
      "the x402 payment",
      "the tip for agent 52142, claimed for seat #1978's owner",
    ]);
    expect(model.lead?.next?.work?.url).toBe(SECOND.work!.url);
    expect(markdown).toContain(
      `See the report the rule paid for: [${SECOND.work!.url}](${SECOND.work!.url})`,
    );
    expect(model.whatIsNew).toHaveLength(4);
    // WorkProof checks the hash and returns the record's hashes; the desk compares them with the order.
    expect(model.whatIsNew[2]).toContain(
      "its keccak256 must equal latest(jobId). The desk then checks that the record carries the order's 85-byte order header, kind and job text.",
    );
    expect(model.whatIsNew[2]).not.toContain("it must carry");
    expect(model.actions.ring.doorbell).toMatchObject({ rung: 0, every: 25, funded: false });
    // The band under the hero carries the count, funded or not, and its twin says the same; the ad
    // under "Three things to do" says what the band does not: what it needs, and how its orders pay.
    expect(model.actions.ring.doorbell?.count).toContain("0 of 25 rings toward its next hire. Not funded");
    expect(markdown).toContain(
      `## The Doorbell\n\n${model.actions.ring.doorbell!.what} ${model.actions.ring.doorbell!.count}`,
    );
    expect(markdown).toContain("[Ring the Doorbell](/rules/new#doorbell)");
    expect(model.actions.ring.words).toContain("To hire again it needs 1 IMD and 25 more rings");
    expect(model.actions.ring.words).not.toContain("rings toward its next hire");
    expect(model.houseStatus).toContain(
      "1 was opened by our own wallets and contracts (HOUSE) and 0 by anyone else",
    );
    expect(model.jobs.cards.length).toBeLessThanOrEqual(5);
    // The twin is headed with the site's name; the lead follows as its first line.
    expect(loaded.meta.title).toBe("HELP WANTED");
    expect(markdown.startsWith("# HELP WANTED\n")).toBe(true);
    expect(markdown).toContain("**A contract hired, and the desk paid the runner on proof.**");
    expect(markdown).toContain("## What is new");
    expect(markdown).toContain("## Three things to do");
    // The twin's summary names the employer as the strip above it does: a contract or a wallet.
    expect(markdown).toContain("An employer escrows IMD against a pinned job;");
    expect(markdown).not.toContain("A contract escrows");
  });

  it("keeps the swarm's headline where the book's desk is not the one order 1 was paid on", async () => {
    const { model, markdown } = await page<WireModel>(testSources(), "/");
    expect(model.lead).toBeNull();
    expect(model.headline).toBe("900 robots online. 6 have work.");
    expect(markdown).toContain("**900 robots online. 6 have work.**");
    expect(markdown).not.toContain("A contract hired, and the desk paid the runner");
  });
});

describe("the judges page on mainnet's book", () => {
  it("opens with what is live, the five lines, and the explorers' verdicts", async () => {
    const { model, markdown } = await page<JudgesModel>(mainnet(), "/judges");
    expect(model.thirtySeconds).toHaveLength(5);
    expect(model.thirtySeconds[1]).toContain("opened order 1");
    expect(model.live?.groups.map((g) => g.title)).toEqual([
      "The launches",
      "The house feeds' first rounds: three Intake requests, three answers",
      "The first Robot Jobs Report",
      "The Doorbell's 25 rings",
      "Order 1: opened by a contract, paid on proof",
      "Order 2: opened by a rule, paid on proof",
      "Endowment 1: the team's own drill, with the team's own IMD",
    ]);
    // Order 2's group: the rule's creation, the order's trail, the change taken back (block
    // 26,204,586), then the tip (block 26,204,587): oldest first, as the intro says.
    const second = model.live?.groups.find((g) => g.title === "Order 2: opened by a rule, paid on proof");
    expect(second?.rows.map((r) => r.label)).toEqual([
      "Rule created",
      "Opened",
      "Claimed",
      "x402 payment",
      "Receipt written",
      "Registered",
      "Settled on proof",
      "Change withdrawn",
      "Tip claimed",
    ]);
    // Each order's group is oldest first: no row's block comes before the row above it.
    for (const group of model.live?.groups.filter((g) => g.title.startsWith("Order ")) ?? []) {
      const blocks = group.rows.map((r) => r.block).filter((b): b is number => b !== null);
      expect(blocks, group.title).toEqual([...blocks].sort((a, b) => a - b));
    }
    expect(second?.rows.find((r) => r.label === "Tip claimed")?.what).toContain(
      "eth_getCode, read on 16 October 2026",
    );
    expect(second?.rows.find((r) => r.label === "Tip claimed")?.what).toContain(
      "The seat's owner is a wallet outside the team. It did nothing to be paid",
    );
    expect(model.live?.intro).toContain(
      "read from the chain on 15 October 2026 (order 2 and rule 1: 16 October 2026)",
    );
    // What happened: both orders, and who was behind the second.
    expect(model.thirtySeconds[1]).toContain("opened order 2 for a research report");
    expect(model.thirtySeconds[1]).toContain("44 blocks after the fire");
    expect(model.thirtySeconds[1]).toContain(
      "The rule's creator, the wallet that fired it (by hand) and the runner were all house wallet H1 (HOUSE).",
    );
    // All three launches are among the transactions, launch C's included.
    expect(model.live?.groups[0]?.rows.map((r) => r.label)).toEqual([
      "Launch A, IdentityMD launch 1531",
      "Launch B, IdentityMD launch 1573",
      "Launch C, IdentityMD launch 1845",
    ]);
    const rows = model.live?.groups.flatMap((g) => g.rows) ?? [];
    expect(rows.find((r) => r.label === "employers, round 1 answered")?.what).toContain(
      "Delivered by the Intake's callback",
    );
    expect(rows.map((r) => r.label)).toContain("Tip claimed");
    expect(model.live?.prove?.answer).toContain("[51519]");
    expect(model.verification.rows).toHaveLength(10);
    expect(model.verification.rows.every((r) => r.etherscan === "Exact Match")).toBe(true);
    expect(model.verification.rows[0]?.url).toBe(
      `https://etherscan.io/address/${BOOK.questions.address}#code`,
    );
    // Every launch's pull request is shown: the book records all three.
    expect(model.pipelinePrs.map((pr) => pr.launch)).toEqual(["A", "B", "C"]);
    expect(markdown).toContain(LAUNCH_PRS[2]!.url);
    expect(markdown).toContain(LAUNCH_PRS[2]!.record);
    expect(markdown).toContain(`"${LAUNCH_PRS[2]!.reviewer}"`);
    expect(model.unused.length).toBeGreaterThanOrEqual(3);
    expect(markdown.indexOf("## Read in 30 seconds")).toBeLessThan(markdown.indexOf("## Live on mainnet"));
    expect(markdown.indexOf("## Live on mainnet")).toBeLessThan(markdown.indexOf("## What this is"));
    expect(markdown).toContain("## Protocol features we do not use");
    // The Intake requests are the contract's own count, all time: three rounds, one request each.
    const intake = model.integration.find((r) => r.primitive.startsWith("Intake, version 2"));
    expect(intake?.usage.what).toContain("the sum of its own round counters");
    // One order is "1 order": a count read for the page takes the singular when it is one.
    const usage = (primitive: string) => model.integration.find((r) => r.primitive === primitive)!.usage;
    expect(usage("WorkRegistry (work receipts)")).toMatchObject({
      count: "1",
      what: "order settled against a registry receipt, among the newest 40",
    });
    expect(usage("Work records")).toMatchObject({ count: "1", what: "order delivered, among the newest 40" });
    expect(usage("IMD")).toMatchObject({ count: "1", what: "order opened with IMD in escrow" });
    expect(markdown).not.toMatch(/\b1 (orders|Intake requests|feeds holding)\b/);
    // The x402 row links every payment it counts, and names the four Intake purchases it leaves out.
    const x402 = model.integration.find((r) => r.primitive.includes("x402"));
    for (const p of HOUSE_X402.payments) {
      expect(x402?.proofs.map((e) => e.url)).toContain(`https://etherscan.io/tx/${p.tx.hash}`);
    }
    expect(x402?.usage.what).toContain(
      "less the four oracle requests W1 bought through the legacy Intake (three attested, one not)",
    );
    // It says each payment is linked, and links exactly those: one per payment, no more, no fewer.
    expect(x402?.usage.what).toContain("each one's transaction linked in this row");
    const x402Links = x402?.proofs.filter((e) => e.label.startsWith("x402, ")) ?? [];
    expect(x402Links.map((e) => e.url)).toEqual(
      HOUSE_X402.payments.map((p) => `https://etherscan.io/tx/${p.tx.hash}`),
    );
    // A kept figure is dated; only a figure read for the page is said to be read for it.
    expect(markdown).not.toContain("Counted now");
    expect(x402?.usage.countedOn).toBe("16 October 2026");
    expect(markdown).toContain("Counted on 16 October 2026: 8 x402 payments");
    const legacy = model.integration.find((r) => r.primitive.startsWith("Intake, version 1"));
    expect(legacy?.usage.countedOn).toBe("15 October 2026");
    const audits = model.integration.find((r) => r.primitive.startsWith("Audit jobs"));
    expect(audits?.usage.countedOn).toBe("13 October 2026");
    expect(intake?.usage.countedOn).toBeUndefined();
    // The tip's claim, in the words of the rule Payroll enforces.
    const tip = rows.find((r) => r.label === "Tip claimed")!.what;
    expect(tip).toContain("the agent IdentityMD's work record names");
    expect(tip).toContain(
      "so anyone could send the call; had it held code, only the owner could have sent it",
    );
    expect(tip).not.toContain("an ordinary wallet; eth_getCode");
    // Launch B's review counts say which submissions they come from.
    expect(model.audits.desk?.intro).toContain(
      "its first round, a submission that was not accepted, raised 1 medium finding and 2 info notes, and its last round, the accepted one, restates the same 3, all graded info",
    );
    expect(model.audits.desk?.intro).toContain(
      "The 3 of the judge's first round are on the record too and are not counted in the 11.",
    );
    // What the launch PRs say, with the record that holds the findings and our list of them.
    expect(markdown).toContain(LAUNCH_PRS[1]!.record);
    expect(markdown).toContain("launches/b-desk/docs/AUDITS.md");
    expect(markdown).not.toContain("The other 8 of the 11");
    expect(markdown).not.toContain("not in any public file");
  });

  it("treats launch C as live: 10 of 10, its pipeline record, its flows sendable, nothing still waiting for the book", async () => {
    const world = mainnet();
    const { model, markdown } = await page<JudgesModel>(world, "/judges");
    const c = model.launches.find((l) => l.key === "C")!;
    expect(c.launched).toBe(true);
    expect(c.txUrl).toBe(`https://etherscan.io/tx/${LAUNCH_C_ON_CHAIN.tx.hash}`);
    expect(c.status).toContain("Launched as IdentityMD launch 1845, in block 26,198,165.");
    // The launch C pipeline record, with its pull request's 13 findings and where they are.
    expect(c.status).toContain(
      `Its pull request says: "An independent reviewer raised 13 finding(s)." Its record of the job (${LAUNCH_PRS[2]!.record}) holds those 13, all in accepted review submissions: 6 graded low and 7 info, none marked blocking.`,
    );
    expect(c.status).toContain(
      "The pipeline changed no source file; launches/c-company/ADAPTATION.md says so",
    );
    expect(c.status).toContain(
      "No node of the job answered the other 10, which were raised after the pipeline's adaptation step. launches/c-company/docs/AUDITS.md lists all 13, each with what became of it.",
    );
    expect(model.launchCPipeline?.read).toMatchObject({ state: "completed", launchStatus: "live" });
    expect(markdown).toContain("Launch C's job: [7f2023fc-fa1f-4a7f-a507-3bbc712c51d6]");
    const pipelineRow = model.integration.find((r) => r.primitive === "The launch pipeline")!;
    expect(pipelineRow.launchLabel).toBe("Launched");
    expect(pipelineRow.usage.count).toBe("3 of 3");
    expect(pipelineRow.proofs.map((p) => p.label)).toContain("launch C's job 7f2023fc");
    expect(pipelineRow.proofNote).toContain("holds 13 findings (6 low, 7 info, none marked blocking)");
    // 10 of 10, from all three launches, each verified on Etherscan.
    expect(model.launchedCount).toBe(10);
    expect(model.launchSummary).toBe("All 10 contracts are launched.");
    expect(model.summary).toContain("All 10 of our contracts are launched.");
    expect(model.thirtySeconds[3]).toBe(
      "What is live: 10 of 10 contracts in this site's deployments book, from IdentityMD launches 1531, 1573 and 1845, each with source verified on Etherscan (Exact Match, checked 15 October 2026).",
    );
    expect(model.notLive.some((line) => line.startsWith("Launch C ("))).toBe(false);
    // Every row that names a launch C contract calls it launched, at its address.
    for (const row of model.integration.filter((r) =>
      r.contracts.some((x) => x.key === "rules" || x.key === "endowments" || x.key === "zap"),
    )) {
      expect(row.launch, row.primitive).toBe("launched");
      expect(row.statusWords, row.primitive).not.toContain("not launched");
    }
    // Audited by the pipeline and by no one outside it, with where that is read.
    const audit = model.notLive.find((l) => l.includes("Launch C was audited by that pipeline too"))!;
    expect(audit).toContain(
      `and by no one outside it: we bought no audit of it, and IdentityMD records no outside audit of it (GET https://api.imd.fun/launches/${LAUNCH_C_ON_CHAIN.launchId}/assurances answered a count of 0 on 15 October 2026)`,
    );
    expect(audit).toContain(
      "The 3 raised by the audit the pipeline imported are answered in launches/c-company/ADAPTATION.md; no node of the job answered the other 10. launches/c-company/docs/AUDITS.md lists all 13, each with what became of it.",
    );
    // The page no longer says that no document of ours lists them.
    expect(markdown).not.toContain("no document of ours lists all 13");
    expect(pipelineRow.proofNote).toContain("launches/c-company/docs/AUDITS.md lists all 13");
    // Nothing says launch C waits for the book, or is coming, on any page or twin.
    const waiting =
      /not yet in this site's deployments book|not yet switched on|live on chain, not yet|Coming: launch C|(Rules|Endowments|Zap)[^.]* is not launched yet/;
    expect(markdown).not.toMatch(waiting);
    for (const path of [
      "/",
      "/endowments",
      "/rules/new",
      "/pots",
      "/questions",
      "/company",
      "/hire",
      "/runners",
    ]) {
      expect((await page(world, path)).markdown, path).not.toMatch(waiting);
    }
    // The flows of launch C can be sent from the site's own buttons: each names the address it sends to.
    const flows: [string, string, string][] = [
      ["/endowments", "Endowments", BOOK.endowments.address as string],
      ["/rules/new", "Rules", BOOK.rules.address as string],
      ["/pots", "Zap", BOOK.zap.address as string],
    ];
    for (const [path, name, address] of flows) {
      const loaded = await page<{ flows?: { ready: boolean }[] }>(world, path);
      expect(loaded.markdown, path).toContain(`Sent to ${name} at ${address}.`);
      expect(loaded.markdown, path).not.toContain(`${name} is not launched yet, so this cannot be sent yet.`);
    }
    // The navigation: every page is live, and nothing of launch C is set apart as coming.
    expect(STATIC_PATHS.every((p) => isLivePath(p, world.sources.deployments))).toBe(true);
    expect(
      LAUNCH_C_LINKS.filter((l) => world.sources.deployments.contracts[l.needs].address === null),
    ).toEqual([]);
  });

  it("on a test book without launch C, launch C is plainly not launched, with nothing borrowed from mainnet", async () => {
    const { model, markdown } = await page<JudgesModel>(testSources({ book: BOOKS.aAndB }), "/judges");
    const c = model.launches.find((l) => l.key === "C")!;
    expect(c.launched).toBe(false);
    expect(c.status).toContain("Not launched: the deployments book holds no address for it.");
    expect(model.launchCPipeline).toBeNull();
    expect(model.pipelinePrs.map((pr) => pr.launch)).toEqual(["A", "B"]);
    // What the page says of the launches borrows nothing from mainnet's launch C. (The table of
    // disclosed limits quotes launch C's own document, which names its launch, whatever the book.)
    const said = [model.launchSummary, model.summary, ...model.thirtySeconds, ...model.notLive];
    for (const launch of model.launches) said.push(launch.status);
    expect(said.join("\n")).not.toContain("1845");
    expect(markdown).not.toContain("not yet in this site's deployments book");
  });
});

describe("who takes orders today", () => {
  it("names the team's runner as the only one, from the orders read", async () => {
    const { model, markdown } = await page<RunnersModel>(mainnet(), "/runners");
    expect(model.whoTakes).toContain(
      "Only the team's own runner (house wallet H1) has taken orders so far: the one order opened on the desk, read for this page.",
    );
    expect(model.whoTakes).toContain("No runner is bound to take an order, so an order can wait for one.");
    // What the chain shows says nothing of where or when the runner runs: that is the team's word.
    expect(model.whoTakes).not.toMatch(/around the clock|Railway|hosted/);
    expect(markdown).toContain("## Who takes orders today");
    expect(markdown).toContain(`What the chain shows: ${model.whoTakes}`);
    expect(markdown).toContain("## Who this is for");
    const hire = await page<HireIndexModel>(mainnet(), "/hire");
    expect(hire.model.whoTakes).toBe(model.whoTakes);
    expect(hire.markdown).toContain(`What the chain shows: ${model.whoTakes}`);
    expect(hire.markdown).toContain("## Who this is for");
  });

  it("states the team's word on its runner beside the chain's, dated 16 October 2026", async () => {
    const { model, markdown } = await page<RunnersModel>(mainnet(), "/runners");
    expect(model.runnerStatement?.heading).toBe("What the team says, 16 October 2026");
    expect(model.runnerStatement?.lines).toEqual([...RUNNER_STATEMENT.lines, RUNNER_STATEMENT.keeper]);
    const said = model.runnerStatement!.lines.join(" ");
    expect(said).toContain("runs on a hosted server (Railway), around the clock");
    expect(said).toContain("live since 15 October 2026, 14:18 UTC, and it signs as house wallet H1");
    expect(said).toContain("takes orders from any employer, one order at a time");
    expect(said).toContain("skill:research-report and skill:create-image");
    expect(said).toContain("at most one 0.5 IMD swarm fee a day, and posts bonds of at most 0.25 IMD");
    // The team's runner asks no margin since 15 October; the role in general still works for one.
    expect(said).toContain(
      "On 15 October 2026 it was set to ask for no margin: an order need only pay it the swarm's 0.5 IMD fee, and the gas is its own cost.",
    );
    // What came of it, said in the past: it served order 2.
    expect(said).toContain(
      "so that it could serve the first order that a rule of the team's, in launch C, opened",
    );
    expect(said).toContain(
      "On 16 October 2026 it took order 2, the first order a rule of the team's opened, and settled it on its receipt",
    );
    expect(said).toContain("The keeper (bots/keeper) is not hosted: it is run by hand.");
    expect(markdown).toContain("What the team says, 16 October 2026. A statement, not a reading:");
    // The chain's line comes first, then the team's word.
    expect(markdown.indexOf("What the chain shows:")).toBeLessThan(markdown.indexOf("What the team says"));
    // /hire carries the runner's lines; the keeper is said where runners are.
    const hire = await page<HireIndexModel>(mainnet(), "/hire");
    expect(hire.model.runnerStatement?.lines).toEqual([...RUNNER_STATEMENT.lines]);
    // Each job page says whether the team's runner takes its kind.
    const research = await page<HireTemplateModel>(mainnet(), "/hire/research");
    expect(research.model.runnerTakes).toContain("The team says its runner takes this kind of order");
    // With the limits the team gives: the order's bond, one at a time, one swarm fee a day.
    expect(research.model.runnerTakes).toContain(
      "when the order's bond is at most 0.25 IMD, one order at a time, and that it pays at most one 0.5 IMD swarm fee a day (16 October 2026)",
    );
    const audit = await page<HireTemplateModel>(mainnet(), "/hire/audit");
    expect(audit.model.runnerTakes).toContain("The team says its runner does not take this kind of order");
    expect(audit.markdown).toContain("An order of this kind waits for another runner.");
    // The judges page names it once, as the team's.
    const judges = await page<JudgesModel>(mainnet(), "/judges");
    expect(judges.model.notLive.join(" ")).toContain(RUNNER_STATEMENT.short);
  });

  it("says nothing of the team's runner on a book whose desk is not mainnet's", async () => {
    const world = testSources({ book: BOOKS.aAndB });
    expect((await page<RunnersModel>(world, "/runners")).model.runnerStatement).toBeNull();
    expect((await page<HireIndexModel>(world, "/hire")).model.runnerStatement).toBeNull();
    expect((await page<HireTemplateModel>(world, "/hire/audit")).model.runnerTakes).toBeNull();
    expect((await page<RunnersModel>(world, "/runners")).markdown).not.toContain("What the team says");
  });

  it("before the desk is launched, nobody", async () => {
    const { model } = await page<RunnersModel>(testSources(), "/runners");
    expect(model.whoTakes).toBe("Nobody yet: the hire desk is not launched yet.");
    expect(model.runnerStatement).toBeNull();
  });
});

describe("the corrected wordings", () => {
  it("/hire says who it is for without saying more than the escrow does", async () => {
    const said = HIRE_IS_FOR.join(" ");
    expect(said).not.toMatch(/only on proof|waits closed until its condition is seen true/);
    expect(HIRE_IS_FOR[0]).toContain(
      "the IMD is paid out on the job's receipt on chain or, only if the employer opted in when posting, on a bonded delivery claim nobody challenges for 24 hours. Otherwise it comes back.",
    );
    expect(HIRE_IS_FOR[1]).toContain(
      "a conditional order starts closed to runners. It does not open by itself",
    );
    expect(HIRE_IS_FOR[1]).toContain(
      "once its condition holds, anyone, a runner for instance, may open it with trigger(id)",
    );
    const { markdown } = await page<HireIndexModel>(mainnet(), "/hire");
    for (const line of HIRE_IS_FOR) expect(markdown).toContain(line);
  });

  it("claimTip: anyone may call it for an owner with no code or for Payroll; otherwise the owner must", async () => {
    expect(CLAIM_TIP_RULE).toContain(
      "Anyone may call claimTip when the seat's owner is an address with no code (an ordinary wallet) or Payroll itself.",
    );
    expect(CLAIM_TIP_RULE).toContain(
      "When the owner is any other address with code (a contract, or a wallet that has delegated to code), only the owner may call it;",
    );
    // The rule's two sentences do not contradict each other: no "only when" before the exception.
    expect(CLAIM_TIP_RULE).not.toContain("only when");
    expect(CLAIM_TIP_RULE).toContain("ContractOwnerMustClaim");
    // An owed tip on the order page says the rule in those words.
    const owed = mainnet({ ...orderOne(), [`${PAYROLL}:tipOwed`]: { abi: payrollAbi, result: IMD / 20n } });
    const { model } = await page<OrderModel>(owed, "/orders/1");
    expect(model.tips[0]?.words).toContain(
      "Anyone may call claimTip(51519) when the seat's owner is an address with no code (an ordinary wallet) or Payroll itself.",
    );
    expect(model.tips[0]?.words).not.toContain("a contract other than Payroll or a wallet with a delegation");
  });

  it("/seats/1049 keeps the seat pool and order 1's tip apart, and names the tip", async () => {
    const claim = FIRST.tipClaims[0]!;
    const world = mainnet({
      ...orderOne(),
      // As Payroll answered on 15 October 2026: the seat pool has paid seat 1049 nothing.
      [`${PAYROLL}:seatClaimable`]: { abi: payrollAbi, result: 7_500_000_000_000n },
      [`${PAYROLL}:seatPaid`]: { abi: payrollAbi, result: 0n },
    });
    const { model, markdown } = await page<SeatModel>(world, "/seats/1049");
    expect(model).toMatchObject({ paidImd: "0", tipsPaidImd: "0.05" });
    expect(model.tipsPaid).toEqual([
      {
        orderId: 1,
        agentId: "51519",
        amountImd: "0.05",
        paidTo: claim.paidTo,
        at: "15 Oct 2026, 12:56 UTC",
        txUrl: `https://etherscan.io/tx/${claim.tx.hash}`,
      },
    ]);
    expect(markdown).toContain("| Paid from the seat pool so far | 0 IMD |");
    expect(markdown).toContain("| Tips paid to its owner (orders on record here) | 0.05 IMD |");
    expect(markdown).not.toContain("Paid to this seat");
    expect(markdown).toContain(
      `On 15 Oct 2026, 12:56 UTC, Payroll paid order 1's 0.05 IMD tip for agent 51519 to ${claim.paidTo}, the seat's owner then.`,
    );
    expect(markdown).toContain("not from the seat pool, so the seat pool figure leaves tips out");
    expect(markdown).toContain(claim.tx.hash);
    // Another seat lists no tip, and a book whose desk is not the one read lists none either.
    const other = await page<SeatModel>(world, "/seats/1998");
    expect(other.model).toMatchObject({ tipsPaid: [], tipsPaidImd: null });
    expect(other.markdown).not.toContain("Tips paid to");
    expect(pinnedTipClaims(null, 1049)).toEqual([]);
    expect(pinnedTipClaims(BELL, 1049)).toEqual([]);
  });

  it("/seats/1978 lists order 2's tip, to the wei", async () => {
    const claim = SECOND.tipClaims[0]!;
    const world = mainnet({
      ...orderOne(),
      [`${PAYROLL}:seatClaimable`]: { abi: payrollAbi, result: 0n },
      [`${PAYROLL}:seatPaid`]: { abi: payrollAbi, result: 0n },
    });
    const { model, markdown } = await page<SeatModel>(world, "/seats/1978");
    expect(model.tipsPaidImd).toBe("0.0280025");
    expect(model.tipsPaid).toEqual([
      {
        orderId: 2,
        agentId: "52142",
        amountImd: "0.0280025",
        paidTo: claim.paidTo,
        at: "16 Oct 2026, 10:46 UTC",
        txUrl: `https://etherscan.io/tx/${claim.tx.hash}`,
      },
    ]);
    expect(markdown).toContain(
      "each read on the day its order was read (15 October 2026 and 16 October 2026)",
    );
    expect(markdown).toContain(`Payroll paid order 2's 0.0280025 IMD tip for agent 52142 to ${claim.paidTo}`);
    expect(markdown).toContain("| Tips paid to its owner (orders on record here) | 0.0280025 IMD |");
    expect(markdown).toContain(claim.tx.hash);
  });
});

/**
 * Questions and JobsReport as mainnet answered on 15 October 2026: one answered round on each house
 * feed, both daily meters at 0.005 IMD against a cost of 0.55 IMD, and print no. 1. The round logs
 * are out of the RPC's reach, as they are on mainnet: only the kept history can name them.
 */
function launchAToday(): Views {
  const Q = BOOK.questions.address as string;
  const J = BOOK.jobsReport.address as string;
  const at = (iso: string) => BigInt(Date.parse(iso) / 1000);
  const rounds = new Map(
    ROUND_HISTORY.rounds.map((r) => {
      const value =
        r.feed === "payrolls"
          ? 112n * IMD
          : r.feed === "hires"
            ? 223n
            : 4207367867089486644132445380197544786976n;
      const window =
        r.feed === "payrolls"
          ? [26_176_608n, 26_183_607n]
          : r.feed === "hires"
            ? [26_176_610n, 26_183_609n]
            : [26_133_211n, 26_183_610n];
      return [r.feedId.toLowerCase(), { r, value, window }] as const;
    }),
  );
  const of = (id: unknown) => rounds.get(String(id).toLowerCase());
  return {
    [`${Q}:feedCount`]: { abi: questionsAbi, result: 3n },
    [`${Q}:INTAKE`]: { abi: questionsAbi, result: MAINNET.INTAKE },
    [`${Q}:feedAt`]: {
      abi: questionsAbi,
      result: ([index]: readonly unknown[]) => ROUND_HISTORY.rounds[Number(index)]?.feedId,
    },
    [`${Q}:feedState`]: {
      abi: questionsAbi,
      result: ([id]: readonly unknown[]) => {
        const feed = of(id);
        if (!feed) return undefined;
        const daily = feed.r.feed !== "employers";
        return {
          exists: true,
          rounds: 1n,
          latestRound: 1n,
          lastRequestBlock: BigInt(feed.r.opened.block),
          lastToBlock: feed.window[1],
          failStreak: 0,
          pending: false,
          pendingRequestId: `0x${"0".repeat(64)}`,
          nextRequestBlock: BigInt(feed.r.opened.block + (daily ? 7_000 : 49_000)),
          meterBalance: daily ? 5n * 10n ** 15n : 0n,
          totalShares: daily ? 5n * 10n ** 15n : 55n * 10n ** 16n,
          cost: 55n * 10n ** 16n,
          blocker: daily ? REQUEST_BLOCKER.MeterTooLow : REQUEST_BLOCKER.TooSoon,
        };
      },
    },
    [`${Q}:latest`]: {
      abi: questionsAbi,
      result: ([id]: readonly unknown[]) => {
        const feed = of(id);
        return feed ? [feed.value, ...feed.window, 1n, at(feed.r.answered.at)] : [0n, 0n, 0n, 0n, 0n];
      },
    },
    [`${Q}:roundOf`]: {
      abi: questionsAbi,
      result: ([id]: readonly unknown[]) => {
        const feed = of(id);
        return feed
          ? [ROUND_STATUS.Answered, feed.value, ...feed.window, at(feed.r.answered.at)]
          : [0, 0n, 0n, 0n, 0n];
      },
    },
    [`${Q}:roundRequest`]: {
      abi: questionsAbi,
      result: ([id]: readonly unknown[]) => {
        const feed = of(id);
        return [
          feed?.r.opened.intakeRequestId ?? `0x${"0".repeat(64)}`,
          `0x${"8".repeat(64)}`,
          `0x${"9".repeat(64)}`,
          at(feed?.r.opened.at ?? "1970-01-01T00:00:00Z"),
        ];
      },
    },
    [`${J}:latestPrints`]: {
      abi: jobsReportAbi,
      result: [
        {
          amount: 112n * IMD,
          count: 223n,
          fromBlock: 26_176_608n,
          toBlock: 26_183_607n,
          payrollsRound: 1n,
          hiresRound: 1n,
        },
      ],
    },
    [`${J}:summary`]: {
      abi: jobsReportAbi,
      result: {
        prints: 1n,
        total: 112n * IMD,
        counts: 1n,
        totalCount: 223n,
        bestAmount: 112n * IMD,
        bestIndex: 0n,
        streak: 1n,
        longestStreak: 1n,
        payrollsRead: 1n,
        hiresRead: 1n,
        pairedPrints: 1n,
        pairedCounts: 1n,
        crowns: 1n,
        latestCrownedRound: 1n,
      },
    },
  };
}

describe("launch A's history on mainnet's book", () => {
  const world = () =>
    testSources({ book: DEPLOYMENT_BOOK, chain: { views: { ...orderOne(), ...launchAToday() } } });

  it("/questions names each first round's two transactions, and says the employers answer came by the callback", async () => {
    const { model, markdown } = await page<QuestionsModel>(world(), "/questions");
    const rows = Object.fromEntries(model.houseFeeds.map((f) => [f.name, f.live?.roundRows[0]]));
    for (const r of ROUND_HISTORY.rounds) {
      expect(rows[r.feed]?.openedTxUrl, r.feed).toBe(`https://etherscan.io/tx/${r.opened.hash}`);
      expect(rows[r.feed]?.settledTxUrl, r.feed).toBe(`https://etherscan.io/tx/${r.answered.hash}`);
    }
    expect(rows.employers?.delivered).toBe("the Intake's callback");
    expect(rows.payrolls?.delivered).toBe(`submit, by ${H1.toLowerCase()}`);
    expect(model.houseFeeds.find((f) => f.name === "employers")?.live?.latest).toContain(
      "delivered by the Intake's callback",
    );
    expect(markdown).toContain(
      `[answered](https://etherscan.io/tx/${ROUND_HISTORY.rounds[2]!.answered.hash})`,
    );
    expect(model.eventsCoverage).toContain("The first round of each house feed is older than that");
  });

  it("/jobs-report is dated by its print, and says what the next print waits for", async () => {
    const { model, markdown } = await page<JobsReportModel>(world(), "/jobs-report");
    expect(model.official.printed).toBe(true);
    expect(model.releaseNumber).toBe("HW-RJR-2026-10-13-O");
    expect(model.releaseDay).toBe("Tuesday, 13 October 2026");
    expect(model.schedule?.lastPrintWords).toBe("The last print, no. 1, was made on 13 Oct 2026, 13:10 UTC.");
    expect(model.schedule?.lastPrintTxUrl).toBe(
      `https://etherscan.io/tx/${PRINT_HISTORY.prints[0]!.tx.hash}`,
    );
    expect(model.schedule?.meter).toEqual({ holdsImd: "0.005", costImd: "0.55", shortImd: "0.545" });
    expect(model.schedule?.nextWords).toContain("a new request needs 0.55 IMD on its meter");
    expect(model.schedule?.nextWords).toContain("The meter holds 0.005 IMD, read for this page");
    expect(markdown).toContain("Release HW-RJR-2026-10-13-O · Tuesday, 13 October 2026");
  });

  it("/judges counts the Intake requests from the contract itself", async () => {
    const { model } = await page<JudgesModel>(world(), "/judges");
    const intake = model.integration.find((r) => r.primitive.startsWith("Intake, version 2"));
    expect(intake?.usage).toMatchObject({ count: "3", reason: null });
    expect(model.thirtySeconds[3]).toContain("10 of 10 contracts in this site's deployments book");
  });
});

/** Endowments as mainnet answered on 15 October 2026: one endowment, the drill, 1 IMD staked. */
function endowmentsToday(extra: { id: number; creator: string }[] = []): Views {
  const E = BOOK.endowments.address as string;
  const payrolls = HOUSE_FEEDS.payrolls.id;
  const count = 1 + extra.length;
  return {
    [`${E}:endowmentCount`]: { abi: endowmentsAbi, result: BigInt(count) },
    [`${E}:METER_RUNWAY`]: { abi: endowmentsAbi, result: 30n },
    [`${E}:nextStakeBlock`]: { abi: endowmentsAbi, result: 26_198_353n },
    [`${E}:pendingTotal`]: { abi: endowmentsAbi, result: 0n },
    [`${E}:vaultHold`]: { abi: endowmentsAbi, result: false },
    [`${E}:endowment`]: {
      abi: endowmentsAbi,
      result: ([id]: readonly unknown[]) =>
        Number(id) === 1
          ? [1, payrolls, ZERO, IMD, 0n, 125_372_227_342_392_760_541_075n, 0n]
          : [3, `0x${"0".repeat(64)}`, "0x0000000000000000000000000000000000000002", IMD, IMD, 0n, 0n],
    },
    [`${E}:harvestable`]: { abi: endowmentsAbi, result: 0n },
  };
}

/** A `Created` log of Endowments, as a node would serve it. */
function createdLog(
  id: number,
  creator: string,
  block: number,
): NonNullable<FakeChainOptions["logs"]>[string][number] {
  const topics = encodeEventTopics({
    abi: endowmentsAbi,
    eventName: "Created",
    args: { id: BigInt(id), creator: creator as Hex },
  }) as Hex[];
  return {
    address: (BOOK.endowments.address as string).toLowerCase(),
    topics,
    data: encodeAbiParameters(
      [{ type: "uint8" }, { type: "bytes32" }, { type: "address" }],
      [3, `0x${"0".repeat(64)}`, "0x0000000000000000000000000000000000000002"],
    ),
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: `0x${block.toString(16).padStart(64, "0")}`,
    logIndex: "0x0",
  } as NonNullable<FakeChainOptions["logs"]>[string][number];
}

describe("launch C's pages on mainnet's book", () => {
  it("/endowments lists endowment 1, read live, as the team's own drill (HOUSE), with its transactions", async () => {
    const world = testSources({ book: DEPLOYMENT_BOOK, chain: { views: endowmentsToday() } });
    const { model, markdown } = await page<EndowmentsModel>(world, "/endowments");
    expect(model.launched).toBe(true);
    expect(model.count).toBe(1);
    expect(model.rows).toHaveLength(1);
    const row = model.rows[0]!;
    expect(row).toMatchObject({
      id: 1,
      kind: "Meter",
      principalImd: "1",
      harvestedImd: "0",
      origin: "HOUSE",
    });
    expect(row.target).toBe("the meter of the payrolls feed");
    expect(row.originWords).toContain(
      `HOUSE: created by house wallet W1 (${HOUSE_WALLETS[0]!.address.toLowerCase()})`,
    );
    expect(row.originWords).toContain("the team's own drill, with the team's own IMD");
    expect(row.trail.map((s) => s.label)).toEqual([
      "Created",
      "Seed staked",
      "Deposited",
      "Staked",
      "Withdrawn",
    ]);
    for (const step of ENDOWMENT_HISTORY.entries[0]!.trail) {
      expect(markdown).toContain(`https://etherscan.io/tx/${step.tx.hash}`);
    }
    expect(markdown).toContain("### Endowment 1: its transactions");
    // It is live: the deposit form sends to the address in the book.
    expect(markdown).toContain(`Sent to Endowments at ${BOOK.endowments.address}.`);
  });

  it("an endowment someone else created is OUTSIDE, and one whose creator is out of reach is not guessed", async () => {
    const outsider = "0x00000000000000000000000000000000000000aa";
    const E = BOOK.endowments.address as string;
    const world = testSources({
      book: DEPLOYMENT_BOOK,
      chain: {
        // A head a little after launch C, so that endowment 2's Created log is within reach.
        head: 26_199_100,
        views: endowmentsToday([
          { id: 2, creator: outsider },
          { id: 3, creator: outsider },
        ]),
        logs: { [E]: [createdLog(2, outsider, 26_198_400)] },
      },
    });
    const { model } = await page<EndowmentsModel>(world, "/endowments");
    const byId = Object.fromEntries(model.rows.map((r) => [r.id, r]));
    expect(byId[1]?.origin).toBe("HOUSE");
    expect(byId[2]?.origin).toBe("OUTSIDE");
    expect(byId[2]?.originWords).toBe(`OUTSIDE: created by ${outsider}.`);
    expect(byId[3]?.origin).toBeNull();
    expect(byId[3]?.originWords).toContain("could not be read");
  });

  it("/judges counts the drill as HOUSE use, and no rule as made", async () => {
    const rules = BOOK.rules.address as string;
    const world = testSources({
      book: DEPLOYMENT_BOOK,
      chain: {
        views: { ...orderOne(), ...endowmentsToday(), [`${rules}:ruleCount`]: { abi: rulesAbi, result: 0n } },
      },
    });
    const { model } = await page<JudgesModel>(world, "/judges");
    const line = model.notLive.find((l) =>
      l.startsWith("No use of our contracts by anyone outside the team"),
    )!;
    expect(line).toContain("no standing rule has been created");
    expect(line).toContain("the one endowment read was created by our own wallet W1");
    expect(model.thirtySeconds[4]).toContain(
      "nobody outside the team has used the contracts in what this page read",
    );
  });
});

describe("what a mock judging found, on mainnet's book", () => {
  it("/judges gives what our contracts and IdentityMD's did together, each with its transaction", async () => {
    const { model, markdown } = await page<JudgesModel>(mainnet(), "/judges");
    expect(model.provenOnChain.map((p) => p.tx)).toEqual([
      "0x9fea43c9e0fd05c8c55b977284e6e543410f71c74363e5448747b1b482056b06",
      "0xfed277e7525f289f8e8bad0333148c8823f42c779836280189ff874500de051b",
      "0x9edc8ba2ae4cfbabe95d6ca11e7a93f349f09729b7a699d575eac6f8466e1fe8",
      "0x9f790aae9db07625dc86b6c107d7ed55b43f96ba5bfaf5b02c64269ab963e37b",
      "0xd7a75e9c71968ba67badb671c96103a55364d78b563e6b6561a08b98603f6273",
    ]);
    const [paid, delivered, tip, fire, secondTip] = model.provenOnChain;
    // A standing rule fired a hire on a feed answer, and the team's own wallet sent it.
    expect(fire?.title).toBe("A standing rule read a Standing Question and hired the swarm");
    expect(fire?.words).toContain("house wallet H1 called Rules.fire(1) by hand");
    expect(fire?.words).toContain(
      "The rule's creator, the wallet that fired it and the runner were the team's own (HOUSE).",
    );
    expect(fire?.commands.map((c) => c.command).join("\n")).toContain(
      `cast call ${RULES} "statusOf(uint256)(uint8)" 1`,
    );
    expect(secondTip?.title).toBe(
      "A tip followed the agent to its seat's owner: claimTip(52142) → bindingOf → seat #1978 → ownerOf → 0x5C7d92736A6Db05b85eF1aEBBc3190f05cff3008",
    );
    expect(secondTip?.words).toContain("not outside use of HELP WANTED");
    expect(secondTip?.commands[0]?.comment).toContain("it read seat 1978 on 16 October 2026");
    expect(paid?.title).toBe("Our Questions contract paid IdentityMD's Intake, version 2");
    expect(paid?.words).toContain("A contract, not a wallet, bought the work.");
    expect(delivered?.title).toBe("IdentityMD's callback delivered an answer to our contract");
    expect(delivered?.words).toContain(`IdentityMD's Intake writer (${MAINNET.INTAKE_WRITER})`);
    expect(tip?.title).toBe(
      "A tip followed the agent to its seat's owner: claimTip(51519) → bindingOf → seat #1049 → ownerOf → 0x6eE77E931C6154E4752C5Bf832Ce51f7897f105A",
    );
    expect(tip?.commands.map((c) => c.command).join("\n")).toContain(
      `cast call ${MAINNET.SEAT_ADAPTER} "bindingOf(uint256)((uint8,address,uint256))" 51519`,
    );
    expect(tip?.commands.map((c) => c.command).join("\n")).toContain(
      `cast call ${MAINNET.SEATS} "ownerOf(uint256)(address)" 1049`,
    );
    // Each tip's log note names its own agent, seat, owner and amount, so the two do not read alike.
    expect(tip?.commands[2]?.comment).toBe(
      "The claim's logs: TipClaimed(agent, seat, owner, amount) for agent 51519, seat #1049, owner 0x6eE77E931C6154E4752C5Bf832Ce51f7897f105A, 0.05 IMD; and the IMD transfer",
    );
    expect(secondTip?.commands[2]?.comment).toContain(
      "for agent 52142, seat #1978, owner 0x5C7d92736A6Db05b85eF1aEBBc3190f05cff3008",
    );
    // The header job's commands are printed once, beside its proof; Reproduce points to them.
    const headerBlock = model.reproduce.find((block) => block.title === "Check the header job");
    expect(headerBlock).toMatchObject({ commands: null, see: "#proven-header" });
    expect(headerBlock?.note).toContain(`Its ${model.headerJob.commands.length} commands are printed once`);
    for (const c of model.headerJob.commands) {
      expect(markdown.split(c.command).length - 1).toBe(1);
    }
    expect(markdown).toContain("### 4. Our contracts and IdentityMD's, working together on mainnet");
    // The callback's answer is no longer said to be shown only in a test.
    expect(model.feedProofs.limit).toContain(
      "On chain it has been shown since: on 13 Oct 2026, 17:18 UTC IdentityMD's Intake writer delivered the employers feed's answer to our Questions contract through the Intake's own callback",
    );
    const attestations = model.integration.find((r) => r.primitive === "Oracle attestations")!;
    expect(attestations.proofs.at(-1)).toEqual({
      label: "employers: answer delivered by the Intake's callback",
      url: "https://etherscan.io/tx/0xfed277e7525f289f8e8bad0333148c8823f42c779836280189ff874500de051b",
    });
    // Every bindingOf on the page asks about order 1's agent.
    expect(markdown).not.toContain('"bindingOf(uint256)((uint8,address,uint256))" 52211');
  });

  it("/judges proves order 2, a research report, through WorkProof as well, free, with the agent its record names", async () => {
    const { model, markdown } = await page<JudgesModel>(mainnet(), "/judges");
    const second = model.live?.proveSecond;
    expect(second?.commands[0]?.command).toContain(SECOND.prove.recordHash.slice(2));
    expect(second?.commands[1]?.command).toContain(
      `cast call ${BOOK.workProof.address} "prove(bytes16,bytes,uint256)`,
    );
    expect(second?.commands[1]?.command).toContain(" 0x42f26c64eea946f2822a33547ec18abf ");
    expect(second?.commands[1]?.command).toMatch(/report-record\.json \| tr -d '\\n'\)" 85 --rpc-url/);
    expect(second?.answer).toBe(
      `(${SECOND.prove.recordHash}, ${SECOND.prove.kindHash}, ${SECOND.prove.headHash}, ${SECOND.prove.specHash}, ${SECOND.prove.stateHash}, [52142])`,
    );
    expect(second?.note).toContain(
      "Rule 1 on our Rules contract ordered it, and the team's runner, house wallet H1, paid IdentityMD for it (HOUSE).",
    );
    expect(second?.note).toContain("What prove answered on 16 October 2026");
    expect(markdown).toContain("### The same proof for order 2, a research report");
  });

  it("the Doorbell: 25 rings, all HOUSE, what it needs to hire again, and that no watcher is running", async () => {
    expect(pinnedRings(BELL)).toBe(RING_HISTORY);
    expect(RING_HISTORY.byRinger).toEqual([{ ringer: H1.toLowerCase(), rings: 25 }]);
    expect(RING_HISTORY.last.hash).toBe(FIRST.trail[0]!.tx.hash);
    expect(
      pinnedRings(testSources({ book: BOOKS.aAndB }).sources.deployments.contracts.doorbell.address),
    ).toBeNull();

    const world = mainnet();
    const rules = await page<RulesNewModel>(world, "/rules/new");
    expect(rules.model.doorbellState?.ringers).toMatchObject({ read: 25, pinned: 25 });
    const facts = rules.model.doorbellFacts.join("\n");
    expect(rules.model.doorbellFacts[0]).toBe(
      "To hire again it needs 1 IMD and 25 more rings: it holds 0 IMD, and one order escrows 1 IMD.",
    );
    expect(facts).toContain(
      "The contract counts every ring (rings()), and each ring's Rang log names who rang.",
    );
    // Who rang has its own heading under the facts, with the newest outside ringers (none yet).
    const who =
      "Of the 25 rings whose log was read (blocks 26,184,821 to 26,184,854; the logs of the first 25 are older than the public RPC serves, so they were read from the chain on 15 October 2026 and are kept with this site), 25 were sent by our own wallets (HOUSE) and 0 by others (OUTSIDE).";
    expect(rules.model.doorbellWho).toEqual({
      words: who,
      listWords:
        "No ring from outside the team has been read yet. The first will be listed here, with its address and its transaction.",
      outside: [],
    });
    expect(rules.markdown).toContain(`### Who rang\n\n${who}`);
    expect(facts).not.toContain(who);
    expect(facts).toContain("No watcher is running");
    expect(facts).not.toMatch(/nothing is lost|lose nothing/i);

    const judges = await page<JudgesModel>(world, "/judges");
    const group = judges.model.live?.groups.find((g) => g.title === "The Doorbell's 25 rings");
    expect(group?.rows.map((r) => r.tx)).toEqual([RING_HISTORY.first.hash, RING_HISTORY.last.hash]);
    expect(group?.rows[0]?.what).toContain("house wallet H1 (25 rings): all HOUSE, none OUTSIDE");
    expect(judges.model.notLive).toContain(NO_WATCHER);
    expect(judges.model.notLive.join("\n")).toContain(
      "the 25 rings of the Doorbell whose log was read were all sent by our own wallets",
    );
    expect(judges.model.notLive.join("\n")).not.toContain("there is no history of rings");

    const wire = await page<WireModel>(world, "/");
    expect(wire.model.actions.ring.words).toContain("To hire again it needs 1 IMD and 25 more rings");
    // The front page's band says who rang, OUTSIDE first, and where the split comes from.
    const band = wire.model.actions.ring.doorbell!;
    expect(band.split).toEqual({ read: 25, house: 25, outside: 0 });
    expect(band.tally).toEqual([
      { label: "rings from anyone else (OUTSIDE)", value: "0" },
      { label: "rings from the team's own wallets (HOUSE)", value: "25" },
    ]);
    expect(band.splitWords).toBe(
      "Counted from the Rang log of each of the 25 rings read, which names who rang: HOUSE is the team's own wallets, OUTSIDE is anyone else.",
    );
    expect(wire.markdown).toContain("| Rings from anyone else (OUTSIDE) | 0 |");
    expect(wire.markdown).toContain("| Rings from the team's own wallets (HOUSE) | 25 |");
    expect(wire.markdown).toContain(band.splitWords);
    expect(wire.model.actions.ring.words).toContain(
      "No watcher is running: the team runs nothing that would challenge an untrue one.",
    );
    expect(await llmsTxt(ctxFor(world))).toContain(NO_WATCHER);
  });

  it("links the picture the Doorbell paid for, from the front page and from order 1", async () => {
    const world = mainnet();
    const url = `https://explorer.imd.fun/jobs/${FIRST.jobId}`;
    const wire = await page<WireModel>(world, "/");
    expect(wire.model.lead?.picture).toEqual({ label: "See the picture the Doorbell paid for", url });
    expect(wire.markdown).toContain(`See the picture the Doorbell paid for: [${url}](${url})`);
    const order = await page<OrderModel>(world, "/orders/1");
    expect(order.model.picture).toEqual({ label: "See the picture the Doorbell paid for", url });
    expect(order.markdown).toContain("## The work");
    expect(order.markdown).toContain("this site serves no copy");
  });

  it("/llms.txt lists what was done together, order 2's proof, and the bindingOf of agent 51519", async () => {
    const text = await llmsTxt(ctxFor(mainnet()));
    const proven = text.slice(text.indexOf("## Proven on the live system"), text.indexOf("## Addresses"));
    expect(proven).toContain(
      "Our Questions contract paid IdentityMD's Intake, version 2: on 13 Oct 2026, 12:37 UTC",
    );
    expect(proven).toContain(
      "https://etherscan.io/tx/0x9fea43c9e0fd05c8c55b977284e6e543410f71c74363e5448747b1b482056b06",
    );
    expect(proven).toContain(
      "IdentityMD's callback delivered an answer to our contract: on 13 Oct 2026, 17:18 UTC",
    );
    // The callback answer is one Questions stored, not one of the three a house wallet bought.
    expect(proven).toContain(
      "One of the answers Questions stored came by the Intake's own callback, as said above.",
    );
    expect(proven).not.toContain("One of them came by");
    expect(proven).toContain(
      "claimTip(51519) → the seat Adapter's bindingOf(51519) → seat #1049 → the Seats token's ownerOf(1049) → 0x6eE77E931C6154E4752C5Bf832Ce51f7897f105A",
    );
    expect(proven).toContain(
      "https://etherscan.io/tx/0x9edc8ba2ae4cfbabe95d6ca11e7a93f349f09729b7a699d575eac6f8466e1fe8",
    );
    // Order 2, opened by a rule, with its prove command and its tip.
    expect(proven).toContain(
      "Order 2 on the hire desk, opened by rule 1 of our Rules contract when launch A's hires feed read 223",
    );
    expect(proven).toContain(
      "The rule was created and fired, by hand, by house wallet H1, and the runner was H1 (HOUSE).",
    );
    expect(proven).toContain(
      "https://etherscan.io/tx/0x35bb49cc9576a425b94a94137e8fe24e496017cc154456eeee255d22fc020516",
    );
    expect(proven).toContain(
      ` 0x42f26c64eea946f2822a33547ec18abf "0x$(xxd -p report-record.json | tr -d '\\n')" 85 `,
    );
    expect(proven).toContain(
      "claimTip(52142) → the seat Adapter's bindingOf(52142) → seat #1978 → the Seats token's ownerOf(1978) → 0x5C7d92736A6Db05b85eF1aEBBc3190f05cff3008",
    );
    expect(proven).toContain("not outside use of HELP WANTED");
    expect(proven).toContain(`"bindingOf(uint256)((uint8,address,uint256))" 51519`);
    expect(proven).not.toContain(`"bindingOf(uint256)((uint8,address,uint256))" 52211`);
    expect(proven).toContain(`cast call ${MAINNET.SEATS} "ownerOf(uint256)(address)" 1049`);
    expect(proven).not.toMatch(BANNED);
  });

  it("no answer of the pipeline's findings says nothing is lost where the claimed path says otherwise", () => {
    const said = DESK_ADAPTATION.findings.map((f) => f.done).join(" ");
    expect(said).not.toMatch(/lose nothing|nothing is lost|No IMD is lost/);
    expect(DESK_ADAPTATION.findings.find((f) => f.id === "be85d51c")?.done).toContain(
      "a claim nobody challenges within 24 hours is paid from the pot (L1)",
    );
  });
});
