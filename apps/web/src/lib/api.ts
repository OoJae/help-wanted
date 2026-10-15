/**
 * The small JSON API under `/api/v1/`. GET only, open CORS, and every answer comes from the same
 * cached models as the pages, so calling it costs the upstreams nothing extra.
 */
import { encodeFunctionData } from "viem";
import { LAUNCH_KEYS, NOT_LAUNCHED, type ContractKey } from "~/config/deployments";
import { HOUSE_WALLETS, houseSet } from "~/config/house";
import { HOUSE_FEED_NAMES, MAINNET } from "@help-wanted/shared";
import { IMD_LINK, REFERENCE_JOB, etherscanTx } from "~/config/chain";
import { LAUNCH_PRS } from "~/config/history";
import { AUDITS, DESK_ADAPTATION, FEED_PROOFS, PUBLIC_SOURCE } from "~/config/proofs";
import { HEADER_JOB } from "~/data";
import { castCommand, castReadCommand, flowById, FLOWS, initialValues } from "~/flows";
import { allContracts, launchIsLive, launchRecorded, PUBLIC_RPC } from "~/models/common";
import { addressesOf } from "~/models/flowPreview";
import { judgesPage, type JudgesModel } from "~/models/judges";
import type { QuestionsModel } from "~/models/questions";
import type { LoadContext } from "~/models/types";
import { releaseTally } from "~/models/jobsReport";
import { ringsByOrigin } from "~/models/money";
import { runVerify, type VerifyJobModel } from "~/models/verify";
import { UpstreamBusyError, UpstreamDownError, messageOf } from "./cache";
import { errorResponse, jsonResponse, OPEN_CORS } from "./http";
import { parseHash, parseJobId } from "./ids";
import { API_ROUTES } from "./siteDocs";
import { fenceUntrusted, loadPath } from "./twins";

function tooMany(retryAfterSeconds: number): Response {
  return errorResponse(429, "too_many_requests", `Slow down: try again in ${retryAfterSeconds} s.`, {
    "retry-after": String(retryAfterSeconds),
  });
}

/** Serves a page's model as an API answer. */
async function fromPage(
  path: string,
  ctx: LoadContext,
  pick?: (model: unknown) => unknown,
): Promise<Response> {
  const loaded = await loadPath(path, ctx);
  if (!loaded) return errorResponse(404, "not_found", `Nothing at ${path}.`);
  return jsonResponse(
    {
      generatedAt: ctx.now.toISOString(),
      sampleData: ctx.sources.env.sampleData,
      // Third-party text (job texts, objectives, oracle questions) is fenced as in the JSON twins.
      ...(fenceUntrusted(pick ? pick(loaded.model) : loaded.model) as object),
    },
    { status: loaded.status },
  );
}

