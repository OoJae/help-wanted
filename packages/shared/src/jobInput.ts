/**
 * From an order's spec to the body of the swarm job a runner opens for it.
 *
 * The desk pins two things about the job: the objective (the header followed by the spec, compared
 * byte for byte through the work record) and the record's `kind`. Everything else in the job body
 * has to be derivable from those, or two runners would open different jobs for one order. So:
 *
 * - the template comes from the order's `kindHash`, looked up in a table of known kinds;
 * - body inputs such as the repository to audit are written at the end of the spec itself, in the
 *   one clause every part of HELP WANTED reads. It starts with `Inputs: ` and holds `key=value`
 *   pairs separated by a semicolon and a space; a key is letters and digits, and a value holds no
 *   semicolon:
 *
 *     Audit the staking vault. Inputs: repoUrl=https://github.com/owner/repo; baseCommit=0123…4567
 *
 * The work record does not commit to `repoUrl` or `baseCommit`; putting them in the spec is what
 * lets an employer, a challenger or a keeper compare the job a runner opened with what was ordered.
 */
import { keccak256, stringToBytes, type Hex } from "viem";
import { OBJECTIVE_MAX_CHARS } from "./order.js";

export interface JobTemplate {
  /**
   * The `kind` IdentityMD writes into the work record of a job opened with this template. It is
   * the job's `template` as `GET /jobs/:id` reports it: `audit`, `skill:research-report`, …
   */
  kind: string;
  /** Whether a real work record with this kind has been seen (see `fixtures/work-records`). */
  kindVerified: boolean;
  /** The job body apart from `objective` and the spec inputs. */
  input: Readonly<Record<string, unknown>>;
  /** Spec inputs the body must carry. */
  requiredInputs: readonly SpecInputName[];
  /** IdentityMD's objective limit for this template, in characters. */
  objectiveMaxChars: number;
  /**
   * True when real records of this kind have been seen too large for one transaction to carry
   * (a node refuses a transaction above 128 KB, and calldata costs at least 40 gas a byte). Such a
   * record can settle an order only through the chunked proof, which costs far more than a job
   * pays, or through the bonded claim path.
   */
  largeRecords: boolean;
  /**
   * The largest real work record of this kind seen so far, in bytes (the proof fixtures of
   * `launches/b-desk/test/fixtures/proof/index.json`, and for audits the records measured on 10
   * Oct 2026). It is what a runner prices a settlement by before it takes an order: see
   * `settleGasNeeded` in `desk.ts`. A kind can grow a larger record tomorrow; the figure is what
   * was seen, not a bound.
   */
  largestRecordSeen: number;
}

export const SPEC_INPUT_NAMES = ["repoUrl", "baseCommit"] as const;
export type SpecInputName = (typeof SPEC_INPUT_NAMES)[number];

/**
 * Kinds a runner can open, each confirmed against a real work record kept under
 * `fixtures/work-records` (a research report, an image, a video and an audit). A record's `kind` is
 * the job's `template` as `GET /jobs/:id` reports it: the name of a template (`audit`, `research`,
 * `single`, `impl_tests`, …), `skill:<id>` for a one-skill job, or `shape:<shape>` for a job built
 * from `steps`.
 *
 * What is not confirmed is the other direction for every template: that a body with exactly these
 * fields is accepted and yields exactly this kind. The bodies follow the examples in IdentityMD's
 * API guide; the free preflight (`POST /requests/check`) says whether one would be accepted.
 */
export const JOB_TEMPLATES: Readonly<Record<string, JobTemplate>> = {
  audit: {
    kind: "audit",
    kindVerified: true,
    input: { template: "audit" },
    requiredInputs: ["repoUrl", "baseCommit"],
    objectiveMaxChars: OBJECTIVE_MAX_CHARS,
    // Audit records measured on 10 Oct 2026 ran from 72 KB to 255 KB.
    largeRecords: true,
    largestRecordSeen: 255_000,
  },
  "skill:research-report": {
    kind: "skill:research-report",
    kindVerified: true,
    input: {
      skill: "research-report",
      outputs: [{ name: "report", path: "artifacts/report.md", mediaType: "text/markdown" }],
      github: false,
    },
    requiredInputs: [],
    objectiveMaxChars: OBJECTIVE_MAX_CHARS,
    largeRecords: false,
    // Job e9efec16, 7,339 bytes; the header job e70c56ce is 3,514.
    largestRecordSeen: 7_339,
  },
  "skill:create-image": {
    kind: "skill:create-image",
    kindVerified: true,
    input: {
      skill: "create-image",
      outputs: [{ name: "image", path: "artifacts/image.png", mediaType: "image/png" }],
      github: false,
    },
    requiredInputs: [],
    objectiveMaxChars: OBJECTIVE_MAX_CHARS,
    largeRecords: false,
    largestRecordSeen: 8_811,
  },
  "skill:create-video": {
    kind: "skill:create-video",
    kindVerified: true,
    input: {
      skill: "create-video",
      outputs: [{ name: "video", path: "artifacts/video.mp4", mediaType: "video/mp4" }],
      github: false,
    },
    requiredInputs: [],
    objectiveMaxChars: OBJECTIVE_MAX_CHARS,
    largeRecords: false,
    largestRecordSeen: 3_790,
  },
};

