/**
 * The jobs a visitor can order from the hire desk.
 *
 * A template is offered only when a real work record with its `kind` has been seen, because the
 * desk pays only for a record of exactly the kind the order names. The kinds themselves, the job
 * body behind each and the `Inputs:` clause an audit carries are the shared package's
 * (`JOB_TEMPLATES`, `buildJobInput`): the same table the open-source runner (`bots/runner`) opens
 * jobs from. This file adds what a form and a card need: a title, the fields to fill in, the
 * measured turnaround. An order written any other way would wait for a runner that never comes.
 *
 * Turnaround and record sizes were measured on real swarm jobs on 10 Oct 2026. They are
 * observations, not promises.
 */
import {
  buildJobInput,
  formatSpecInputs,
  JOB_TEMPLATES as SHARED_TEMPLATES,
  orderHeader,
  RESEARCH_SPEC_MAX_BYTES,
} from "@help-wanted/shared";
import { parseUnits } from "~/lib/format";

export interface TemplateSlot {
  name: string;
  label: string;
  help: string;
  kind: "text" | "longtext" | "repo" | "commit";
  placeholder: string;
  required: boolean;
}

export interface JobTemplate {
  slug: string;
  /** The work record's `kind` string. `OrderParams.kindHash` is its keccak256. */
  kind: string;
  title: string;
  /** Who turns up, for the card: "4 robot auditors". */
  staff: string;
  /** One plain sentence on what comes back. */
  delivers: string;
  /** Measured on 10 Oct 2026. */
  turnaround: string;
  /** Measured work-record size, which is what a proof transaction carries. Null when not measured. */
  recordSize: string | null;
  /** What the record's size means for an employer, when it means something. */
  recordNote?: string;
  slots: TemplateSlot[];
  /** Builds the job text from the filled slots. One line of plain ASCII. */
  spec(values: Record<string, string>): string;
  /** Suggested price range in IMD; the visitor may change both. */
  suggestedMinPay: string;
  suggestedMaxPay: string;
}

/**
 * The clause a spec may end with: `Inputs: key=value; key=value`. It is written and read by the
 * shared package (`formatSpecInputs`, `parseSpecInputs`), the one format every part of HELP WANTED
 * uses: the runner turns it into the job's `repoUrl` and `baseCommit`, and because it sits inside
 * the job text, the order's hash covers it. This wrapper only drops what a form left empty.
 */
export function inputsClause(pairs: readonly (readonly [string, string])[]): string {
  const inputs: Record<string, string> = {};
  for (const [key, raw] of pairs) {
    const value = raw.trim();
    if (!/^[A-Za-z0-9]+$/.test(key) || value === "" || value.includes(";")) continue;
    inputs[key] = value;
  }
  return formatSpecInputs(inputs);
}

/** The 85 bytes a runner puts before the spec; any well-formed header has this length. */
const HEADER_STAND_IN = orderHeader(`0x${"0".repeat(64)}`);

/**
 * What stops the open-source runner from opening the job a spec of this kind describes, in plain
 * words, or null when nothing does. The answer is the runner's own: `buildJobInput` from the
 * shared package builds the job body from the kind's template and the spec's inputs, and its
 * refusal is the reason given here. The desk itself checks none of this (it does not know kinds),
 * so an order that fails here would be accepted on chain and then wait for a runner that never
 * comes.
 */
export function specInputsProblem(kind: string, spec: string): string | null {
  // IdentityMD caps the objective of its plain `research` template at 4,000 characters, 85 of
  // which are the order's header.
  if (kind === "research" && new TextEncoder().encode(spec).length > RESEARCH_SPEC_MAX_BYTES) {
    return `A job of kind research takes an objective of at most 4,000 characters, 85 of which are the order's header, so its job text can be at most ${RESEARCH_SPEC_MAX_BYTES.toLocaleString("en-US")} bytes. A longer one is accepted by the desk and can never be opened as a job.`;
  }
  const template = SHARED_TEMPLATES[kind];
  if (!template) return null;
  const built = buildJobInput(template, HEADER_STAND_IN + spec, spec);
  if (built.ok) return null;
  if (template.requiredInputs.length === 0) return `No runner can open this job: ${built.reason}.`;
  const hint = `End the job text with: Inputs: ${template.requiredInputs
    .map((name) =>
      name === "repoUrl" ? "repoUrl=https://github.com/owner/repo" : `${name}=<40 hex, lowercase>`,
    )
    .join("; ")}`;
  return `No runner can open this job as written (${built.reason}). ${hint}`;
}

function inputs(values: Record<string, string>): string {
  const clause = inputsClause([
    ["repoUrl", values.repoUrl ?? ""],
    ["baseCommit", (values.baseCommit ?? "").toLowerCase()],
  ]);
  return clause ? ` ${clause}` : "";
}

/** A kind the runner knows, checked when this module loads: a typo here would offer a job nobody can open. */
function kindOf(kind: string): string {
  const template = SHARED_TEMPLATES[kind];
  if (!template) throw new Error(`"${kind}" is not a job kind the shared package knows`);
  return template.kind;
}

