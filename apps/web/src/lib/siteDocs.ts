/**
 * The root files an agent looks for first: `/llms.txt`, `/llms-full.txt`, `/robots.txt` and
 * `/sitemap.xml`. All are built from the page registry and the same models as the pages.
 */
import { HOUSE_FEEDS, HOUSE_FEED_NAMES, IMD_API_BASE, MAINNET, workProofAbi } from "@help-wanted/shared";
import { etherscanTx, IMD_LINK, REFERENCE_JOB } from "~/config/chain";
import { DEPLOYMENT_BOOK_PATH } from "~/config/deployments";
import { LAUNCH_PRS, pinnedOrder } from "~/config/history";
import { houseSet } from "~/config/house";
import { DISCLOSED_LIMITS } from "~/config/limits";
import { AUDITS, DESK_ADAPTATION, deskGradingWords, deskOnRecordWords, FEED_PROOFS } from "~/config/proofs";
import { TEMPLATES } from "~/config/templates";
import { HEADER_JOB, LAUNCH_A_JOB } from "~/data";
import { allContracts, castView, launchRecorded, PAYS_WHEN, PUBLIC_RPC } from "~/models/common";
import { releaseTally } from "~/models/jobsReport";
import { endowmentCreator, ringersWords } from "~/models/money";
import { launchSentence } from "~/models/judges";
import { loadReceiptFlow, receiptFlowMeaning } from "~/models/receipts";
import { isLivePath, STATIC_PATHS, twinPaths } from "~/models/registry";
import type { LoadContext } from "~/models/types";
import { messageOf } from "./cache";
import { formatImd, formatInt, formatUtc, plural } from "./format";
import { hashNo0x, jobIdToBytes16 } from "./ids";
import { bullets, doc, fence, table } from "./md";
import { loadPath, markdownTwin, SITE_NAME, SITE_TAGLINE } from "./twins";
import { verifyCommands } from "./verify";

export const API_ROUTES: readonly { path: string; what: string }[] = [
  { path: "/api/v1", what: "This list." },
  { path: "/api/v1/health", what: "Liveness only: answers 200 without reading any upstream." },
  {
    path: "/api/v1/status",
    what: "Whether the server's data sources answer, how old its data is, and its configuration.",
  },
  {
    path: "/api/v1/deployments",
    what: "The addresses of our contracts, as the deployments book holds them; null means not in the book yet (its note says which launches that covers).",
  },
  {
    path: "/api/v1/integration",
    what: "One row per IdentityMD primitive: address or endpoint, what we do with it, status, where the proof is.",
  },
  {
    path: "/api/v1/evidence",
    what: "What exists on chain today, HOUSE and OUTSIDE apart: contracts and launches, feeds and rounds, Jobs Report prints, orders, pots, the Doorbell, Intake requests, payments, fees split, what the launch pipeline's audits found, what has been proven on the live system with its links, and what has not been shown. Null means it cannot exist yet or could not be read; the reason is beside it. A zero is a reading.",
  },
  { path: "/api/v1/swarm", what: "The swarm's state: machines online and working, receipts queued." },
  { path: "/api/v1/jobs", what: "Recent swarm jobs with their WorkRegistry receipts." },
  {
    path: "/api/v1/verify/{jobId}",
    what: "The receipt check for one job: verdict, receipt, record hash, steps.",
  },
  {
    path: "/api/v1/work-records/{hash}.json",
    what: "A work record's bytes exactly as IdentityMD serves them (hash without 0x).",
  },
  {
    path: "/api/v1/jobs-report/latest",
    what: "The Jobs Report: the official prints once the JobsReport contract has printed, and this site's unofficial tally beside them.",
  },
  {
    path: "/api/v1/questions",
    what: "The three house feeds (what each asks, its exact text, meter, cadence, rounds) and the oracle requests bought on chain through both Intake contracts.",
  },
  {
    path: "/api/v1/feeds",
    what: "The Standing Questions feeds: each house feed's text and the one answer attested for it before launch, and its meter and rounds as read from the Questions contract (null while that contract is not launched).",
  },
  {
    path: "/api/v1/orders",
    what: "Orders on the hire desk, as WorkOrders answers: its own count and the newest orders. count is null while the desk is not launched or could not be read; 0 means the desk answered and has opened none.",
  },
  { path: "/api/v1/orders/{id}", what: "One order." },
  {
    path: "/api/v1/pots",
    what: "Crowd pots, as CrowdPots answers: its own count and the newest pots. count is null while it is not launched or could not be read; 0 means it answered and no pot has been opened.",
  },
  { path: "/api/v1/pots/{id}", what: "One pot." },
  {
    path: "/api/v1/seats/{tokenId}",
    what: "A seat's owner, the agents seen bound to it, and what it can claim.",
  },
  {
    path: "/api/v1/pnl",
    what: "The Payroll ledger as read from the contract, and the fixed fee split (no ledger while Payroll is not launched).",
  },
  { path: "/api/v1/flows", what: "Every transaction flow the site offers, with its form fields." },
  {
    path: "/api/v1/flows/{id}?field=value",
    what: "Plans a flow: the reads to make first, the contract calls, their arguments and the cast commands.",
  },
];

