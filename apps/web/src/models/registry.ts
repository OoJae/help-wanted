/**
 * Every page of the site, in one list. The HTML pages, the JSON and Markdown twins, the sitemap and
 * `/llms.txt` all come from here, so a page cannot exist in one form and be missing in another.
 */
import type { ContractKey, Deployments } from "~/config/deployments";
import { hireIndexPage, hireTemplatePage, orderPage, ordersPage, runnersPage } from "./desk";
import { jobsReportPage } from "./jobsReport";
import { judgesPage } from "./judges";
import { companyPage, endowmentsPage, potPage, potsPage, rulesNewPage, seatPage, seatsPage } from "./money";
import { questionsPage } from "./questions";
import type { PageDef } from "./types";
import { verifyIndexPage, verifyJobPage } from "./verify";
import { wirePage } from "./wire";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPage = PageDef<any>;

export const PAGES: readonly AnyPage[] = [
  wirePage,
  verifyIndexPage,
  verifyJobPage,
  jobsReportPage,
  questionsPage,
  judgesPage,
  hireIndexPage,
  hireTemplatePage,
  ordersPage,
  orderPage,
  potsPage,
  potPage,
  rulesNewPage,
  companyPage,
  seatsPage,
  seatPage,
  endowmentsPage,
  runnersPage,
];

export interface Match {
  page: AnyPage;
  params: Record<string, string>;
}

function split(path: string): string[] {
  return path.split("/").filter((part) => part !== "");
}

/** Finds the page for a path such as `/verify/e9ef…`. A trailing slash is ignored. */
export function matchPage(pathname: string): Match | null {
  const parts = split(pathname);
  for (const page of PAGES) {
    const pattern = split(page.pattern);
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pattern.length; i++) {
      const want = pattern[i] as string;
      const have = parts[i] as string;
      if (want.startsWith(":")) {
        try {
          params[want.slice(1)] = decodeURIComponent(have);
        } catch {
          ok = false;
        }
      } else if (want !== have) {
        ok = false;
      }
      if (!ok) break;
    }
    if (ok) return { page, params };
  }
  return null;
}

export type TwinFormat = "json" | "md";

/**
 * Splits a twin path into the page path and the format: `/jobs-report.md` is `/jobs-report` as
 * Markdown, and `/index.json` is the home page as JSON. Returns null for any other path.
 */
export function parseTwinPath(pathname: string): { path: string; format: TwinFormat } | null {
  const match = pathname.match(/^(.*)\.(json|md)$/);
  if (!match) return null;
  const base = match[1] ?? "";
  const format = match[2] as TwinFormat;
  if (base === "/index" || base === "") return { path: "/", format };
  return { path: base, format };
}

/** The three addresses of one page. */
export function twinPaths(path: string): { html: string; json: string; md: string } {
  const clean = path === "/" ? "/" : path.replace(/\/+$/, "");
  const base = clean === "/" ? "/index" : clean;
  return { html: clean, json: `${base}.json`, md: `${base}.md` };
}

export interface StaticPath {
  path: string;
  label: string;
  blurb: string;
  /** True for a page that works on today's data whether or not any contract of ours exists. */
  live: boolean;
  /** The contract a page that is not `live` waits for. Once it has an address the page is live too. */
  needs: ContractKey | null;
}

/** The pages with a fixed address, for the sitemap, the navigation and `/llms.txt`. */
export const STATIC_PATHS: readonly StaticPath[] = [
  {
    path: "/",
    label: "Work Wire",
    blurb: "The swarm's live state and recent jobs as classified cards.",
    live: true,
    needs: null,
  },
  {
    path: "/verify",
    label: "Verify",
    blurb: "Check any swarm job's work record against its on-chain receipt.",
    live: true,
    needs: null,
  },
  {
    path: "/jobs-report",
    label: "Jobs Report",
    blurb:
      "What the swarm was paid: the official on-chain release once the JobsReport contract has printed, with this site's unofficial tally from IMD Transfer logs beside it.",
    live: true,
    needs: null,
  },
  {
    path: "/questions",
    label: "Questions",
    blurb:
      "The three house feeds in plain words, with their exact text, meters, cadence and rounds, and the oracle requests bought on chain through the Intake.",
    live: true,
    needs: null,
  },
  {
    path: "/judges",
    label: "For judges",
    blurb:
      "What is proven on the live system with a link for each, the integration table, reproduce commands, every disclosed limit, and what is not live.",
    live: true,
    needs: null,
  },
  {
    path: "/hire",
    label: "Hire",
    blurb: "Post an order to the hire desk.",
    live: false,
    needs: "workOrders",
  },
  { path: "/orders", label: "Orders", blurb: "Orders on the hire desk.", live: false, needs: "workOrders" },
  {
    path: "/pots",
    label: "Pots",
    blurb: "Chip in to commission swarm work together, with IMD, or with ETH through Zap (launch C).",
    live: false,
    needs: "crowdPots",
  },
  {
    path: "/rules/new",
    label: "Say When",
    blurb:
      "WHEN a view call crosses a line, THEN hire or pay: a conditional order on launch B's desk, which anyone may open once its condition holds, or a standing rule that fires again and again (Rules, launch C).",
    live: false,
    needs: "workOrders",
  },
  {
    path: "/company",
    label: "Company",
    blurb:
      "Payroll's ledger: what came in, the split, the stream to stakers, the seat pool, tips and the feed budget.",
    live: false,
    needs: "payroll",
  },
  {
    path: "/seats",
    label: "Seats",
    blurb: "A seat's owner, its agent, and what it can claim.",
    live: false,
    needs: "payroll",
  },
  {
    path: "/endowments",
    label: "Endowments",
    blurb: "Principal stays; only the yield pays for work.",
    live: false,
    needs: "endowments",
  },
  {
    path: "/runners",
    label: "Runners",
    blurb: "Take an order, buy the swarm job, get paid on proof.",
    live: false,
    needs: "workOrders",
  },
];

/**
 * What launch C adds, as the navigation names it. Each is shown apart, under "Coming", for as long as
 * its contract has no address in the deployments book; the pages behind them are complete. Once it
 * has one, Endowments is a page of the main row, and Rules and Zap are sections of Say When and Pots.
 */
export const LAUNCH_C_LINKS: readonly { path: string; label: string; needs: ContractKey }[] = [
  { path: "/rules/new#standing", label: "Rules", needs: "rules" },
  { path: "/endowments", label: "Endowments", needs: "endowments" },
  { path: "/pots#zap", label: "Zap", needs: "zap" },
];

/** Whether a page has what it needs today: it needs nothing of ours, or its contract has an address. */
export function isLivePath(page: StaticPath, deployments: Deployments): boolean {
  return page.live || (page.needs !== null && deployments.contracts[page.needs].address !== null);
}