export async function handleApi(path: string, _request: Request, ctx: LoadContext): Promise<Response> {
  const parts = path.split("/").filter(Boolean);
  const [head, second] = parts;
  const { sources } = ctx;
  try {
    if (parts.length === 0) {
      return jsonResponse({
        name: "HELP WANTED API",
        version: "v1",
        note: "GET only. Open CORS. Amounts ending in Wei are IMD base units as decimal strings.",
        routes: API_ROUTES,
        twins: "Every page also answers at <path>.json and <path>.md.",
      });
    }

    if (head === "health" && parts.length === 1) {
      return jsonResponse(
        { ok: true, now: ctx.now.toISOString() },
        { headers: { "cache-control": "no-store" } },
      );
    }

    if (head === "status" && parts.length === 1) return await status(ctx);

    if (head === "deployments" && parts.length === 1) {
      return jsonResponse({
        chainId: sources.deployments.chainId,
        launchedCount: sources.deployments.launchedCount,
        contracts: Object.values(sources.deployments.contracts),
        launches: Object.values(sources.deployments.launches),
        note: "address null means not launched yet. Filled in from the deployments book of the shared package after each launch.",
      });
    }

    if (head === "integration" && parts.length === 1) {
      return fromPage("/judges", ctx, (model) => {
        const m = model as JudgesModel;
        return { rows: m.integration, contracts: m.contracts };
      });
    }

    if (head === "evidence" && parts.length === 1) return await evidence(ctx);

    if (head === "feeds" && parts.length === 1) {
      return fromPage("/questions", ctx, (model) => {
        const m = model as QuestionsModel;
        return {
          contract: m.questions,
          launched: m.launched,
          feedCount: m.feedCount,
          houseFeeds: m.houseFeeds,
          otherFeeds: m.otherFeeds,
          tipRule: m.tipRule,
          waits: m.waits,
          error: m.feedsError,
          note: m.launched
            ? null
            : `Questions is ${NOT_LAUNCHED}; no feed exists. Each house feed is given with its exact text and the one answer the live oracle has attested for it.`,
        };
      });
    }

    if (head === "swarm" && parts.length === 1) {
      const health = await sources.api.health();
      return jsonResponse({
        ...health.value,
        fetchedAt: new Date(health.fetchedAt).toISOString(),
        stale: health.stale,
        source: `${sources.api.baseUrl}/health`,
      });
    }

    if (head === "jobs" && parts.length === 1) {
      return fromPage("/", ctx, (model) => {
        const m = model as { jobs: unknown; sources: unknown };
        return { jobs: m.jobs, sources: m.sources };
      });
    }

    if (head === "verify" && second && parts.length === 2) {
      const jobId = parseJobId(second);
      if (!jobId) return errorResponse(400, "bad_job_id", "A job id is a UUID, or 32 hex characters.");
      const loaded = await loadPath(`/verify/${jobId}`, ctx);
      if (!loaded) return errorResponse(404, "not_found", "No such job id.");
      const model = loaded.model as VerifyJobModel;
      // One visitor may start only so many checks of jobs nobody has looked at lately.
      if (model.limited) return tooMany(model.limited.retryAfterSeconds);
      // A check that could not run is this server failing to answer, not a finding about the job.
      const unchecked = model.result.verdict === "unchecked";
      return jsonResponse(
        // The job's objective is third-party text, fenced as in the JSON twin.
        { generatedAt: ctx.now.toISOString(), ...(fenceUntrusted(loaded.model) as object) },
        unchecked ? { status: 503, headers: { "retry-after": "30", "cache-control": "no-store" } } : {},
      );
    }

    if (head === "work-records" && second && parts.length === 2) {
      const hash = parseHash(second.replace(/\.json$/, ""));
      if (!hash) return errorResponse(400, "bad_hash", "A record hash is 64 hex characters, without 0x.");
      // A record this server already holds costs nothing to hand out. One it would have to fetch
      // counts against the visitor's allowance of new checks, like a check of a new job.
      if (ctx.visitor && !sources.api.holdsRecord(hash)) {
        const slot = sources.freshChecks.take(ctx.visitor);
        if (!slot.ok) return tooMany(Math.ceil(slot.retryAfterMs / 1000));
      }
      const record = await sources.api.workRecord(hash);
      if (!record) {
        return errorResponse(404, "unknown_record", "IdentityMD serves no record under that hash.");
      }
      // The bytes are passed on untouched, and only ever bytes this server has itself checked to
      // hash to the hash in the path. A reader hashes them again and compares with the chain, so
      // this server does not need to be trusted; but it never hands out, let alone marks as
      // unchanging, anything it has not checked.
      return new Response(record.bytes as unknown as BodyInit, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
          "x-record-source": `${sources.api.baseUrl}/work-records/${hash.slice(2)}.json`,
          "x-record-origin": record.origin,
          ...OPEN_CORS,
        },
      });
    }

    if (head === "jobs-report" && second === "latest" && parts.length === 2)
      return fromPage("/jobs-report", ctx);
    if (head === "questions" && parts.length === 1) return fromPage("/questions", ctx);
    if (head === "orders" && parts.length === 1) return fromPage("/orders", ctx);
    if (head === "orders" && second && parts.length === 2) return fromPage(`/orders/${second}`, ctx);
    if (head === "pots" && parts.length === 1) return fromPage("/pots", ctx);
    if (head === "pots" && second && parts.length === 2) return fromPage(`/pots/${second}`, ctx);
    if (head === "seats" && second && parts.length === 2) return fromPage(`/seats/${second}`, ctx);
    if (head === "pnl" && parts.length === 1) return fromPage("/company", ctx);

    if (head === "flows" && parts.length === 1) {
      return jsonResponse({
        flows: FLOWS.map((f) => ({
          id: f.id,
          title: f.title,
          contract: f.contract,
          action: f.action,
          fields: f.fields({}),
          plan: `/api/v1/flows/${f.id}`,
        })),
      });
    }

    if (head === "flows" && second && parts.length === 2) {
      const flow = flowById(second);
      if (!flow) return errorResponse(404, "unknown_flow", "No such flow. See /api/v1/flows.");
      const given = Object.fromEntries(ctx.url.searchParams.entries());
      const values = { ...initialValues(flow, given), ...given };
      const plan = flow.plan(values, {
        addresses: addressesOf(sources.deployments),
        now: Math.floor(ctx.now.getTime() / 1000),
      });
      if (!plan.ok)
        return jsonResponse({ flow: flow.id, ok: false, problems: plan.problems, values }, { status: 422 });
      let calls;
      try {
        calls = plan.calls.map((c) => ({
          label: c.label,
          contract: c.target,
          to: c.to,
          signature: c.signature,
          args: c.args,
          valueWei: c.value ?? null,
          gasLimit: c.gas ?? null,
          data: encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args as unknown[] }),
          cast: castCommand(c, PUBLIC_RPC),
        }));
      } catch (error) {
        // Values no contract call can carry are the caller's to correct, not an upstream failure.
        return jsonResponse(
          {
            flow: flow.id,
            ok: false,
            problems: [`These values cannot be encoded: ${messageOf(error)}`],
            values,
          },
          { status: 422 },
        );
      }
      return jsonResponse({
        flow: flow.id,
        ok: true,
        sendable: plan.calls.every((c) => c.to !== null),
        values,
        summary: plan.summary,
        reads: (plan.reads ?? []).map((r) => ({
          label: r.label,
          contract: r.target,
          to: r.to,
          signature: r.signature,
          cast: castReadCommand(r, PUBLIC_RPC),
        })),
        calls,
      });
    }

    return errorResponse(404, "not_found", "No such route. See /api/v1 for the list.");
  } catch (error) {
    if (error instanceof UpstreamBusyError) {
      const seconds = Math.ceil(error.retryAfterMs / 1000);
      return errorResponse(503, "upstream_budget_spent", error.message, { "retry-after": String(seconds) });
    }
    if (error instanceof UpstreamDownError) {
      const seconds = Math.ceil(error.retryAfterMs / 1000);
      return errorResponse(503, "upstream_not_answering", error.message, { "retry-after": String(seconds) });
    }
    return errorResponse(502, "upstream_failed", messageOf(error));
  }
}