export const TEMPLATES: readonly JobTemplate[] = [
  {
    slug: "audit",
    kind: kindOf("audit"),
    title: "Audit a contract repository",
    staff: "4 robot auditors",
    delivers:
      "Four specialist agents read the repository at one pinned commit and deliver a written audit report with findings.",
    turnaround: "27 to 51 minutes",
    recordSize: "72 to 255 KB",
    recordNote:
      "An audit's record is large: 72 to 255 KB as measured on 10 Oct 2026. A node refuses a transaction above 128 KB, so a large record cannot be proven in one transaction: it is first stored on chain in data contracts (200 gas a byte) and proven from those. That cost is the runner's, and a runner may pass on an audit order that pays only on a receipt.",
    slots: [
      {
        name: "repoUrl",
        label: "Repository",
        help: "A public GitHub repository.",
        kind: "repo",
        placeholder: "https://github.com/owner/repo",
        required: true,
      },
      {
        name: "baseCommit",
        label: "Commit",
        help: "The full 40-character commit hash to audit, so the order pins exactly what is read.",
        kind: "commit",
        placeholder: "0123456789abcdef0123456789abcdef01234567",
        required: true,
      },
      {
        name: "focus",
        label: "What to look at",
        help: "Optional. One sentence on what matters most.",
        kind: "text",
        placeholder: "the withdrawal path and its rounding",
        required: false,
      },
    ],
    spec: (v) =>
      `Audit the smart contracts in this repository at the given commit and report every defect you find, most serious first.${
        v.focus?.trim() ? ` Pay particular attention to ${v.focus.trim().replace(/[.\s]+$/, "")}.` : ""
      }${inputs(v)}`,
    suggestedMinPay: "2",
    suggestedMaxPay: "3",
  },
  {
    slug: "research",
    kind: kindOf("skill:research-report"),
    title: "Commission a research report",
    staff: "1 robot researcher",
    delivers: "One agent researches the question and delivers a Markdown report with its sources.",
    turnaround: "5 to 14 minutes",
    recordSize: "about 7 KB",
    slots: [
      {
        name: "question",
        label: "The question",
        help: "What should the report answer? One paragraph, plain text.",
        kind: "longtext",
        placeholder:
          "Compare the fee models of the three largest on-chain job escrows and say which suits a small DAO.",
        required: true,
      },
    ],
    spec: (v) => (v.question ?? "").trim(),
    suggestedMinPay: "1",
    suggestedMaxPay: "2",
  },
  {
    slug: "image",
    kind: kindOf("skill:create-image"),
    title: "Commission a picture",
    staff: "1 robot illustrator",
    delivers: "One agent makes one picture (PNG) from the description.",
    turnaround: "2 to 7 minutes",
    recordSize: "about 9 KB",
    slots: [
      {
        name: "brief",
        label: "The picture",
        help: "Describe the picture. One paragraph, plain text.",
        kind: "longtext",
        placeholder: "A square picture of a brass doorbell beside a blue front door, morning light, no text.",
        required: true,
      },
    ],
    spec: (v) => (v.brief ?? "").trim(),
    suggestedMinPay: "1",
    suggestedMaxPay: "2",
  },
  {
    slug: "video",
    kind: kindOf("skill:create-video"),
    title: "Commission a short video",
    staff: "1 robot film crew",
    delivers: "One agent makes one short video (MP4) from the description.",
    turnaround: "about 11 minutes for 30 seconds of video",
    recordSize: "about 6 KB",
    slots: [
      {
        name: "brief",
        label: "The video",
        help: "Describe the video. One paragraph, plain text.",
        kind: "longtext",
        placeholder: "A 30-second explainer of how a contract hires a robot, in the style of a newsreel.",
        required: true,
      },
    ],
    spec: (v) => (v.brief ?? "").trim(),
    suggestedMinPay: "1.5",
    suggestedMaxPay: "3",
  },
];

/** Jobs the swarm does that the desk does not take orders for yet, and why. */
export const NOT_OFFERED: readonly { slug: string; title: string; why: string }[] = [
  {
    slug: "fuzz",
    title: "Fuzz a contract",
    why: "No fuzz work record has been checked against the receipt scanner yet, so its kind is not confirmed.",
  },
  {
    slug: "website",
    title: "Build a website",
    why: "A website job runs several steps and its record kind is not confirmed; sampled swarm-built sites were also JavaScript shells.",
  },
];

export function templateBySlug(slug: string): JobTemplate | null {
  return TEMPLATES.find((t) => t.slug === slug) ?? null;
}

/** A template's suggested price as wei; falls back to zero for a malformed constant. */
export function suggestedWei(text: string): bigint {
  return parseUnits(text, 18) ?? 0n;
}

/** What a kind string is called on a card. */
export function kindLabel(kind: string | null): string {
  if (!kind) return "Job";
  const known: Record<string, string> = {
    audit: "Audit",
    research: "Research",
    "skill:research-report": "Research report",
    "skill:create-image": "Picture",
    "skill:create-video": "Video",
    "shape:chain": "Multi-step build",
    single: "Single task",
    impl_tests: "Build with tests",
  };
  if (known[kind]) return known[kind];
  const bare = kind.replace(/^(skill|shape):/, "").replace(/[-_]+/g, " ");
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}