/** `keccak256(kind)` for every known template, for looking an order's `kindHash` up. */
export function templateByKindHash(hash: Hex): JobTemplate | undefined {
  const want = hash.toLowerCase();
  return Object.values(JOB_TEMPLATES).find((t) => keccak256(stringToBytes(t.kind)) === want);
}

const INPUTS_MARKER = "Inputs: ";
const INPUTS_SEPARATOR = "; ";
const INPUT_KEY = /^[A-Za-z0-9]+$/;

/** The pairs of an inputs clause, in the order they were written. */
export type SpecInputs = Record<string, string>;

export type SpecInputsResult = { ok: true; inputs: SpecInputs } | { ok: false; reason: string };

/** What a job body accepts for the inputs a template maps into it. */
const INPUT_RULES: Record<SpecInputName, RegExp> = {
  // A public GitHub repository, as `POST /requests/import` returns it. No query, no credentials.
  repoUrl: /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/,
  baseCommit: /^[0-9a-f]{40}$/,
};

function inputValueProblem(value: string): string | null {
  if (value === "") return "is empty";
  if (value.includes(";")) return "holds a semicolon";
  if (value !== value.trim()) return "starts or ends with a space";
  return null;
}

/**
 * Reads the trailing inputs clause of a spec: `Inputs: key=value; key=value`, running to the end
 * of the text. Pairs are separated by a semicolon and a space; a key is letters and digits; a value
 * holds no semicolon. A spec without the clause has no inputs.
 *
 * A clause that does not follow the format is refused as a whole, as is a repeated key: a runner
 * must not open a job from inputs it only half understood. What the keys mean is the template's
 * business (`buildJobInput`); this function only reads them.
 */
export function parseSpecInputs(spec: string): SpecInputsResult {
  const at = spec.lastIndexOf(INPUTS_MARKER);
  if (at === -1) return { ok: true, inputs: {} };
  if (at !== 0 && spec[at - 1] !== " ") return { ok: true, inputs: {} };
  const inputs: SpecInputs = {};
  for (const pair of spec.slice(at + INPUTS_MARKER.length).split(INPUTS_SEPARATOR)) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return { ok: false, reason: `"${pair}" is not key=value` };
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (!INPUT_KEY.test(key)) return { ok: false, reason: `"${key}" is not a key of letters and digits` };
    if (Object.hasOwn(inputs, key)) return { ok: false, reason: `input "${key}" appears twice` };
    const problem = inputValueProblem(value);
    if (problem !== null) return { ok: false, reason: `the value of "${key}" ${problem}` };
    inputs[key] = value;
  }
  return { ok: true, inputs };
}

/**
 * Writes the clause `parseSpecInputs` reads, for the page that composes a spec: the inputs a job
 * body knows first, in a fixed order, then any others as given. Returns "" for no inputs. Throws
 * for a key or a value the format cannot carry, so a page never writes a clause no runner can read.
 */
export function formatSpecInputs(inputs: SpecInputs): string {
  const known = SPEC_INPUT_NAMES.filter((name) => inputs[name] !== undefined) as string[];
  const keys = [...known, ...Object.keys(inputs).filter((key) => !known.includes(key))];
  const parts = keys.map((key) => {
    const value = inputs[key] as string;
    if (!INPUT_KEY.test(key)) throw new RangeError(`"${key}" is not a key of letters and digits`);
    const problem = inputValueProblem(value);
    if (problem !== null) throw new RangeError(`the value of "${key}" ${problem}`);
    return `${key}=${value}`;
  });
  return parts.length === 0 ? "" : `${INPUTS_MARKER}${parts.join(INPUTS_SEPARATOR)}`;
}

export type JobInputResult = { ok: true; input: Record<string, unknown> } | { ok: false; reason: string };

/**
 * The `input` of a `job.open` quote for an order: the template's fixed fields, the spec's inputs,
 * and the objective exactly as given. Keys are added in a fixed order so the same order always
 * produces the same request bytes.
 */
export function buildJobInput(template: JobTemplate, objective: string, spec: string): JobInputResult {
  if (objective.length > template.objectiveMaxChars) {
    return {
      ok: false,
      reason: `objective is ${objective.length} characters; this template allows ${template.objectiveMaxChars}`,
    };
  }
  const input: Record<string, unknown> = { objective, ...structuredClone(template.input) };
  // A template that takes no inputs sends the spec as text and nothing else, whatever it says.
  if (template.requiredInputs.length === 0) return { ok: true, input };
  const parsed = parseSpecInputs(spec);
  if (!parsed.ok) return { ok: false, reason: `spec inputs: ${parsed.reason}` };
  // Two runners must build the same job from one spec, so a template that reads inputs reads all
  // of them: a key it has no field for is a reason to leave the order, not to guess.
  for (const key of Object.keys(parsed.inputs)) {
    if (!(template.requiredInputs as readonly string[]).includes(key)) {
      return { ok: false, reason: `the ${template.kind} template takes no input named "${key}"` };
    }
  }
  for (const name of template.requiredInputs) {
    const value = parsed.inputs[name];
    if (value === undefined) return { ok: false, reason: `the spec names no ${name}` };
    if (!INPUT_RULES[name].test(value)) return { ok: false, reason: `input "${name}" has an invalid value` };
    input[name] = value;
  }
  return { ok: true, input };
}