/**
 * What exists on chain today, for a reader who wants counts and not prose. Every figure is read
 * when the answer is made; a figure that cannot exist yet is null with the reason beside it, never
 * a zero that could be mistaken for a measurement. HOUSE and OUTSIDE are kept apart throughout.
 */
async function evidence(ctx: LoadContext): Promise<Response> {
  const { sources, now } = ctx;
  const { chain, house, deployments } = sources;
  const ours = houseSet(deployments);
  const settle = <T>(p: Promise<T>) =>
    p.then(
      (value) => ({ value, error: null as string | null }),
      (error: unknown) => ({ value: null as T | null, error: messageOf(error) }),
    );
  const [verify, intake, payments, ledger, feeds, report, orders, pots, doorbell, headerReceipt, judges] =
    await Promise.all([
      settle(runVerify({ ...ctx, visitor: null }, REFERENCE_JOB.jobId)),
      settle(chain.intake()),
      settle(chain.payments()),
      house.ledger(),
      house.feeds(),
      house.report(1),
      house.orders(40),
      house.pots(40),
      house.doorbell(),
      settle(chain.receiptRead(HEADER_JOB.jobIdBytes16)),
      // "What is not shown" is the judges page's own list, built from the same cached reads, so
      // the two can never say different things.
      settle(judgesPage.load({ ...ctx, visitor: null }, {})),
    ]);

  const requests = intake.value?.requests ?? [];
  const byHouse = requests.filter((r) => ours.has(r.payer));
  const contractAddresses = new Set(
    Object.values(deployments.contracts)
      .map((c) => c.address?.toLowerCase())
      .filter((a): a is string => typeof a === "string"),
  );
  const byOurContracts = requests.filter((r) => contractAddresses.has(r.payer));
  // The newest day of blocks: the range the Jobs Report prints and anyone can reproduce.
  const tally = payments.value ? releaseTally(payments.value, ours) : null;
  // Sample mode replaces orders and pots with made-up ones. They are never counted as evidence.
  const sample = sources.env.sampleData;
  const book = orders.live && !sample ? orders.data : null;
  const employers = book ? [...new Set(book.orders.map((o) => o.employer))] : null;
  const potBook = pots.live && !sample ? pots.data : null;
  const potOpeners = potBook
    ? [...new Set(potBook.pots.map((pot) => pot.opener).filter((o): o is string => o !== null))]
    : [];
  const bell = doorbell.live ? doorbell.data : null;
  const rings = bell?.ringers ? ringsByOrigin(bell.ringers, ours) : null;
  const deskMedium = DESK_ADAPTATION.findings.filter((f) => f.severity === "medium");
  // Launch C's review, once the book records launch C: what its pull request and IdentityMD's record say.
  const launchCPr = launchRecorded(deployments, "C")
    ? (LAUNCH_PRS.find((pr) => pr.launch === "C") ?? null)
    : null;
  const l = ledger.live ? ledger.data : null;
  // Standing Questions: what the contract itself says of its feeds, and who opened the rounds whose
  // opening log this server could read. Our own wallets are HOUSE here as everywhere.
  const feedBook = feeds.live ? feeds.data : null;
  const houseFeeds = feedBook ? feedBook.feeds.filter((f) => f.house !== null) : [];
  const openers = houseFeeds.flatMap((f) => f.roundList).filter((r) => r.keeper !== null);
  const delivered = houseFeeds
    .flatMap((f) => f.roundList)
    .filter((r) => r.status === "Answered" && r.byCallback !== null);
  const printed =
    report.live && report.data ? (report.data.summary?.prints ?? report.data.prints.length) : null;

  return jsonResponse({
    generatedAt: now.toISOString(),
    sampleData: sources.env.sampleData,
    note: "Read when this answer was made. null means the thing cannot exist yet (see the reason next to it), never zero. HOUSE is activity from the wallets and contracts listed under houseWallets; everything else is OUTSIDE.",
    contracts: {
      launched: deployments.launchedCount,
      of: Object.keys(deployments.contracts).length,
      list: allContracts(deployments).map((c) => ({ launch: c.launch, name: c.name, address: c.address })),
    },
    launches: LAUNCH_KEYS.map((key) => {
      const launch = deployments.launches[key];
      return {
        launch: key,
        name: launch.name,
        launched: launchIsLive(deployments, key),
        identitymdLaunchNumber: launch.launchNumber,
        transaction: launch.txHash,
        block: launch.block,
      };
    }),
    houseWallets: HOUSE_WALLETS,
    centralClaim: {
      jobId: REFERENCE_JOB.jobId,
      verdict: verify.value?.result.verdict ?? null,
      receipt: verify.value?.result.receipt ?? null,
      keccakOfRecord: verify.value?.result.record?.keccak ?? null,
      error: verify.error,
      check: `/verify/${REFERENCE_JOB.jobId}.json`,
    },
    intakeRequests: {
      intake: MAINNET.INTAKE,
      everTakenOnMainnet: intake.value?.current.nonce ?? null,
      legacyIntake: MAINNET.INTAKE_V1,
      everTakenByTheLegacyIntake: intake.value?.legacy.nonce ?? null,
      listed: requests.length,
      boughtByOurContracts: contractAddresses.size > 0 ? byOurContracts.length : null,
      boughtByOurContractsReason: contractAddresses.size > 0 ? null : `Questions is ${NOT_LAUNCHED}`,
      boughtByHouseWallets: byHouse.length,
      houseTransactions: byHouse.map((r) => etherscanTx(r.txHash)),
      error: intake.error ?? intake.value?.error ?? null,
    },
    paymentsToTheSwarm: tally
      ? {
          feeAddress: MAINNET.FEE_PAYEE,
          fromBlock: tally.window.fromBlock,
          toBlock: tally.window.toBlock,
          totalWei: tally.totalWei,
          payments: tally.payments,
          payers: tally.payers,
          houseWei: tally.houseWei,
          housePayments: tally.housePayments,
          outsideWei: tally.outsideWei,
          outsidePayments: tally.outsidePayments,
          unofficial: true,
        }
      : { error: payments.error },
    orders: book
      ? {
          opened: book.count,
          read: book.orders.length,
          delivered: book.orders.filter((o) => o.state === "Delivered").length,
          provenOnChain: book.orders.filter((o) => o.state === "Delivered" && o.terms?.proven).length,
          refunded: book.orders.filter((o) => o.state === "Refunded").length,
          houseEmployers: (employers ?? []).filter((e) => ours.has(e)),
          outsideEmployers: (employers ?? []).filter((e) => !ours.has(e)),
          desk: orders.live ? orders.address : null,
          note:
            book.count === 0
              ? "The hire desk is launched and has opened no order: opened is its own counter, orderCount(), read for this answer. Zero here is a reading, not a missing figure."
              : "Counted over the newest orders read (at most 40); opened is the desk's own counter.",
        }
      : {
          opened: null,
          reason: sample
            ? "sample data mode is on: its orders are made up and are not counted"
            : orders.live
              ? orders.error
              : `WorkOrders is ${NOT_LAUNCHED}`,
        },
    pots:
      pots.live && potBook
        ? {
            opened: potBook.count,
            read: potBook.pots.length,
            houseOpeners: potOpeners.filter((o) => ours.has(o)),
            outsideOpeners: potOpeners.filter((o) => !ours.has(o)),
            crowdPots: pots.address,
            note:
              potBook.count === 0
                ? "CrowdPots is launched and no pot has been opened: opened is its own counter, potCount(), read for this answer."
                : "opened is CrowdPots' own counter; openers are those of the newest pots read (at most 40).",
          }
        : {
            opened: null,
            reason: sample
              ? "sample data mode is on: its pots are made up and are not counted"
              : pots.live
                ? pots.error
                : `CrowdPots is ${NOT_LAUNCHED}`,
          },
    doorbell: bell
      ? {
          address: doorbell.live ? doorbell.address : null,
          rings: bell.rings,
          ringsWhoseSenderWasRead: rings ? rings.read : bell.rings === 0 ? 0 : null,
          ringsByHouse: rings ? rings.house : bell.rings === 0 ? 0 : null,
          ringsByOutside: rings ? rings.outside : bell.rings === 0 ? 0 : null,
          ringLogBlocks: rings ? { fromBlock: rings.fromBlock, toBlock: rings.toBlock } : null,
          hires: bell.hires,
          ringsUntilHire: bell.ringsUntilHire,
          funded: bell.funded,
          heldWei: bell.balanceWei,
          minPayWei: bell.minPayWei,
          maxPayWei: bell.maxPayWei,
          bondWei: bell.bondWei,
          deliverySecs: bell.deliverySecs,
          allowsBondedClaims: bell.allowClaimed,
          deliveriesReported: bell.receipts,
          note: "Read from the Doorbell's own views and the IMD token when this answer was made. A null beside a figure means it could not be read. The contract counts rings and names no ringer: who rang is taken from the Rang logs this server could read, so the HOUSE and OUTSIDE figures cover those logs only, and rings is the contract's own counter.",
        }
      : {
          rings: null,
          reason: doorbell.live
            ? (doorbell.error ?? "the Doorbell did not answer")
            : `Doorbell is ${NOT_LAUNCHED}`,
        },
    standingQuestions: feedBook
      ? {
          feedsCreated: feedBook.count,
          houseFeedsCreated: houseFeeds.length,
          houseFeeds: houseFeeds.map((f) => ({
            feed: f.house,
            rounds: f.rounds,
            pending: f.pending,
            answered: f.latest.updatedAt > 0,
            meterWei: f.meterWei,
          })),
          houseRoundsOpened: houseFeeds.reduce((sum, f) => sum + f.rounds, 0),
          houseFeedsWithAnAnswer: houseFeeds.filter((f) => f.latest.updatedAt > 0).length,
          roundsWhoseOpenerWasRead: openers.length,
          openedByHouse: openers.filter((r) => ours.has(r.keeper as string)).length,
          openedByOutside: openers.filter((r) => !ours.has(r.keeper as string)).length,
          answeredRoundsWhoseDeliveryWasRead: delivered.length,
          deliveredByTheIntakeCallback: delivered.filter((r) => r.byCallback === true).length,
          handedInWithSubmit: delivered.filter((r) => r.byCallback === false).length,
          handedInWithSubmitByHouse: delivered.filter(
            (r) => r.byCallback === false && r.deliveredBy !== null && ours.has(r.deliveredBy),
          ).length,
          note: "A feed counts as answered only when the contract holds an answer for it. A round's opener and how its answer arrived are read from its RoundOpened and RoundAnswered logs, while those logs are within reach of this server's RPC.",
        }
      : {
          feedsCreated: null,
          reason: feeds.live ? (feeds.error ?? "Questions did not answer") : `Questions is ${NOT_LAUNCHED}`,
        },
    jobsReport:
      printed !== null
        ? { prints: printed }
        : {
            prints: null,
            reason: report.live
              ? (report.error ?? "JobsReport did not answer")
              : `JobsReport is ${NOT_LAUNCHED}`,
          },
    feeSplit: l
      ? {
          receivedWei: l.receivedWei,
          sentToStakersWei: l.drippedWei,
          bookedForSeatsWei: l.toSeatsWei,
          claimedBySeatsWei: l.seatClaimedWei,
          tipsInWei: l.tipsInWei,
          tipsClaimedWei: l.tipsClaimedWei,
          tipsToTheSeatPoolWei: l.tipsToSeatsWei,
          placedOnFeedMetersWei: l.feedsFundedWei,
          feedBudgetReleasedToStakersWei: l.feedsReleasedWei,
        }
      : { receivedWei: null, reason: ledger.live ? ledger.error : `Payroll is ${NOT_LAUNCHED}` },
    auditsByTheLaunchPipeline: {
      launchB: {
        launched: launchRecorded(deployments, "B"),
        identitymdLaunchNumber: deployments.launches.B.launchNumber,
        document: DESK_ADAPTATION.document,
        documentUrl: PUBLIC_SOURCE.B
          ? `${PUBLIC_SOURCE.B.repository}/blob/${PUBLIC_SOURCE.B.branch}/ADAPTATION.md`
          : null,
        findings: DESK_ADAPTATION.findings.map((f) => ({
          id: f.id,
          severity: f.severity,
          raisedBy: f.raisedBy,
          finding: f.finding,
          outcome: f.outcome,
        })),
        mediumFindings: deskMedium.length,
        findingsOnRecord: DESK_ADAPTATION.onRecord.count,
        findingsOnRecordUrl: DESK_ADAPTATION.onRecord.record,
        findingsMergedByTheJudge: DESK_ADAPTATION.onRecord.merged,
        // The judge's first round was not accepted; its last round restates these, so they are not in findingsOnRecord.
        findingsInASubmissionNotAccepted: DESK_ADAPTATION.onRecord.notAccepted,
        everyFindingDocument: DESK_ADAPTATION.onRecord.document,
        contractCodeChangedForAFinding: false,
        mediumFindingAnswer: deskMedium.map((f) => f.done).join(" "),
        note: `From the launch project's own ADAPTATION.md, which IdentityMD's launch pipeline wrote before it deployed launch B. It answers ${DESK_ADAPTATION.findings.length} of the ${DESK_ADAPTATION.onRecord.count} findings in the accepted submissions on IdentityMD's record of the job; the pipeline's judge merged the other ${DESK_ADAPTATION.onRecord.merged} into three of those, and ${DESK_ADAPTATION.onRecord.document} lists all ${DESK_ADAPTATION.onRecord.count}. The judge's first round, a submission that was not accepted, raised ${DESK_ADAPTATION.onRecord.notAccepted} more entries, which its last round restates. The medium finding was answered in words, not in code: the limit it describes stands and is disclosed (launch B's THREATS.md, C2). We bought no audit of launch B ourselves.`,
      },
      launchC: launchCPr
        ? {
            launched: launchRecorded(deployments, "C"),
            identitymdLaunchNumber: deployments.launches.C.launchNumber,
            pullRequest: launchCPr.url,
            pullRequestSays: launchCPr.reviewer,
            findingsOnRecord: launchCPr.count,
            findingsOnRecordUrl: launchCPr.record,
            document: "launches/c-company/ADAPTATION.md",
            sourceFileChangedForAFinding: false,
            everyFindingDocument: launchCPr.document,
            note: launchCPr.accounted,
          }
        : null,
    },
    // What has not been shown, in the judges page's own sentences: each is there only while it is true.
    notShown: judges.value ? judges.value.notLive : null,
    notShownError: judges.value ? null : (judges.error ?? "the judges page could not be built"),
    provenOnTheLiveSystem: {
      houseFeedAnswers: HOUSE_FEED_NAMES.map((name) => ({
        feed: name,
        oracleRequest: IMD_LINK.oracleRequest(FEED_PROOFS[name].oracleRequestId),
        purchase: etherscanTx(FEED_PROOFS[name].transaction),
        agreed: FEED_PROOFS[name].agreed,
        attestedAt: FEED_PROOFS[name].attestedAt,
      })),
      audits: AUDITS.map((a) => ({
        job: a.jobId,
        report: IMD_LINK.jobReport(a.jobId),
        findings: a.findings.map((f) => ({ id: f.id, severity: f.severity, outcome: f.outcome })),
      })),
      headerJob: {
        jobId: HEADER_JOB.jobId,
        recordHash: HEADER_JOB.recordHash,
        record: IMD_LINK.workRecord(HEADER_JOB.recordHash.slice(2)),
        registryReceipt: headerReceipt.value?.value ?? null,
        receiptOnChain:
          headerReceipt.value === null
            ? null
            : headerReceipt.value.value.toLowerCase() === HEADER_JOB.recordHash,
        note: "receiptOnChain is true only when WorkRegistry.latest(job) equals recordHash; null when the registry could not be read. Until then the record carries our header and nothing is proven on chain.",
        error: headerReceipt.error,
      },
    },
    more: ["/judges.json", "/api/v1/integration", "/api/v1/deployments", "/api/v1/status"],
  });
}