function abs(ctx: LoadContext, path: string): string {
  return `${ctx.sources.env.siteOrigin ?? ""}${path}`;
}

export async function llmsTxt(ctx: LoadContext): Promise<string> {
  const { api, chain, house, deployments, env } = ctx.sources;
  const [
    health,
    payments,
    intake,
    receipts,
    feeds,
    orders,
    pots,
    doorbell,
    endowments,
    rules,
    headerReceipt,
  ] = await Promise.all([
    api.health().catch((error: unknown) => messageOf(error)),
    chain.payments().catch((error: unknown) => messageOf(error)),
    chain.intake().catch((error: unknown) => messageOf(error)),
    loadReceiptFlow(ctx.sources),
    house.feeds(),
    house.orders(40),
    house.pots(40),
    house.doorbell(),
    house.endowments(20),
    house.rules(20),
    chain.receiptRead(HEADER_JOB.jobIdBytes16).then(
      (read) => read.value.toLowerCase(),
      () => null,
    ),
  ]);
  const headerReceiptWords =
    headerReceipt === null
      ? "The WorkRegistry could not be read just now, so nothing is said here about its receipt."
      : headerReceipt === HEADER_JOB.recordHash
        ? "Its receipt is on chain: WorkRegistry.latest for the job equals the record's hash."
        : "Its on-chain receipt is still queued at IdentityMD: WorkRegistry.latest for the job does not hold the record's hash, so this is not a proof on chain.";
  // Whether a contract of ours holds an oracle answer: said only from a read of the contract.
  const feedBook = feeds.live ? feeds.data : null;
  const answered = feedBook ? feedBook.feeds.filter((f) => f.latest.updatedAt > 0).length : null;
  const storedWords = !feeds.live
    ? "no contract of ours has stored an answer, because Questions is not launched."
    : answered === null
      ? "whether our Questions contract has stored an answer since could not be read just now."
      : answered === 0
        ? `our Questions contract is launched and has stored no answer yet (${feedBook?.feeds.filter((f) => f.house !== null).length ?? 0} of its three house feeds exist; none has an answered round).`
        : `since then our Questions contract has stored an answer for ${answered} feed${answered === 1 ? "" : "s"}, each checked on chain; the questions page lists every round and says how each answer arrived (the Intake's own callback, or handed in with submit, and by whom).`;
  const numbers: string[] = [];
  if (typeof health !== "string") {
    numbers.push(
      `${formatInt(health.value.online)} robots online, ${formatInt(health.value.working)} with work (IdentityMD API, ${formatUtc(health.fetchedAt)}).`,
    );
  }
  if (receipts.state !== "unknown")
    numbers.push(`Receipts: ${receipts.observed} ${receiptFlowMeaning(receipts)}`);
  if (typeof payments !== "string") {
    // The newest day of blocks: the range the Jobs Report prints, and one the public RPC serves.
    const tally = releaseTally(payments);
    numbers.push(
      `${formatImd(tally.totalWei)} IMD paid to the swarm's fee address in ${formatInt(tally.payments)} payments from ${formatInt(tally.payers)} payers, blocks ${tally.window.fromBlock} to ${tally.window.toBlock} (unofficial tally).`,
    );
  }
  if (typeof intake !== "string") {
    numbers.push(
      `Oracle requests ever bought on chain: ${intake.current.nonce ?? "unread"} through the mainnet Intake (version 2) and ${intake.legacy.nonce ?? "unread"} through the legacy one (version 1), by each contract's own counter.`,
    );
  }
  numbers.push(
    `${deployments.launchedCount} of ${Object.keys(deployments.contracts).length} HELP WANTED contracts launched.`,
  );
  // The hire desk, the pots and the Doorbell, once launched: what each answered, or that it did not.
  if (orders.live && !env.sampleData) {
    numbers.push(
      orders.data
        ? orders.data.count === 0
          ? "The hire desk is live and no order has been opened on it yet (WorkOrders.orderCount() read 0)."
          : `${plural(orders.data.count, "order has", "orders have")} been opened on the hire desk (WorkOrders.orderCount()).`
        : `The hire desk is launched; its orders could not be read just now (${orders.error}).`,
    );
  }
  if (pots.live && !env.sampleData) {
    numbers.push(
      pots.data
        ? pots.data.count === 0
          ? "No crowd pot has been opened yet (CrowdPots.potCount() read 0)."
          : `${plural(pots.data.count, "crowd pot has", "crowd pots have")} been opened (CrowdPots.potCount()).`
        : `CrowdPots is launched; its pots could not be read just now (${pots.error}).`,
    );
  }
  if (doorbell.live) {
    const bell = doorbell.data;
    const who = bell ? ringersWords(bell, houseSet(deployments)) : null;
    numbers.push(
      bell
        ? `The Doorbell: ${bell.rings === null ? "rings unread" : plural(bell.rings, "ring")} so far, ${bell.hires === null ? "hires unread" : plural(bell.hires, "hire")}, ${plural(bell.ringsUntilHire, "ring")} until the next hire; ${bell.funded === null ? "whether it is funded could not be read" : bell.funded ? "funded" : "not funded"}${bell.balanceWei === null ? "" : ` (it holds ${formatImd(bell.balanceWei)} IMD)`}${bell.maxPayWei === null ? "" : bell.minPayWei === bell.maxPayWei ? `; each order pays ${formatImd(bell.maxPayWei)} IMD` : `; each order pays up to ${formatImd(bell.maxPayWei)} IMD`}${bell.allowClaimed === null ? "" : bell.allowClaimed ? "; its orders accept a bonded delivery claim" : "; its orders pay on a receipt only"}.${who ? ` ${who}` : ""}`
        : `The Doorbell is launched; it could not be read just now (${doorbell.error}).`,
    );
  }
  // Launch C, once launched: what each counter answered, or that it did not.
  if (endowments.live) {
    const book = endowments.data;
    const ours = houseSet(deployments);
    const address = deployments.contracts.endowments.address;
    const creators = book
      ? book.endowments.map((e) => endowmentCreator(e, address)).filter((c): c is string => c !== null)
      : [];
    const byHouse = creators.filter((c) => ours.has(c)).length;
    numbers.push(
      book
        ? book.count === 0
          ? "No endowment has been created yet (Endowments.endowmentCount() read 0)."
          : `${plural(book.count, "endowment has", "endowments have")} been created (Endowments.endowmentCount()).${creators.length > 0 ? ` Of the ${plural(creators.length, "endowment")} whose creator this server knows, ${formatInt(byHouse)} ${byHouse === 1 ? "was" : "were"} created by our own wallets (HOUSE) and ${formatInt(creators.length - byHouse)} by others (OUTSIDE).` : ""}`
        : `Endowments is launched; it could not be read just now (${endowments.error}).`,
    );
  }
  if (rules.live) {
    numbers.push(
      rules.data
        ? rules.data.count === 0
          ? "No standing rule has been created yet (Rules.ruleCount() read 0)."
          : `${plural(rules.data.count, "standing rule has", "standing rules have")} been created (Rules.ruleCount()).`
        : `Rules is launched; it could not be read just now (${rules.error}).`,
    );
  }

  // Order 1, settled on proof. Its logs are older than the public RPC serves, so the transaction is
  // the one kept with this site (config/history.ts), and only for the desk it was read from.
  const firstOrder = pinnedOrder(deployments.contracts.workOrders.address, 1);
  const firstSettled = firstOrder?.trail.find((step) => step.key === "settled") ?? null;
  const workProof = deployments.contracts.workProof.address;
  const firstOrderProof =
    firstOrder && firstSettled && workProof
      ? {
          words: `Order ${firstOrder.id} on the hire desk, opened by the Doorbell, was settled on proof on ${formatUtc(firstSettled.tx.at)}: the desk had WorkProof check swarm job ${firstOrder.jobId}'s work record against its WorkRegistry receipt, then paid (${etherscanTx(firstSettled.tx.hash)}). The ringer, the runner and the Doorbell's IMD were the team's own. A proof shows what IdentityMD recorded, not that the work is good. The prove command is under "Check the central claim yourself".`,
          commands: [
            `# Order ${firstOrder.id}'s work record, exactly as IdentityMD serves it`,
            `curl -s ${IMD_LINK.workRecord(hashNo0x(firstOrder.prove.recordHash))} -o record.json`,
            "",
            "# Ask the launched WorkProof; it reads WorkRegistry.latest itself",
            castView(workProof, "WORK_PROOF", workProofAbi, "prove", [
              jobIdToBytes16(firstOrder.jobId),
              `"0x$(xxd -p record.json | tr -d '\\n')"`,
              "85",
            ]),
          ],
        }
      : null;

  // Launch C's pipeline findings, said once the book records launch C, as the judges page says them.
  const launchCPr = LAUNCH_PRS.find((pr) => pr.launch === "C") ?? null;

  const commands = verifyCommands({
    jobId: REFERENCE_JOB.jobId,
    rpcUrl: PUBLIC_RPC,
    workRegistry: MAINNET.WORK_REGISTRY,
    apiBase: IMD_API_BASE,
    recordHash: REFERENCE_JOB.receipt,
  });

  return doc(
    `# ${SITE_NAME}`,
    `> ${SITE_TAGLINE} An employer escrows IMD against a pinned job; a bonded runner opens the swarm job; the escrow ${PAYS_WHEN}. A second part, Standing Questions, is a contract that buys its own oracle answers and publishes them as feeds. Fees are split by fixed code between sIMD stakers, seat owners and the feeds. Nothing has an owner. There is no token.`,
    `Status: an entry in the IdentityMD hackathon. **${launchSentence(deployments)}**${
      deployments.launches.A.txHash === null
        ? ` Launch A (Questions, JobsReport, Payroll) is in IdentityMD's launch pipeline, job ${LAUNCH_A_JOB.jobId} (${IMD_LINK.job(LAUNCH_A_JOB.jobId)}); no contract exists until its transaction is mined.`
        : ""
    } The table of addresses below follows one place, the deployments book of the shared package (${DEPLOYMENT_BOOK_PATH}); every page switches on when a launch is written there. What works on today's data whatever is launched: the Work Wire, the receipt checker, the unofficial Jobs Report tally, the list of Intake requests. Start at ${abs(ctx, "/judges.md")}.`,
    env.sampleData
      ? "SAMPLE DATA mode is on: orders and pots marked SAMPLE are made up for design work."
      : null,
    "## Right now",
    bullets(numbers),
    "## Pages",
    "Every page is complete without JavaScript and has a JSON and a Markdown twin: append `.json` or `.md` to its path (the home page is `/index.json` and `/index.md`).",
    bullets(
      STATIC_PATHS.map((p) => {
        const t = twinPaths(p.path);
        const waiting = !isLivePath(p, deployments) && p.needs !== null;
        const needs = p.needs === null ? null : deployments.contracts[p.needs];
        return `[${p.label}](${abs(ctx, t.md)}): ${p.blurb}${
          waiting && needs
            ? ` Not live until ${needs.name} is launched; the page is complete and shows every transaction and its cast command.`
            : ""
        }`;
      }),
    ),
    bullets([
      `[Verify one job](${abs(ctx, `/verify/${REFERENCE_JOB.jobId}.md`)}): the reference job, checked live.`,
      ...TEMPLATES.map((t) => `[Hire: ${t.title.toLowerCase()}](${abs(ctx, `/hire/${t.slug}.md`)})`),
    ]),
    "## Proven on the live system",
    bullets([
      ...HOUSE_FEED_NAMES.map(
        (name) =>
          `The live oracle attested the ${HOUSE_FEEDS[name].title} question (${FEED_PROOFS[name].agreed} of ${HOUSE_FEEDS[name].params.panelSize} panel members agreed, ${formatUtc(FEED_PROOFS[name].attestedAt)}): ${IMD_LINK.oracleRequest(FEED_PROOFS[name].oracleRequestId)}`,
      ),
      ...AUDITS.map(
        (audit, index) =>
          `IdentityMD's audit of launch A, report ${index + 1} (${audit.findings.length} findings, each with its outcome on the judges page): ${IMD_LINK.jobReport(audit.jobId)}`,
      ),
      `A real job carried our 85-byte order header unchanged into its work record: job ${HEADER_JOB.jobId}, record ${IMD_LINK.workRecord(HEADER_JOB.recordHash.slice(2))}. ${headerReceiptWords}`,
      ...(firstOrderProof ? [firstOrderProof.words] : []),
    ]),
    launchRecorded(deployments, "B")
      ? `Not a proof, a disclosure: before it deployed launch B${deployments.launches.B.launchNumber !== null ? ` (IdentityMD launch ${deployments.launches.B.launchNumber})` : ""}, IdentityMD's launch pipeline audited the four contracts. Its record of the job, ${DESK_ADAPTATION.onRecord.record}, holds ${deskOnRecordWords()}. ${deskGradingWords()} No contract code was changed for any of them; ${DESK_ADAPTATION.findings
          .filter((f) => f.severity === "medium")
          .map((f) => f.id)
          .join(
            " and ",
          )} (a receipt-only pot can be ended in a refund with no bond forfeited) was answered in words, not in code, and stands as a disclosed limit. ${DESK_ADAPTATION.onRecord.document} lists all ${DESK_ADAPTATION.onRecord.count}; the judges page gives the ${DESK_ADAPTATION.findings.length} that ${DESK_ADAPTATION.document} answers.`
      : null,
    launchRecorded(deployments, "C") && launchCPr
      ? `Not a proof, a disclosure: before it deployed launch C${deployments.launches.C.launchNumber !== null ? ` (IdentityMD launch ${deployments.launches.C.launchNumber})` : ""}, IdentityMD's launch pipeline audited the three contracts. Its record of the job, ${launchCPr.record}, holds ${launchCPr.count} findings, all in accepted review submissions: 6 graded low and 7 info, none marked blocking. The pipeline changed no source file. launches/c-company/ADAPTATION.md answers the 3 raised by the audit it imported; no node of the job answered the other 10.${launchCPr.document ? ` ${launchCPr.document} lists all ${launchCPr.count}, each with what became of it.` : ""}`
      : null,
    `The three oracle answers were bought by a house wallet and named no callback; ${storedWords}`,
    "## Check the central claim yourself",
    "`keccak256(work record) == WorkRegistry.latest(jobId)`. No key and no account are needed.",
    fence(commands.map((c) => `# ${c.comment}\n${c.command}`).join("\n\n"), "sh"),
    fence(
      [
        "# The seat behind the agent that job's record names.",
        `cast call ${MAINNET.SEAT_ADAPTER} "bindingOf(uint256)((uint8,address,uint256))" 52211 --rpc-url ${PUBLIC_RPC}`,
        "",
        "# How many oracle requests the mainnet Intake has ever taken.",
        `cast call ${MAINNET.INTAKE} "nonce()(uint256)" --rpc-url ${PUBLIC_RPC}`,
      ].join("\n"),
      "sh",
    ),
    firstOrderProof ? fence(firstOrderProof.commands.join("\n"), "sh") : null,
    "## Addresses",
    "IdentityMD's contracts on Ethereum mainnet:",
    table(
      ["Contract", "Address"],
      [
        ["IMD", MAINNET.IMD],
        ["sIMD", MAINNET.SIMD],
        ["Seats (ERC-721)", MAINNET.SEATS],
        ["Seat Adapter", MAINNET.SEAT_ADAPTER],
        ["WorkRegistry", MAINNET.WORK_REGISTRY],
        ["Intake, version 2", MAINNET.INTAKE],
        ["Intake, version 1 (legacy)", MAINNET.INTAKE_V1],
        ["Oracle attester", MAINNET.ORACLE_SIGNER],
        ["Fee address", MAINNET.FEE_PAYEE],
        ["ProjectFactory", MAINNET.PROJECT_FACTORY],
      ],
    ),
    "HELP WANTED's own contracts:",
    table(
      ["Launch", "Contract", "Address"],
      allContracts(deployments).map((c) => [c.launch, c.name, c.label]),
    ),
    "## JSON API",
    "Open CORS, GET only, cached for about 30 seconds.",
    bullets(API_ROUTES.map((r) => `\`${r.path}\`: ${r.what}`)),
    "## Limits and what is not live",
    `Disclosed in full at ${abs(ctx, "/judges.md")}: all ${DISCLOSED_LIMITS.length} entries of the three launch projects' threat documents in one table (trust roots, the limits of each contract, what is not verified), and the list of what is not live yet.`,
    "## More",
    bullets([
      `[Everything in one file](${abs(ctx, "/llms-full.txt")})`,
      `[The API described in OpenAPI](${abs(ctx, "/openapi.json")})`,
      ...(env.siteOrigin ? [`[Sitemap](${abs(ctx, "/sitemap.xml")})`] : []),
    ]),
  );
}

