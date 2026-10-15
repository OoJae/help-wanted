/**
 * The twins: every page also answers at `<path>.json` and `<path>.md`, built from the same model
 * as the HTML. These tests load every page from recorded data (no network) and check the three
 * forms line up, that nothing is invented for contracts that are not launched, and that the root
 * files an agent looks for first are complete.
 *
 * What is launched is injected, never assumed. `testSources()` alone is a world with no launch in
 * its book; the pages are also loaded with launch A only and with all three launches, and once
 * with the real deployments book, held to whatever that book says.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTRACT_KEYS, deploymentEnvNames, NOT_LAUNCHED, resolveDeployments } from "~/config/deployments";
import { DEPLOYMENT_BOOK, flattenBook, HOUSE_FEEDS, isLaunched, MAINNET } from "@help-wanted/shared";
import { MULTICALL3, REFERENCE_JOB } from "~/config/chain";
import { PUBLIC_SOURCE, sourceWords } from "~/config/proofs";
import { TEMPLATES } from "~/config/templates";
import { HEADER_JOB, LAUNCH_A_JOB } from "~/data";
import { toJson } from "~/lib/http";
import { openApiDocument } from "~/lib/openapi";
import { API_ROUTES, llmsFullTxt, llmsTxt, robotsTxt, sitemapXml } from "~/lib/siteDocs";
import { jsonTwin, loadPath, markdownTwin, twinResponse } from "~/lib/twins";
import { launchSentence, launchSummaryFor, summaryFor, SUMMARY, type JudgesModel } from "~/models/judges";
import type { QuestionsModel } from "~/models/questions";
import { isLivePath, matchPage, PAGES, parseTwinPath, STATIC_PATHS, twinPaths } from "~/models/registry";
import { BOOK_NAMES, BOOKS, ctxFor, launchedIn, testSources } from "./helpers";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const REFERENCE = `/verify/${REFERENCE_JOB.jobId}`;
const EVERY_PATH = [
  ...STATIC_PATHS.map((p) => p.path),
  REFERENCE,
  ...TEMPLATES.map((t) => `/hire/${t.slug}`),
  "/orders/1",
  "/pots/1",
  "/seats/1998",
];

describe("twin paths", () => {
  it("splits a twin path into the page and the format", () => {
    expect(parseTwinPath("/jobs-report.json")).toEqual({ path: "/jobs-report", format: "json" });
    expect(parseTwinPath("/jobs-report.md")).toEqual({ path: "/jobs-report", format: "md" });
    expect(parseTwinPath(`${REFERENCE}.md`)).toEqual({ path: REFERENCE, format: "md" });
    expect(parseTwinPath("/hire/audit.json")).toEqual({ path: "/hire/audit", format: "json" });
    // The home page has no name of its own, so its twins are /index.json and /index.md.
    expect(parseTwinPath("/index.json")).toEqual({ path: "/", format: "json" });
    expect(parseTwinPath("/index.md")).toEqual({ path: "/", format: "md" });
    expect(parseTwinPath("/jobs-report")).toBeNull();
    expect(parseTwinPath("/jobs-report.txt")).toBeNull();
    expect(parseTwinPath("/llms.txt")).toBeNull();
  });

  it("names the three addresses of a page, and they lead back to it", () => {
    expect(twinPaths("/")).toEqual({ html: "/", json: "/index.json", md: "/index.md" });
    expect(twinPaths("/judges")).toEqual({ html: "/judges", json: "/judges.json", md: "/judges.md" });
    expect(twinPaths("/judges/")).toEqual({ html: "/judges", json: "/judges.json", md: "/judges.md" });
    for (const path of EVERY_PATH) {
      const twins = twinPaths(path);
      expect(parseTwinPath(twins.json)).toEqual({ path, format: "json" });
      expect(parseTwinPath(twins.md)).toEqual({ path, format: "md" });
    }
  });

  it("matches every page the site has, and nothing else", () => {
    for (const path of EVERY_PATH) expect(matchPage(path), path).not.toBeNull();
    expect(matchPage("/verify/abc")?.params).toEqual({ jobId: "abc" });
    expect(matchPage("/hire/audit/")?.page.id).toBe("hire-template");
    expect(matchPage("/nope")).toBeNull();
    expect(matchPage("/verify/a/b")).toBeNull();
    expect(matchPage("/openapi")).toBeNull();
    expect(matchPage("/api/v1/status")).toBeNull();
    // A path that is not valid percent-encoding is no page, not a crash.
    expect(matchPage("/verify/%E0%A4%A")).toBeNull();
  });

  it("lists every fixed page once, each backed by a page definition", () => {
    const paths = STATIC_PATHS.map((p) => p.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) expect(matchPage(path)?.params).toEqual({});
    expect(new Set(PAGES.map((p) => p.id)).size).toBe(PAGES.length);
    // The five pages that work on today's data are the ones marked live.
    expect(STATIC_PATHS.filter((p) => p.live).map((p) => p.path)).toEqual([
      "/",
      "/verify",
      "/jobs-report",
      "/questions",
      "/judges",
    ]);
    // Every other page names the contract it waits for, and stops waiting once that contract has
    // an address in the deployments book: nothing else has to be edited.
    const waiting = STATIC_PATHS.filter((p) => !p.live);
    expect(waiting.every((p) => p.needs !== null)).toBe(true);
    const live = (book: (typeof BOOKS)[keyof typeof BOOKS]) =>
      STATIC_PATHS.filter((p) => isLivePath(p, resolveDeployments({}, book))).map((p) => p.path);
    const always = ["/", "/verify", "/jobs-report", "/questions", "/judges"];
    expect(live(BOOKS.none)).toEqual(always);
    // Launch A switches on the company ledger and the seats; the desk's and the company's pages wait.
    expect(live(BOOKS.aOnly).filter((path) => !always.includes(path))).toEqual(["/company", "/seats"]);
    expect(live(BOOKS.all)).toEqual(STATIC_PATHS.map((p) => p.path));
  });
});

describe.each(BOOK_NAMES)("every page, in its JSON and Markdown forms, with the book %s", (bookName) => {
  it.each(EVERY_PATH)("%s", async (path) => {
    const world = testSources({ book: BOOKS[bookName] });
    const ctx = ctxFor(world, path);
    const loaded = await loadPath(path, ctx);
    expect(loaded, `${path} should load`).not.toBeNull();
    if (!loaded) return;
    expect(loaded.status).toBe(200);
    expect(loaded.paths).toEqual(twinPaths(path));
    expect(loaded.meta.title.length).toBeGreaterThan(3);
    expect(loaded.meta.description.length).toBeGreaterThan(20);

    // JSON: an envelope around the model. Amounts in wei survive as decimal strings.
    const envelope = jsonTwin(loaded);
    expect(envelope).toMatchObject({
      site: "HELP WANTED",
      page: twinPaths(path).html,
      title: loaded.meta.title,
      generatedAt: "2026-10-10T21:30:00.000Z",
      sampleData: false,
      twins: twinPaths(path),
    });
    const text = toJson(envelope);
    const parsed = JSON.parse(text) as { data: unknown };
    expect(parsed.data).toBeTypeOf("object");
    expect(text).not.toContain("[object Object]");

    // Markdown: the page as plain text, with its title, where it came from and its other forms.
    const markdown = markdownTwin(loaded);
    expect(markdown.startsWith(`# ${loaded.meta.title}\n`)).toBe(true);
    expect(markdown).toContain(`https://help-wanted.test${twinPaths(path).html}`);
    expect(markdown).toContain("generated 10 Oct 2026, 21:30 UTC");
    expect(markdown).toContain(`[JSON](${twinPaths(path).json})`);
    expect(markdown).not.toContain("SAMPLE");
    for (const leak of ["undefined", "[object Object]", "NaN", "null"]) {
      expect(markdown, `${path}.md must not print "${leak}"`).not.toMatch(
        new RegExp(`(^|[^A-Za-z])${leak.replace(/[[\]]/g, "\\$&")}([^A-Za-z]|$)`),
      );
    }

    const md = twinResponse(loaded, "md");
    expect(md.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(md.headers.get("access-control-allow-origin")).toBe("*");
    expect(md.headers.get("link")).toBe(`<${twinPaths(path).html}>; rel="canonical"`);
    expect(await md.text()).toBe(markdown);
    const json = twinResponse(loaded, "json");
    expect(json.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(json.headers.get("cache-control")).toContain("max-age=30");
    expect(JSON.parse(await json.text())).toEqual(JSON.parse(text));
  });
});

describe("what each page says of what is launched", () => {
  it("no page reads the network, and none shows an address for a contract that is not launched", async () => {
    const world = testSources({ book: BOOKS.none });
    expect(world.sources.deployments.launchedCount).toBe(0);
    for (const path of EVERY_PATH) {
      const loaded = await loadPath(path, ctxFor(world, path));
      expect(loaded).not.toBeNull();
    }
    // Reaching here at all means no page touched the real fetch (test/setup.ts makes that throw).
    // The fake API saw only the handful of cached reads the pages share: the swarm's state, the
    // recent jobs, and the three jobs this server reads on its own account (the reference job, the
    // job that carried our header, and launch A's job in the pipeline). Each was asked once.
    expect(new Set(world.api.calls)).toEqual(
      new Set([
        "GET /health",
        "GET /jobs",
        `GET /jobs/${REFERENCE_JOB.jobId}/records`,
        `GET /work-records/${REFERENCE_JOB.receipt.slice(2)}.json`,
        `GET /jobs/${HEADER_JOB.jobId}`,
        `GET /jobs/${HEADER_JOB.jobId}/records`,
        `GET /work-records/${HEADER_JOB.recordHash.slice(2)}.json`,
        `GET /jobs/${LAUNCH_A_JOB.jobId}`,
      ]),
    );
    expect(world.api.calls.length).toBe(8);
    // And only GET was ever sent.
    expect(world.api.calls.every((call) => call.startsWith("GET "))).toBe(true);
  });

  // Before any launch: every page that leans on a contract of ours says it is not launched.
  it.each([
    ["/hire", "The hire desk is not launched yet"],
    ["/hire/audit", "WorkOrders is not launched yet"],
    ["/orders", "**No orders.**"],
    ["/orders/1", "Order 1 does not exist yet"],
    ["/pots", "**No pots.**"],
    ["/pots/1", "Pot 1 does not exist yet"],
    ["/rules/new", "Rules cannot be written yet"],
    ["/company", "The ledger is empty"],
    ["/seats", "Nothing can be claimed yet"],
    ["/seats/1998", "Payroll is not launched yet"],
    ["/endowments", "Nothing can be deposited today"],
    ["/runners", "**No orders to take.**"],
    ["/questions", "The Questions contract is not launched yet"],
    ["/jobs-report", "the JobsReport contract is not launched yet"],
    ["/judges", "**Nothing is launched yet.**"],
    ["/", "None yet. The hire desk"],
  ])("with nothing launched, %s says plainly that its contract is not launched", async (path, words) => {
    const loaded = await loadPath(path, ctxFor(testSources({ book: BOOKS.none }), path));
    const markdown = markdownTwin(loaded!);
    expect(markdown).toContain(words);
    expect(markdown).toContain(NOT_LAUNCHED);
  });

  // Launch A only: the pages of the hire desk and of the company still say so, word for word.
  it.each([
    ["/hire", "The hire desk is not launched yet"],
    ["/hire/audit", "WorkOrders is not launched yet"],
    ["/orders", "**No orders.**"],
    ["/orders/1", "Order 1 does not exist yet"],
    ["/pots", "**No pots.**"],
    ["/pots/1", "Pot 1 does not exist yet"],
    ["/rules/new", "Rules cannot be written yet"],
    ["/endowments", "Nothing can be deposited today"],
    ["/runners", "**No orders to take.**"],
    ["/", "None yet. The hire desk"],
  ])("with launch A only, %s still says plainly that its contract is not launched", async (path, words) => {
    const loaded = await loadPath(path, ctxFor(testSources({ book: BOOKS.aOnly }), path));
    const markdown = markdownTwin(loaded!);
    expect(markdown).toContain(words);
    expect(markdown).toContain(NOT_LAUNCHED);
  });

  // Launch A only: its own pages stop saying "not launched" of launch A, show its addresses, and
  // say in so many words that the hire desk and the company are not live.
  it.each([
    ["/company", "payroll"],
    ["/seats", "payroll"],
    ["/seats/1998", "payroll"],
    ["/questions", "questions"],
    ["/jobs-report", "jobsReport"],
  ] as const)(
    "with launch A only, %s shows its contract's address and what is not live",
    async (path, key) => {
      const world = testSources({ book: BOOKS.aOnly });
      const loaded = await loadPath(path, ctxFor(world, path));
      const markdown = markdownTwin(loaded!);
      const contract = world.sources.deployments.contracts[key];
      expect(markdown).toContain(contract.address as string);
      expect(markdown).not.toContain(`${contract.name} is ${NOT_LAUNCHED}`);
      expect(markdown).not.toContain(`${contract.name} (launch A) is ${NOT_LAUNCHED}`);
      expect(markdown).not.toContain(`the ${contract.name} contract is ${NOT_LAUNCHED}`);
      expect(markdown).toContain(
        `The hire desk (launch B: WorkProof, WorkOrders, CrowdPots, Doorbell) is ${NOT_LAUNCHED}.`,
      );
      const model = loaded!.model as { notLive: string[] };
      expect(model.notLive.every((note) => note.includes(`is ${NOT_LAUNCHED}.`))).toBe(true);
      expect(model.notLive.some((note) => note.startsWith("The hire desk (launch B"))).toBe(true);
      // No address is printed for a contract of launch B or C.
      for (const other of Object.values(world.sources.deployments.contracts)) {
        if (other.launch !== "A") expect(other.address).toBeNull();
      }
    },
  );

  // Everything launched: no page says of any contract that it is not launched, and the slips about
  // launches that are not live are gone.
  it.each(EVERY_PATH)(
    "with everything launched, %s says of no contract that it is not launched",
    async (path) => {
      const world = testSources({ book: BOOKS.all });
      const loaded = await loadPath(path, ctxFor(world, path));
      const markdown = markdownTwin(loaded!);
      expect(markdown).not.toMatch(/is not launched yet|\(launch [ABC]\) is not launched/);
      expect(markdown).not.toContain("## What is not live\n");
      const model = loaded!.model as { notLive?: string[] };
      if (path !== "/judges" && model.notLive) expect(model.notLive).toEqual([]);
    },
  );

  it("answers 404 for a thing that cannot exist", async () => {
    const world = testSources();
    for (const path of [
      "/hire/teleport",
      "/orders/0",
      "/orders/x",
      "/pots/-1",
      "/seats/2000",
      "/seats/1.5",
      "/verify/xyz",
      "/nope",
    ]) {
      expect(await loadPath(path, ctxFor(world, path)), path).toBeNull();
    }
  });
});

describe("pages that work on today's data", () => {
  it("/ prints the swarm's state and the recent jobs as cards, with an honest empty desk", async () => {
    const loaded = await loadPath("/", ctxFor(testSources()));
    const model = loaded!.model as {
      headline: string;
      swarm: { online: number; working: number; idle: number; receiptsQueued: number };
      ourOrders: { launched: boolean; cards: unknown[]; count: number | null };
      jobs: {
        cards: {
          id: string;
          state: string;
          stamp: { text: string } | null;
          receipt: string | null;
          receiptRead: boolean;
        }[];
      };
    };
    expect(model.headline).toBe("900 robots online. 6 have work.");
    expect(model.swarm).toMatchObject({ online: 900, working: 6, idle: 894, receiptsQueued: 1774 });
    expect(model.ourOrders).toEqual({ launched: false, count: null, cards: [], error: null });
    expect(model.jobs.cards).toHaveLength(3);
    // A finished job the registry holds nothing for is FILLED, never RECEIPT ON CHAIN.
    const finished = model.jobs.cards.find((c) => c.state === "completed");
    expect(finished?.stamp?.text).toBe("FILLED");
    expect(finished?.receipt).toBeNull();
    expect(finished?.receiptRead).toBe(true);
    const markdown = markdownTwin(loaded!);
    expect(markdown).toContain("**900 robots online. 6 have work.**");
    expect(markdown).toContain("| Robots idle | 894 |");
    expect(markdown).toContain("Receipt in the WorkRegistry: none yet");
    // A job's objective is someone else's text: it is always printed as a quotation.
    expect(markdown).toMatch(/\n> A custom token: Tithe Demo/);
  });

  it("/ stamps RECEIPT ON CHAIN only for a finished job the registry answers for", async () => {
    const world = testSources({
      chain: { receipts: { "0x10d225a692cb4cde9d4bec076b078f7d": `0x${"77".repeat(32)}` } },
    });
    const loaded = await loadPath("/", ctxFor(world));
    const cards = (
      loaded!.model as {
        jobs: {
          cards: { id: string; stamp: { text: string } | null; receipt: string | null }[];
          withReceipt: number;
        };
      }
    ).jobs;
    expect(cards.cards.find((c) => c.id.startsWith("10d225a6"))?.stamp?.text).toBe("RECEIPT ON CHAIN");
    expect(cards.withReceipt).toBe(1);
    // One multicall asked about every ended job; no job was asked about one by one.
    expect(world.chain.calls.filter((c) => c === `eth_call ${MULTICALL3.toLowerCase()}`)).toHaveLength(1);
    expect(
      world.chain.calls.filter((c) => c === `eth_call ${MAINNET.WORK_REGISTRY.toLowerCase()}`),
    ).toHaveLength(0);
  });

  it("/ still renders, saying what it could not read, when both upstreams are down", async () => {
    const world = testSources({
      api: { fetch: (async () => new Response("no", { status: 503 })) as typeof fetch, calls: [] },
      chain: { failCalls: true },
    });
    const loaded = await loadPath("/", ctxFor(world));
    const model = loaded!.model as {
      headline: string;
      swarm: unknown;
      jobs: { cards: unknown[]; error: string };
    };
    expect(model.swarm).toBeNull();
    expect(model.headline).toBe("The swarm's state could not be read just now.");
    expect(model.jobs.cards).toEqual([]);
    expect(markdownTwin(loaded!)).toContain("could not be read");
  });

  it("/questions shows each house feed in plain words with its exact body and its one live answer", async () => {
    const loaded = await loadPath("/questions", ctxFor(testSources()));
    const model = loaded!.model as QuestionsModel;
    expect(model.launched).toBe(false);
    expect(model.feedCount).toBeNull();
    expect(model.houseFeeds.map((f) => f.name)).toEqual(["payrolls", "hires", "employers"]);
    for (const feed of model.houseFeeds) {
      // Nothing on chain yet, and the page does not pretend otherwise.
      expect(feed.live).toBeNull();
      expect(feed.id).toBe(HOUSE_FEEDS[feed.name].id);
      expect(feed.asks.length).toBeGreaterThan(60);
      expect(feed.cadence).toMatch(/^every [\d,]+ blocks, about /);
      // The exact text the contract stores, and the request that proved the oracle answers it.
      expect(feed.bodyPrefix).toBe(HOUSE_FEEDS[feed.name].qPrefixText);
      expect(feed.bodyTail).toBe(HOUSE_FEEDS[feed.name].tailText);
      expect(feed.proof.url).toMatch(/^https:\/\/api\.imd\.fun\/oracle\/requests\/[0-9a-f-]{36}$/);
      expect(feed.proof.bodyMatches, feed.name).toBe(true);
      expect(feed.proof.questionHashMatches, feed.name).toBe(true);
    }
    // Which answers IdentityMD recomputes and which rest on a panel is said, feed by feed.
    expect(model.houseFeeds.map((f) => f.recomputed)).toEqual([true, true, false]);
    expect(model.houseFeeds.map((f) => f.submitOpen)).toEqual([true, true, false]);
    expect(model.houseFeeds[0]?.proof.answer).toBe("114 IMD");
    expect(model.houseFeeds[1]?.proof.answer).toBe("228 transfers");
    expect(model.houseFeeds[2]?.proof.answer.split(", ")).toHaveLength(3);
    expect(model.keeper.connected).toBe(false);

    const markdown = markdownTwin(loaded!);
    expect(markdown).toContain("**The Questions contract is not launched yet** (launch A)");
    expect(markdown).toContain(
      "Payrolls and hires are recomputed by IdentityMD from chain data. The weekly employers list is settled by panel agreement",
    );
    expect(markdown).toContain("Settled by panel agreement.");
    expect(markdown).toContain("https://api.imd.fun/oracle/requests/3744d864-8cbf-4fcf-8a8c-3529fb1736cb");
    expect(markdown).toContain("https://api.imd.fun/oracle/requests/df50bf76-41a0-4596-ae9e-9dcfd0e1ccd5");
    expect(markdown).toContain("https://api.imd.fun/oracle/requests/2cbe6bb3-13f9-4617-98b9-5d83754f9e1a");
    expect(markdown).toContain("The request named no callback, so nothing was delivered to a contract.");
    expect(markdown).not.toContain("does NOT match");
    // The keeper tip: what it is, and that asking alone earns nothing.
    expect(markdown).toContain("It is earned only by an answered round");
    expect(markdown).toContain("collectTips()");
    expect(markdown).toContain("open after thirty minutes");
    // Every wallet action is there as a cast command too, with a placeholder for the address.
    expect(markdown).toContain('cast send $QUESTIONS "fund(bytes32,uint256)"');
    expect(markdown).toContain('cast send $QUESTIONS "collectTips()"');
    expect(markdown).toContain('cast send $ZAP "fundMeter(bytes32,uint256,uint256)"');
  });

  it("/questions lists the recorded requests of both Intakes and holds each count against its own counter", async () => {
    const loaded = await loadPath("/questions", ctxFor(testSources()));
    const model = loaded!.model as QuestionsModel;
    const { intake } = model;
    expect(intake.current).toMatchObject({ version: 2, nonce: 44, listed: 20, complete: false });
    expect(intake.legacy).toMatchObject({ version: 1, nonce: 13, listed: 12, complete: false });
    expect(intake.current.address).toBe(MAINNET.INTAKE);
    expect(intake.legacy.address).toBe(MAINNET.INTAKE_V1);
    expect(intake.current.priceWei).toBe(500_000_000_000_000_000n);
    expect(intake.rows).toHaveLength(32);
    // Newest first.
    expect(intake.rows.map((r) => r.block)).toEqual(
      [...intake.rows.map((r) => r.block)].sort((a, b) => b - a),
    );
    const { counts } = intake;
    expect(counts.listed).toBe(32);
    expect(counts.answered + counts.failed + counts.open).toBe(32);
    // The four requests a house wallet bought, to put the feed questions to the live oracle.
    expect(counts.ours).toBe(4);
    expect(intake.rows.filter((r) => r.house).every((r) => r.version === 1)).toBe(true);
    const markdown = markdownTwin(loaded!);
    expect(markdown).toContain("Its counter reads 44 and 20 of those requests are listed here");
    expect(markdown).toContain("Its counter reads 13 and 12 of those requests are listed here");
    expect(markdown).toContain("need an archive RPC");
    expect(markdown).toContain("Intake version 2");
    expect(markdown).toContain("Intake version 1");
  });

  it("/questions says a list is complete only when it has as many requests as the counter", async () => {
    const loaded = await loadPath(
      "/questions",
      ctxFor(testSources({ chain: { intakeNonce: 20n, intakeV1Nonce: 12n } })),
    );
    const model = loaded!.model as QuestionsModel;
    expect(model.intake.current).toMatchObject({ complete: true, nonce: 20 });
    expect(model.intake.legacy).toMatchObject({ complete: true, nonce: 12 });
    const markdown = markdownTwin(loaded!);
    expect(markdown).toContain("All 20 of its requests are listed: the count equals its own counter.");
    expect(markdown).toContain("All 12 of its requests are listed: the count equals its own counter.");
  });

  it("/judges answers in under 150 words what this is, and every check carries a command", async () => {
    const world = testSources();
    const loaded = await loadPath("/judges", ctxFor(world));
    const model = loaded!.model as JudgesModel;
    expect(model.summaryWords).toBe(model.summary.split(/\s+/).length);
    expect(model.summaryWords).toBeLessThanOrEqual(150);
    expect(model.summaryWords).toBeGreaterThan(110);
    expect(model.launchedCount).toBe(0);
    expect(model.contracts.map((c) => c.name)).toEqual([
      "Questions",
      "JobsReport",
      "Payroll",
      "WorkProof",
      "WorkOrders",
      "CrowdPots",
      "Doorbell",
      "Rules",
      "Endowments",
      "Zap",
    ]);
    for (const c of model.contracts) expect(c).toMatchObject({ address: null, label: NOT_LAUNCHED });

    // Every check: something read just now, at least one link, and a command that repeats it.
    expect(model.claims.length).toBeGreaterThanOrEqual(6);
    for (const claim of model.claims) {
      expect(claim.readNow, claim.claim).not.toBeNull();
      expect(claim.evidence.length, claim.claim).toBeGreaterThan(0);
      expect(claim.command, claim.claim).toMatch(/^(\[ |cast |curl )/);
    }
    expect(model.claims[0]?.readNow).toContain("PROVEN ON CHAIN");
    expect(model.claims.map((c) => c.readNow).join(" ")).toContain("121 IMD in 99 payments from 34 payers");
    expect(model.claims.map((c) => c.readNow).join(" ")).toContain("bound to seat #1998");
    expect(model.claims.map((c) => c.readNow).join(" ")).toContain(
      "Intake version 2: nonce() is 44. Version 1 (legacy): nonce() is 13.",
    );

    // The integration table: one row per IdentityMD primitive: where it is, what we do with it,
    // and where the proof is, or that there is none yet.
    const primitives = model.integration.map((r) => r.primitive).join(" | ");
    for (const name of [
      "WorkRegistry",
      "Work records",
      "Intake, version 2",
      "Intake, version 1 (legacy)",
      "Oracle attestations",
      "Audit jobs",
      "IMD",
      "sIMD",
      "Seats",
      "Seat Adapter",
      "launch pipeline",
      "x402",
      "Uniswap v4",
    ]) {
      expect(primitives).toContain(name);
    }
    for (const row of model.integration) {
      expect(row.where.length).toBeGreaterThan(10);
      expect(row.use.length).toBeGreaterThan(40);
      expect(["live", "built"]).toContain(row.status);
      expect(row.proofNote.length, row.primitive).toBeGreaterThan(10);
      for (const proof of row.proofs) expect(proof.url, row.primitive).toMatch(/^(https:\/\/|\/)/);
      // A row with no public record says there is none; it does not leave the cell empty.
      if (row.proofs.length === 0) expect(row.proofNote, row.primitive).toMatch(/^None yet/);
    }
    for (const address of [
      MAINNET.WORK_REGISTRY,
      MAINNET.INTAKE,
      MAINNET.INTAKE_V1,
      MAINNET.ORACLE_SIGNER,
      MAINNET.IMD,
      MAINNET.SIMD,
      MAINNET.SEATS,
      MAINNET.SEAT_ADAPTER,
      MAINNET.PROJECT_FACTORY,
    ]) {
      expect(model.integration.some((r) => r.where.includes(address))).toBe(true);
    }
    // No row gives an address for one of our own contracts: none exists.
    expect(model.integration.flatMap((r) => r.contracts).every((c) => c.address === null)).toBe(true);

    expect(model.notLive.filter((line) => line.startsWith("Launch "))).toHaveLength(3);
    const commands = model.reproduce.map((r) => r.commands).join("\n");
    expect(commands).toContain(
      "cd launches/a-payroll\nforge build --sizes\nforge test\nFOUNDRY_PROFILE=fork forge test",
    );
    expect(commands).toContain("pnpm --filter @help-wanted/shared test");
    expect(commands).toContain("pnpm --filter @help-wanted/web test");

    const markdown = markdownTwin(loaded!);
    for (const heading of [
      "## What this is",
      "## Where the launches stand",
      "## Proven on the live system",
      "### 1. The live oracle answers the three house feed questions",
      "### 2. IdentityMD's agents audited launch A twice",
      "### 3. A real job that carried our order header into its work record",
      "## What anyone can check on the live protocol today",
      "## Integration: one row per IdentityMD primitive",
      "## Reproduce",
      "## Every disclosed limit",
      "## Launch B: the receipt check and the hire desk",
      "## What is not live yet",
      "## House wallets",
    ]) {
      expect(markdown).toContain(heading);
    }
  });

  it("/judges says where launch A stands from IdentityMD's own record of its job, and how the pages switch on", async () => {
    const world = testSources();
    const model = (await loadPath("/judges", ctxFor(world)))!.model as JudgesModel;
    expect(model.pipeline.jobId).toBe("d8bb3d81-820d-42f4-ad7c-1d3ed96b1da8");
    expect(model.pipeline.jobUrl).toBe("https://api.imd.fun/jobs/d8bb3d81-820d-42f4-ad7c-1d3ed96b1da8");
    expect(model.pipeline.read).toMatchObject({
      state: "executing",
      template: "shape:chain",
      paidByHouse: "W1",
      launchKind: "evm_contracts",
      launchStatus: null,
    });
    expect(model.pipeline.words).toContain(`IdentityMD's API gives the job's state as "executing".`);
    expect(model.pipeline.words).toContain("The pipeline has not reported a launch for it yet.");
    const a = model.launches.find((l) => l.key === "A");
    expect(a?.launched).toBe(false);
    // With no launch in the book, the page says what its book says and what IdentityMD's API says
    // of the job; it does not decide between them.
    expect(a?.status).toContain("Not launched: the deployments book holds no address for it.");
    expect(a?.status).toContain(
      "Its job in IdentityMD's launch pipeline is d8bb3d81-820d-42f4-ad7c-1d3ed96b1da8",
    );
    expect(a?.status).toContain(`IdentityMD's API gives the job's state as "executing".`);
    // Whether a launch's source is public follows the site's own record of it, launch by launch.
    for (const key of ["B", "C"] as const) {
      const status = model.launches.find((l) => l.key === key)?.status ?? "";
      expect(status).toContain("Not launched: the deployments book holds no address for it.");
      expect(status).toContain(sourceWords(key));
    }
    expect(model.launches.find((l) => l.key === "C")?.status).toContain(
      "It takes addresses that launches A and B create, and launch A and launch B have none yet.",
    );
    expect(model.switchOn).toContain("packages/shared/src/deployments.ts");
    expect(model.switchOn).toContain("switch on from that one edit");

    // When the API cannot be read, the page says so and still gives the link and the command.
    const down = testSources({
      api: { fetch: (async () => new Response("no", { status: 503 })) as typeof fetch, calls: [] },
    });
    const blind = (await loadPath("/judges", ctxFor(down)))!.model as JudgesModel;
    expect(blind.pipeline.read).toBeNull();
    expect(blind.pipeline.words).toContain("could not be read from IdentityMD's API just now");
    expect(blind.pipeline.command).toContain("curl -s https://api.imd.fun/jobs/d8bb3d81");
    expect(blind.launches.find((l) => l.key === "A")?.status).toContain("Not launched: ");
  });

  it("/judges gives the three things proven on the live system, each with its public link", async () => {
    const world = testSources();
    const loaded = await loadPath("/judges", ctxFor(world, "/judges"));
    const model = loaded!.model as JudgesModel;

    // 1. The three house feed questions, answered by the live oracle.
    expect(model.feedProofs.rows.map((r) => r.oracleRequestId)).toEqual([
      "3744d864-8cbf-4fcf-8a8c-3529fb1736cb",
      "df50bf76-41a0-4596-ae9e-9dcfd0e1ccd5",
      "2cbe6bb3-13f9-4617-98b9-5d83754f9e1a",
    ]);
    for (const row of model.feedProofs.rows) {
      expect(row.url).toBe(`https://api.imd.fun/oracle/requests/${row.oracleRequestId}`);
      expect(row.requestTxUrl).toMatch(/^https:\/\/etherscan\.io\/tx\/0x[0-9a-f]{64}$/);
      expect(row.bodyMatches && row.questionHashMatches, row.feed).toBe(true);
      expect(row.command).toContain(`curl -s ${row.url}`);
    }
    expect(model.feedProofs.rows.map((r) => r.settled)).toEqual([
      "recomputed by IdentityMD from chain data",
      "recomputed by IdentityMD from chain data",
      "settled by panel agreement",
    ]);
    // What the three answers do not show is said beside them.
    expect(model.feedProofs.limit).toContain("no answer was delivered to a contract");

    // 2. The two audits, every finding with what was done about it.
    expect(model.audits.reports.map((r) => r.reportUrl)).toEqual([
      "https://api.imd.fun/jobs/be91e8ae-9f45-495f-a318-60fab672a92e/report.md",
      "https://api.imd.fun/jobs/22624be0-d2da-400e-91c4-51dac0a9a7f5/report.md",
    ]);
    const findings = model.audits.reports.flatMap((r) => r.findings);
    expect(findings.map((f) => f.id)).toEqual([
      "1.1",
      "1.2",
      "1.3",
      "1.4",
      "2.1",
      "2.2",
      "2.3",
      "2.4",
      "2.5",
    ]);
    for (const finding of findings) expect(finding.done.length, finding.id).toBeGreaterThan(20);
    expect(model.audits.counts).toEqual({ fixed: 5, "documents corrected": 2, "left open": 1, left: 1 });
    // The finding left open is shown as left open, and the fixes are not called audited.
    expect(findings.find((f) => f.id === "2.1")?.outcome).toBe("left open");
    expect(model.audits.after).toContain("have not been audited again");

    // 3. The header job: its record carries our header; its receipt is not on chain, and the page
    // says that in so many words instead of claiming a proof.
    const h = model.headerJob;
    expect(h.jobId).toBe("e70c56ce-60f0-4c2c-b413-67e5ae37ddce");
    expect(h.recordHash).toBe("0x990ae775288252e4b1b12c4a85bbe66db0140ca733e30002a6525814bfdaa17d");
    expect(h.jobUrl).toBe("https://api.imd.fun/jobs/e70c56ce-60f0-4c2c-b413-67e5ae37ddce");
    expect(h.recordUrl).toBe(
      "https://api.imd.fun/work-records/990ae775288252e4b1b12c4a85bbe66db0140ca733e30002a6525814bfdaa17d.json",
    );
    expect(h.header).toHaveLength(85);
    expect(h.header).toBe(
      "[help-wanted order de7eddaacedc4110cb3ca3388ecec4dae5bda3eae85c721452c078dc71592041] ",
    );
    expect(h.record).toEqual({
      origin: "identitymd",
      bytes: 3552,
      hashes: true,
      headerUnchanged: true,
      jobIdMatches: true,
      kind: "skill:research-report",
      state: "completed",
    });
    expect(h.job).toMatchObject({ state: "completed", paidByHouse: "W1", objectiveHasHeader: true });
    expect(h.listed).toEqual({ status: "queued", txHash: null });
    expect(h.receipt.value).toBe(`0x${"0".repeat(64)}`);
    expect(h.receipt.onChain).toBe(false);
    expect(h.notShown).toContain("Not shown: a receipt on chain.");
    expect(h.notShown).toContain("WorkRegistry.latest for this job read zero");
    expect(h.notShown).toContain(`IdentityMD's API lists the record as "queued", with no transaction.`);
    expect(h.notShown).toContain("not a proof on chain");
    expect(h.commands.map((c) => c.command).join("\n")).toContain(
      `cast call ${MAINNET.WORK_REGISTRY} "latest(bytes16)(bytes32)" 0xe70c56ce60f04c2cb41367e5ae37ddce`,
    );
    const markdown = markdownTwin(loaded!);
    expect(markdown).toContain("**Not shown: a receipt on chain.");
    expect(markdown).not.toContain("The receipt is on chain");
    expect(model.notLive.join(" ")).toContain("The header job's receipt is not on chain.");
    // The registry was asked about the header job in a read of its own account, once.
    expect(
      world.chain.calls.filter((c) => c === `eth_call ${MAINNET.WORK_REGISTRY.toLowerCase()}`).length,
    ).toBeLessThanOrEqual(2);
  });

  it("/judges switches the header job to proven by itself once the registry holds its record's hash", async () => {
    const world = testSources({ chain: { receipts: { [HEADER_JOB.jobIdBytes16]: HEADER_JOB.recordHash } } });
    const loaded = await loadPath("/judges", ctxFor(world, "/judges"));
    const model = loaded!.model as JudgesModel;
    expect(model.headerJob.receipt).toMatchObject({ value: HEADER_JOB.recordHash, onChain: true });
    expect(model.headerJob.notShown).toBeNull();
    expect(model.notLive.join(" ")).not.toContain("The header job's receipt is not on chain");
    expect(markdownTwin(loaded!)).toContain("**The receipt is on chain:**");
    // A different hash under that job is not this record's receipt, and is not called one.
    const other = testSources({ chain: { receipts: { [HEADER_JOB.jobIdBytes16]: `0x${"12".repeat(32)}` } } });
    const wrong = (await loadPath("/judges", ctxFor(other)))!.model as JudgesModel;
    expect(wrong.headerJob.receipt.onChain).toBe(false);
    expect(wrong.headerJob.notShown).toContain("which is not this record's hash");
  });

  it("/judges says nothing about the header job's receipt when the registry cannot be read", async () => {
    const world = testSources({ chain: { failCalls: true }, storedReferenceRecord: true });
    const model = (await loadPath("/judges", ctxFor(world)))!.model as JudgesModel;
    expect(model.headerJob.receipt).toMatchObject({ value: null, onChain: null });
    expect(model.headerJob.notShown).toContain("The WorkRegistry could not be read for this page");
    expect(model.headerJob.notShown).toContain("nothing is said here about the receipt");
  });

  it("/judges prints every disclosed limit of the three threat documents in one table", async () => {
    const loaded = await loadPath("/judges", ctxFor(testSources(), "/judges"));
    const model = loaded!.model as JudgesModel;
    expect(model.limits.total).toBe(model.limits.rows.length);
    expect(model.limits.total).toBeGreaterThan(150);
    expect(model.limits.documents.map((d) => d.path)).toEqual([
      "launches/a-payroll/docs/THREATS.md",
      "launches/b-desk/docs/THREATS.md",
      "launches/c-company/docs/THREATS.md",
    ]);
    expect(model.limits.documents.reduce((sum, d) => sum + d.count, 0)).toBe(model.limits.total);
    for (const row of model.limits.rows) {
      expect(["A", "B", "C"]).toContain(row.launch);
      expect(row.text.length, `${row.launch} ${row.id}`).toBeGreaterThan(15);
    }
    // A row a later event has overtaken keeps the document's words and says what happened since.
    const overtaken = model.limits.rows.find((r) => r.launch === "A" && r.id === "B3");
    expect(overtaken?.text).toContain("Nothing is called after deployment.");
    expect(overtaken?.since).toContain("the three feeds were created the same day");
    const markdown = markdownTwin(loaded!);
    expect(markdown).toContain("| Launch | Entry | Part of the document | The limit | Since |");
    expect(markdown.split("\n").filter((line) => /^\| [ABC] \| [A-Z]+\d+ \|/.test(line))).toHaveLength(
      model.limits.total,
    );
  });

  it("/judges describes launch B from its documents and gives it no address while it has none", async () => {
    for (const bookName of ["none", "aOnly"] as const) {
      const loaded = await loadPath("/judges", ctxFor(testSources({ book: BOOKS[bookName] }), "/judges"));
      const model = loaded!.model as JudgesModel;
      expect(model.desk.intro).toContain("It has no address: it is not launched.");
      // Whether its source is public is said from the site's record of it, not assumed.
      expect(model.desk.intro).toContain(sourceWords("B"));
      expect(model.desk.head).toContain(PUBLIC_SOURCE.B ? "source public on branch" : "not public yet");
      expect(model.desk.head).toContain("no address");
      expect(model.desk.points.join(" ")).toContain(
        "keccak256 of a job's work record, as served, equals WorkRegistry.latest(jobId)",
      );
      const markdown = markdownTwin(loaded!);
      const section = markdown.slice(
        markdown.indexOf("## Launch B: the receipt check and the hire desk"),
        markdown.indexOf("## What is not live yet"),
      );
      expect(section, bookName).not.toMatch(/0x[0-9a-fA-F]{40}/);
    }
    // With launch B in the book, the same section says so.
    const launched = (await loadPath("/judges", ctxFor(testSources({ book: BOOKS.all }), "/judges")))!
      .model as JudgesModel;
    expect(launched.desk.intro).toContain(
      "It is launched: its addresses are in the table of contracts above.",
    );
    expect(launched.desk.head).toContain("launched");
    expect(launched.desk.head).not.toContain("no address");
  });

  it("/judges shows an address the moment the deployments book (or its override) has it", async () => {
    const desk = "0x00000000000000000000000000000000000000d1";
    const world = testSources({ env: { HW_ADDR_WORK_ORDERS: desk } });
    const loaded = await loadPath("/judges", ctxFor(world));
    const model = loaded!.model as JudgesModel;
    expect(model.launchedCount).toBe(1);
    expect(model.contracts.find((c) => c.name === "WorkOrders")?.address?.toLowerCase()).toBe(desk);
    expect(model.contracts.filter((c) => c.address === null)).toHaveLength(CONTRACT_KEYS.length - 1);
    // Launch B is still listed as not live: three of its four contracts have no address.
    expect(model.notLive.some((line) => line.startsWith("Launch B"))).toBe(true);
    expect(model.launches.find((l) => l.key === "B")).toMatchObject({ launched: false });
  });

  it("/judges says the escrow's second way of paying wherever it says the first", async () => {
    const world = testSources();
    const model = (await loadPath("/judges", ctxFor(world)))!.model as JudgesModel;
    // The desk also pays an unchallenged bonded claim when the employer allowed one. A summary that
    // said "pays only when proven" would be an overclaim a judge can check against the contract.
    expect(model.summary).not.toMatch(/pays only|only when the job/);
    expect(model.summary).toContain(
      "or, only if the employer allowed it, when a bonded delivery claim goes unchallenged for 24 hours",
    );
    const everywhere = [
      markdownTwin((await loadPath("/", ctxFor(world)))!),
      markdownTwin((await loadPath("/hire", ctxFor(world, "/hire")))!),
      markdownTwin((await loadPath("/rules/new", ctxFor(world, "/rules/new")))!),
      await llmsTxt(ctxFor(world)),
    ].join("\n");
    expect(everywhere).not.toMatch(
      /pays only when|pay only when|pays only on proven|only on a receipt proven/,
    );
    // Both limits of the claim path are disclosed to the employer on the form itself.
    const hire = markdownTwin((await loadPath("/hire/audit", ctxFor(world, "/hire/audit")))!);
    expect(hire).toContain("A claim that is untrue and that nobody challenges within 24 hours is paid");
    expect(hire).toContain("A challenge that nothing decides refunds you, even when the claim was true");
    expect(hire).toContain("it is ticked only while IdentityMD's receipts are stalled");
  });

  it("/judges keeps to 150 words whatever is launched, and its last sentence follows the deployments book", () => {
    const names = Object.values(deploymentEnvNames());
    const address = (i: number) => `0x${(i + 1).toString(16).padStart(40, "0")}`;
    const launched = (count: number) =>
      resolveDeployments(
        Object.fromEntries(names.slice(0, count).map((name, i) => [name, address(i)])),
        BOOKS.none,
      );
    expect(summaryFor(launched(0))).toBe(SUMMARY);
    expect(launchSentence(launched(0))).toBe("No contract of ours is launched yet.");
    expect(launchSentence(launched(3))).toBe("3 of our 10 contracts are launched (launch A).");
    expect(launchSentence(launched(5))).toBe("5 of our 10 contracts are launched (launch A).");
    expect(launchSentence(launched(7))).toBe("7 of our 10 contracts are launched (launches A and B).");
    expect(launchSentence(launched(10))).toBe("All 10 of our contracts are launched.");
    for (let count = 0; count <= 10; count++) {
      const words = summaryFor(launched(count)).split(/\s+/).length;
      expect(words, `${count} launched`).toBeLessThanOrEqual(150);
      expect(words).toBeGreaterThan(130);
    }
    // The three books, and the real one: the sentence names the launches that are whole.
    expect(launchSentence(resolveDeployments({}, BOOKS.none))).toBe("No contract of ours is launched yet.");
    expect(launchSentence(resolveDeployments({}, BOOKS.aOnly))).toBe(
      "3 of our 10 contracts are launched (launch A).",
    );
    expect(launchSentence(resolveDeployments({}, BOOKS.all))).toBe("All 10 of our contracts are launched.");
    expect(launchSummaryFor(resolveDeployments({}, BOOKS.none))).toBe(
      "Nothing is launched yet. Each of our ten contracts is not launched yet.",
    );
    expect(launchSummaryFor(resolveDeployments({}, BOOKS.aOnly))).toBe(
      "3 of 10 contracts are launched: launch A (Payroll and Questions). Not launched yet: launch B (the hire desk) and launch C (the company).",
    );
    expect(launchSummaryFor(resolveDeployments({}, BOOKS.all))).toBe("All 10 contracts are launched.");
    const today = resolveDeployments({});
    expect(summaryFor(today).split(/\s+/).length).toBeLessThanOrEqual(150);
    for (const key of launchedIn(DEPLOYMENT_BOOK)) {
      expect(launchSentence(today)).toMatch(new RegExp(`launch(es)? [A-C and]*${key}|All 10`));
    }
  });

  it("/judges stops saying nothing is launched once the contracts have addresses", async () => {
    const env: Record<string, string> = {};
    Object.values(deploymentEnvNames()).forEach((name, index) => {
      env[name] = `0x${(index + 1).toString(16).padStart(40, "0")}`;
    });
    const world = testSources({ env });
    const model = (await loadPath("/judges", ctxFor(world)))!.model as JudgesModel;
    expect(model.launchedCount).toBe(10);
    expect(model.contracts.every((c) => c.address !== null)).toBe(true);

    // Every statement about what is launched follows the book, as the contracts table does.
    expect(model.summary).toContain("All 10 of our contracts are launched.");
    expect(model.summary).not.toContain("No contract of ours is launched yet");
    const rows = model.integration.filter((row) => row.contracts.length > 0);
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row.launch, row.primitive).toBe("launched");
      expect(row.launchLabel).toBe("Launched");
      expect(row.statusWords, row.primitive).not.toContain("not launched yet");
      expect(row.statusWords).toContain(" at 0x");
    }
    expect(model.notLive.filter((line) => line.startsWith("Launch "))).toEqual([]);
    expect(model.notLive.join(" ")).not.toContain("buttons stay disabled");
    expect(model.notLive.join(" ")).not.toContain("No fee has been split");
    expect(model.launches.every((l) => l.launched)).toBe(true);
    // Addresses without a launch transaction on record are reported as exactly that.
    for (const launch of model.launches) {
      expect(launch.status).toBe("Addresses are filled in, but no launch transaction is recorded with them.");
    }
    const pipeline = model.integration.find((row) => row.primitive === "The launch pipeline");
    expect(pipeline?.statusWords).toBe(
      "Addresses are filled in, but no launch transaction is recorded with them in the deployments book.",
    );
    expect(pipeline?.usage).toMatchObject({ count: "0 of 3" });
    // These fake addresses hold no contract, so nothing can be counted, and the page says why
    // instead of printing zeros.
    expect(model.notLive.join(" ")).toContain("Whether any fee has been split could not be read just now");
    const markdown = markdownTwin((await loadPath("/judges", ctxFor(world, "/judges")))!);
    expect(markdown).toContain("All 10 contracts are launched.");
    expect(markdown).not.toContain("**Nothing is launched yet.**");
  });

  it("/judges marks a primitive partly launched when only some of the contracts that use it are", async () => {
    const world = testSources({ env: { HW_ADDR_WORK_ORDERS: "0x00000000000000000000000000000000000000d1" } });
    const model = (await loadPath("/judges", ctxFor(world)))!.model as JudgesModel;
    const registry = model.integration.find((row) => row.primitive.startsWith("WorkRegistry"));
    expect(registry).toMatchObject({ launch: "partly", launchLabel: "Partly launched" });
    expect(registry?.statusWords).toContain("WorkOrders at 0x00000000000000000000000000000000000000D1");
    expect(registry?.statusWords).toContain("Not launched yet: WorkProof.");
    const intake = model.integration.find((row) => row.primitive.startsWith("Intake, version 2"));
    expect(intake).toMatchObject({ launch: "not_launched", launchLabel: "Built, not launched" });
    expect(model.summary).toContain("1 of our 10 contracts are launched.");
  });

  it("/judges gives each integration row a count, or the reason there is none", async () => {
    const model = (await loadPath("/judges", ctxFor(testSources())))!.model as JudgesModel;
    for (const row of model.integration) {
      expect(row.usage.count === null ? row.usage.reason : row.usage.count, row.primitive).toBeTruthy();
      expect(row.usage.what.length).toBeGreaterThan(5);
    }
    // Before any launch the only thing there is to count is what house wallets paid the swarm.
    const paid = model.integration.find((row) => row.primitive.includes("x402"));
    expect(paid?.usage).toEqual({
      count: "0",
      what: "payments to the fee address from house wallets and contracts, in the newest day of blocks",
      reason: null,
    });
    // Its proof is the header job, and the row says what that job does not yet prove.
    expect(paid?.proofs[0]?.url).toBe("https://api.imd.fun/jobs/e70c56ce-60f0-4c2c-b413-67e5ae37ddce");
    expect(paid?.proofNote).toContain("this is not yet a proof on chain");
    const registry = model.integration.find((row) => row.primitive.startsWith("WorkRegistry"));
    expect(registry?.usage).toMatchObject({ count: null, reason: "WorkOrders is not launched yet" });
    // A row no contract of ours is part of says so, instead of "built, not launched".
    for (const row of model.integration.filter(
      (r) => r.contracts.length === 0 && r.primitive !== "The launch pipeline",
    )) {
      expect(row, row.primitive).toMatchObject({ launch: "none", launchLabel: "Done from a wallet" });
    }
    const oracle = model.integration.find((row) => row.primitive === "Oracle attestations");
    expect(oracle?.proofs.map((p) => p.url)).toEqual(model.feedProofs.rows.map((r) => r.url));
    expect(oracle?.usage).toMatchObject({ count: null, reason: "Questions is not launched yet" });
    const markdown = markdownTwin((await loadPath("/judges", ctxFor(testSources(), "/judges")))!);
    expect(markdown).toContain(
      "| Primitive | Address or endpoint | What we do with it | Status | Where the proof is |",
    );
    expect(markdown).toContain("Nothing to count: WorkOrders is not launched yet.");
  });

  it("/judges claims no bot it cannot point to, and says plainly what has not been tried", async () => {
    const model = (await loadPath("/judges", ctxFor(testSources())))!.model as JudgesModel;
    const said = model.notLive.join(" ");
    expect(said).toContain("bots/keeper, bots/runner, apps/indexer");
    expect(said).toContain("None has anything to act on yet");
    expect(said).not.toContain("We run the default one");
    expect(said).toContain("no transaction has been signed through this site");
    expect(said).toContain("have run only against stand-ins in its tests");
    expect(said).toContain("have not been audited again");
    // The three programs it names are in the repository, when the repository is around this app.
    if (existsSync(`${ROOT}bots`)) {
      for (const dir of ["bots/keeper", "bots/runner", "apps/indexer"]) {
        expect(existsSync(`${ROOT}${dir}/package.json`), dir).toBe(true);
      }
    }
  });

  it("/seats/1998 reads the owner live and names the agent seen bound to it", async () => {
    const loaded = await loadPath("/seats/1998", ctxFor(testSources()));
    const model = loaded!.model as { owner: string; agents: string[]; claimableImd: string | null };
    expect(model.owner).toBe("0xf98c3bf5f3544f64e60560304b58dca900a3c4db");
    expect(model.agents).toEqual(["52211"]);
    expect(model.claimableImd).toBeNull();
  });
});

describe("the real deployments book, whatever it holds today", () => {
  // Nothing here names a launch. Each statement is derived from the shared book, so writing launch
  // B and then launch C into it changes what these tests expect, never whether they pass.
  const today = resolveDeployments({});
  const flat = flattenBook(DEPLOYMENT_BOOK);
  const live = launchedIn(DEPLOYMENT_BOOK);
  const world = () => testSources({ book: DEPLOYMENT_BOOK });

  it("every page loads, and none prints an address the book does not hold", async () => {
    const ours = new Set(
      Object.values(flat)
        .filter((value): value is `0x${string}` => typeof value === "string")
        .map((address) => address.toLowerCase()),
    );
    const sources = world();
    for (const path of EVERY_PATH) {
      const loaded = await loadPath(path, ctxFor(sources, path));
      expect(loaded, path).not.toBeNull();
      const markdown = markdownTwin(loaded!);
      for (const leak of ["undefined", "[object Object]", "NaN"]) expect(markdown, path).not.toContain(leak);
      // Any address a test book would have invented is absent: only the real book's are ours.
      for (const book of Object.values(BOOKS)) {
        for (const address of Object.values(flattenBook(book))) {
          if (typeof address === "string" && !ours.has(address.toLowerCase())) {
            expect(markdown.toLowerCase(), path).not.toContain(address.toLowerCase());
          }
        }
      }
    }
  });

  it("/judges, /llms.txt and /api/v1/deployments say of each launch what the book says", async () => {
    const sources = world();
    const model = (await loadPath("/judges", ctxFor(sources, "/judges")))!.model as JudgesModel;
    expect(model.launchedCount).toBe(today.launchedCount);
    expect(model.summary).toBe(summaryFor(today));
    expect(model.launchSummary).toBe(launchSummaryFor(today));
    for (const launch of model.launches) {
      const book = DEPLOYMENT_BOOK[launch.key.toLowerCase() as "a" | "b" | "c"];
      const launched = isLaunched(launch.key.toLowerCase() as "a" | "b" | "c");
      expect(launch.launched, launch.key).toBe(launched);
      expect(launch.launchNumber).toBe(book.launchNumber);
      expect(launch.txUrl).toBe(book.transaction ? `https://etherscan.io/tx/${book.transaction}` : null);
      if (launched) {
        expect(launch.status).toContain("Launched");
        if (book.block !== null) expect(launch.status).toContain(book.block.toLocaleString("en-US"));
        if (book.launchNumber !== null) expect(launch.status).toContain(String(book.launchNumber));
      } else {
        expect(launch.status).toContain("Not launched: the deployments book holds no address for it.");
      }
      // A launch that is not live is in the list of what is not live; a live one is not.
      expect(model.notLive.some((line) => line.startsWith(`Launch ${launch.key} (`))).toBe(!launched);
    }
    for (const contract of model.contracts) {
      expect(contract.address, contract.name).toBe(flat[contract.key]);
      expect(contract.label).toBe(flat[contract.key] ?? NOT_LAUNCHED);
    }
    const text = await llmsTxt(ctxFor(sources));
    expect(text).toContain(`**${launchSentence(today)}**`);
    expect(text).toContain(`${today.launchedCount} of 10 HELP WANTED contracts launched.`);
    for (const page of STATIC_PATHS) {
      const waits = !isLivePath(page, today) && page.needs !== null;
      const said = text.includes(
        `[${page.label}](https://help-wanted.test${twinPaths(page.path).md}): ${page.blurb} Not live until`,
      );
      expect(said, page.path).toBe(waits);
    }
  });

  it("the launch-A pages say plainly which later launches are not live", async () => {
    const sources = world();
    for (const path of ["/questions", "/jobs-report", "/company", "/seats", "/seats/1998"]) {
      const loaded = await loadPath(path, ctxFor(sources, path));
      const notes = (loaded!.model as { notLive: string[] }).notLive;
      // One note at most for each launch that is not live, and none for one that is.
      for (const key of ["A", "B", "C"] as const) {
        const about = notes.filter((note) => note.includes(`(launch ${key}: `));
        if (live.includes(key)) expect(about, `${path} ${key}`).toEqual([]);
        else expect(about.length, `${path} ${key}`).toBeLessThanOrEqual(1);
      }
      if (!live.includes("B")) {
        expect(
          notes.some((note) => note.startsWith("The hire desk (launch B: ")),
          path,
        ).toBe(true);
        expect(markdownTwin(loaded!), path).toContain("## What is not live");
      }
    }
  });
});

describe("sample data mode", () => {
  it("is off unless asked for, and when on, every form of every page says so", async () => {
    const world = testSources({ env: { HW_SAMPLE_DATA: "1" } });
    expect(world.sources.env.sampleData).toBe(true);
    for (const path of ["/", "/orders", "/orders/4", "/pots", "/pots/3", "/judges"]) {
      const loaded = await loadPath(path, ctxFor(world, path));
      expect(jsonTwin(loaded!).sampleData).toBe(true);
      expect(markdownTwin(loaded!)).toContain("> SAMPLE DATA: this server was started in sample mode.");
    }
    const orders = await loadPath("/orders", ctxFor(world, "/orders"));
    const cards = (orders!.model as { cards: { sample: boolean; headline: string }[] }).cards;
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((c) => c.sample)).toBe(true);
    expect(markdownTwin(orders!)).toContain("(SAMPLE)");
    // Sample orders never make a contract look launched: the book this world was given holds none.
    expect(world.sources.deployments.launchedCount).toBe(0);
    expect(testSources({ env: { HW_SAMPLE_DATA: "0" } }).sources.env.sampleData).toBe(false);
    expect(testSources({ env: {} }).sources.env.sampleData).toBe(false);
  });
});

describe("the root files", () => {
  it("/llms.txt says what this is, what is not launched, and how to check the central claim", async () => {
    const text = await llmsTxt(ctxFor(testSources()));
    expect(text.startsWith("# HELP WANTED\n")).toBe(true);
    expect(text).toContain("900 robots online, 6 with work");
    expect(text).toContain("121 IMD paid to the swarm's fee address in 99 payments from 34 payers");
    expect(text).toContain("0 of 10 HELP WANTED contracts launched.");
    expect(text).toContain("https://help-wanted.test/judges.md");
    expect(text).toContain(
      `cast call ${MAINNET.WORK_REGISTRY} "latest(bytes16)(bytes32)" 0xe9efec1656f340d3924352c453effc7d`,
    );
    expect(text.match(/not launched yet/g)?.length).toBeGreaterThanOrEqual(10);
    for (const page of STATIC_PATHS)
      expect(text).toContain(`https://help-wanted.test${twinPaths(page.path).md}`);
    for (const route of API_ROUTES) expect(text).toContain(`\`${route.path}\``);
    for (const address of [MAINNET.IMD, MAINNET.SIMD, MAINNET.SEATS, MAINNET.INTAKE, MAINNET.INTAKE_V1]) {
      expect(text).toContain(address);
    }
    // Where launch A stands, and the one place every page switches on from.
    expect(text).toContain("Launch A (Questions, JobsReport, Payroll) is in IdentityMD's launch pipeline");
    expect(text).toContain("https://api.imd.fun/jobs/d8bb3d81-820d-42f4-ad7c-1d3ed96b1da8");
    expect(text).toContain("packages/shared/src/deployments.ts");
    // What has been proven on the live system, each with its link; and what has not.
    expect(text).toContain("## Proven on the live system");
    expect(text).toContain("https://api.imd.fun/oracle/requests/3744d864-8cbf-4fcf-8a8c-3529fb1736cb");
    expect(text).toContain("https://api.imd.fun/jobs/be91e8ae-9f45-495f-a318-60fab672a92e/report.md");
    expect(text).toContain("https://api.imd.fun/jobs/22624be0-d2da-400e-91c4-51dac0a9a7f5/report.md");
    expect(text).toContain("Its on-chain receipt is still queued at IdentityMD");
    expect(text).toContain("so this is not a proof on chain");
    expect(text).toContain(
      "Oracle requests ever bought on chain: 44 through the mainnet Intake (version 2) and 13",
    );
    // A page that waits for a contract says which one.
    expect(text).toContain("Not live until WorkOrders is launched");
    expect(text).toContain("Not live until Payroll is launched");
  });

  it("/llms-full.txt carries every fixed page's Markdown, the judges page first", async () => {
    const text = await llmsFullTxt(ctxFor(testSources()));
    expect(text.indexOf("# For judges")).toBeGreaterThan(0);
    expect(text.indexOf("# For judges")).toBeLessThan(text.indexOf("# The Work Wire"));
    for (const title of [
      "# The Work Wire",
      "# Verify a job",
      "# The Robot Jobs Report (unofficial tally)",
      "# Questions",
      "# Hire the swarm",
      "# Crowd pots",
      "# Say when",
      "# The company ledger",
      "# Seats",
      "# Endowments",
      "# Runners",
      "# PROVEN ON CHAIN: job e9efec16",
    ]) {
      expect(text, title).toContain(`\n${title}\n`);
    }
  });

  it("/robots.txt allows everything and names the sitemap", () => {
    const text = robotsTxt(ctxFor(testSources()));
    expect(text).toContain("User-agent: *\nAllow: /\n");
    expect(text).not.toContain("Disallow");
    expect(text).toContain("Sitemap: https://help-wanted.test/sitemap.xml");
  });

  it("/sitemap.xml lists every fixed page in all three forms", () => {
    const xml = sitemapXml(ctxFor(testSources())) ?? "";
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    for (const page of STATIC_PATHS) {
      const twins = twinPaths(page.path);
      for (const loc of [twins.html, twins.json, twins.md]) {
        expect(xml).toContain(`<loc>https://help-wanted.test${loc}</loc>`);
      }
    }
    expect(xml).toContain(`<loc>https://help-wanted.test${REFERENCE}.md</loc>`);
    expect(xml).toContain("<loc>https://help-wanted.test/llms.txt</loc>");
    expect(xml.match(/<url>/g)?.length).toBe((STATIC_PATHS.length + 1 + TEMPLATES.length) * 3 + 4);
  });

  it("prints no address of its own that it was not told: no localhost in a sitemap, a twin or llms.txt", async () => {
    // The request arrives as http://localhost:4321 whatever the visitor typed, because the server
    // does not believe the Host header. Nothing may be built from that.
    const world = testSources({ env: { SITE_ORIGIN: "" } });
    const ctx = { ...ctxFor(world), url: new URL("http://localhost:4321/judges") };
    expect(world.sources.env.siteOrigin).toBeNull();
    expect(sitemapXml(ctx)).toBeNull();
    expect(robotsTxt(ctx)).not.toContain("Sitemap:");
    expect(robotsTxt(ctx)).toContain("Allow: /");
    const llms = await llmsTxt(ctx);
    expect(llms).not.toContain("localhost");
    expect(llms).toContain("](/judges.md)");
    expect(llms).not.toContain("sitemap.xml");
    const judges = await loadPath("/judges", ctx);
    const markdown = markdownTwin(judges!);
    expect(markdown).not.toContain("localhost");
    // The reproduce commands name a variable, and say what to set it to, instead of a made-up host.
    const model = judges!.model as {
      reproduce: { note: string | null; commands: string }[];
      machineReadable: { url: string }[];
    };
    const fromScript = model.reproduce.find((r) => r.note?.includes("JSON and a Markdown twin"));
    expect(fromScript?.commands).toContain(`curl -s $SITE${REFERENCE}.json`);
    expect(fromScript?.note).toContain("Set SITE to the address you are reading this at");
    expect(model.machineReadable.map((m) => m.url)).not.toContain("/sitemap.xml");
  });

  it("/judges prints its reproduce commands with the site's own address once it knows it", async () => {
    const judges = await loadPath("/judges", ctxFor(testSources()));
    const model = judges!.model as { reproduce: { note: string | null; commands: string }[] };
    const fromScript = model.reproduce.find((r) => r.note?.includes("JSON and a Markdown twin"));
    expect(fromScript?.commands).toContain(`curl -s https://help-wanted.test${REFERENCE}.json`);
    expect(fromScript?.commands).toContain("curl -s https://help-wanted.test/api/v1/integration");
    expect(fromScript?.commands).toContain("curl -s https://help-wanted.test/judges.json");
    expect(model.reproduce.map((r) => r.commands).join("\n")).not.toContain("<this-site>");
  });

  it("/openapi.json describes every API route and every fixed page's twins", () => {
    const doc = openApiDocument("https://help-wanted.test") as {
      openapi: string;
      paths: Record<string, unknown>;
      servers: { url: string }[];
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0]?.url).toBe("https://help-wanted.test");
    for (const route of API_ROUTES) expect(doc.paths[route.path.split("?")[0]!], route.path).toBeDefined();
    for (const page of STATIC_PATHS) {
      expect(doc.paths[twinPaths(page.path).json]).toBeDefined();
      expect(doc.paths[twinPaths(page.path).md]).toBeDefined();
    }
  });
});