async function status(ctx: LoadContext): Promise<Response> {
  const { sources, now } = ctx;
  const { api, chain, env, deployments } = sources;
  const probe = async <T>(
    run: () => Promise<{ fetchedAt: number; stale: boolean; error: string | null } & T>,
  ) => {
    try {
      const read = await run();
      return {
        ok: read.error === null,
        ageSeconds: Math.max(0, Math.round((now.getTime() - read.fetchedAt) / 1000)),
        stale: read.stale,
        error: read.error,
      };
    } catch (error) {
      return { ok: false, ageSeconds: null, stale: true, error: messageOf(error) };
    }
  };
  const launched = (Object.keys(deployments.contracts) as ContractKey[]).filter(
    (key) => deployments.contracts[key].address !== null,
  );
  const [health, head, payments, intake, identities] = await Promise.all([
    probe(() => api.health()),
    probe(() => chain.head()),
    probe(() => chain.payments()),
    probe(() => chain.intake()),
    // Does each configured address answer as the contract it is configured to be?
    Promise.all(
      launched.map(async (key) => {
        const read = await sources.house.identity(key);
        return {
          contract: deployments.contracts[key].name,
          address: deployments.contracts[key].address,
          answersAsThatContract: read.live && read.data ? read.data.confirmed : null,
          detail: read.live ? (read.data?.detail ?? read.error) : null,
        };
      }),
    ),
  ]);
  const headBlock = await chain.head().then(
    (h) => h.value.block,
    () => null,
  );
  const ok = health.ok && head.ok;
  return jsonResponse(
    {
      status: ok ? "ok" : "degraded",
      now: now.toISOString(),
      uptimeSeconds: Math.round((now.getTime() - sources.startedAt) / 1000),
      // The commit this server was built from, as the host says it (Railway sets
      // RAILWAY_GIT_COMMIT_SHA on a deploy from GitHub); "unknown" when the host said nothing.
      commit: env.commit ?? "unknown",
      commitSource: env.commit
        ? "RAILWAY_GIT_COMMIT_SHA, or GIT_COMMIT where that is not set"
        : "unknown: neither RAILWAY_GIT_COMMIT_SHA nor GIT_COMMIT was set for this server",
      sampleData: env.sampleData,
      launchedContracts: deployments.launchedCount,
      siteOrigin: env.siteOrigin,
      contracts: identities,
      sources: {
        identitymdApi: { base: api.baseUrl, ...health, budget: api.usage() },
        rpc: { host: chain.rpcHost, headBlock, ...head, budget: chain.usage() },
        payments,
        intake,
        archiveRpc: env.archiveRpcUrl ? "configured" : "not configured",
        indexer: "not connected: this site reads the chain and the IdentityMD API directly",
      },
    },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