/** The Markdown twins of every fixed page, one after another, for a reader that wants one request. */
export async function llmsFullTxt(ctx: LoadContext): Promise<string> {
  const head = await llmsTxt(ctx);
  const sections: string[] = [head.trimEnd()];
  const paths = [
    ...STATIC_PATHS.map((p) => p.path),
    `/verify/${REFERENCE_JOB.jobId}`,
    ...TEMPLATES.map((t) => `/hire/${t.slug}`),
  ];
  // "/judges" first after the summary: it is the page a judging agent is sent to.
  paths.sort((a, b) => Number(b === "/judges") - Number(a === "/judges"));
  for (const path of paths) {
    try {
      const loaded = await loadPath(path, ctx);
      if (loaded) sections.push(markdownTwin(loaded).trimEnd());
    } catch (error) {
      sections.push(`# ${path}\n\nThis page could not be built just now: ${messageOf(error)}`);
    }
  }
  return `${sections.join("\n\n\n")}\n`;
}

export function robotsTxt(ctx: LoadContext): string {
  const origin = ctx.sources.env.siteOrigin;
  return [
    "# Every agent is welcome on every path. There is no bot challenge and no cookie wall.",
    "User-agent: *",
    "Allow: /",
    "",
    origin
      ? `Sitemap: ${origin}/sitemap.xml`
      : "# No sitemap: this server has not been told its public address. Every page is listed in /llms.txt.",
    "# For language models: /llms.txt and /llms-full.txt",
    "",
  ].join("\n");
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * The sitemap, or null when this server has not been told its public address. A sitemap lists
 * absolute addresses, and the only honest source for those is the operator's configuration: the
 * request's own Host header is whatever the caller wrote.
 */
export function sitemapXml(ctx: LoadContext): string | null {
  const origin = ctx.sources.env.siteOrigin;
  if (!origin) return null;
  const paths = [
    ...STATIC_PATHS.map((p) => p.path),
    `/verify/${REFERENCE_JOB.jobId}`,
    ...TEMPLATES.map((t) => `/hire/${t.slug}`),
  ];
  const urls: string[] = [];
  for (const path of paths) {
    const t = twinPaths(path);
    for (const loc of [t.html, t.json, t.md]) urls.push(`  <url><loc>${xml(origin + loc)}</loc></url>`);
  }
  for (const loc of ["/llms.txt", "/llms-full.txt", "/api/v1", "/openapi.json"])
    urls.push(`  <url><loc>${xml(origin + loc)}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}
