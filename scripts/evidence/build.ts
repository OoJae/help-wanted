/**
 * `pnpm evidence`: reads what exists on chain of HELP WANTED and writes it down.
 *
 * It is the only writer of two files at the repository root:
 *   EVIDENCE.md             for a person
 *   evidence/evidence.json  for a program
 *
 * Both say the same thing, read at one pinned block that the run prints: for every contract the
 * deployments book holds an address for, the launch transaction, whether there is code at the
 * address, and every count its logs give, each split HOUSE and OUTSIDE by the published list in
 * evidence/house-wallets.json. A launch the book holds no address for is shown as not launched.
 * Filling in the book (packages/shared/src/deployments.ts) is the only change a new launch needs.
 *
 * It only reads. It holds no key, its RPC client knows no method that writes, and its API reader
 * refuses anything but GET. When a read fails, or a count from the logs disagrees with the
 * contract's own counter, it writes nothing and exits with status 1.
 *
 * Settings (environment variables, all optional):
 *   RPC_URL         one Ethereum mainnet RPC URL, or several separated by commas, tried in order.
 *                   Default https://ethereum-rpc.publicnode.com,https://rpc.mevblocker.io. Each
 *                   range of logs is asked of the first, then of the second if the first does not
 *                   serve it. The first serves logs for roughly the last 9,000 blocks only, so
 *                   older logs (the early ones of launches A and B) are read from the second,
 *                   which keeps history.
 *   CHUNK_SIZE      widest block range per log query. Default 2000, which both default nodes serve.
 *                   A node that wants less is asked for half, and half again.
 *   EVIDENCE_BLOCK  pin a block by number instead of the node's finalized block.
 *   EVIDENCE_API    "off" to leave IdentityMD's public API out of the run. Default on.
 *   API_GAP_MS      pause between two API requests. Default 13000 (under five a minute).
 *   EVIDENCE_OUT    write the two files into this folder instead of the repository (to compare).
 *   EVIDENCE_TAPE   also write every answer the run got to this file (the tests replay one).
 */
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { imdReads, type HttpGet } from "./imd.js";
import { render } from "./render.js";
import { httpPost, Rpc, type HttpPost } from "./rpc.js";
import { buildEvidence } from "./run.js";
import { DEPLOYMENT_BOOK, type DeploymentBook } from "./shared.js";
import { emptyTape, recordingGet, recordingPost, slimTape } from "./tape.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** A public node for recent reads and recent logs, then one that keeps the older logs. */
export const DEFAULT_RPC_URL =
  "https://ethereum-rpc.publicnode.com,https://rpc.mevblocker.io";
export const DEFAULT_CHUNK_SIZE = 2000;

export interface Settings {
  rpcUrls: string[];
  chunkSize: number;
  block: number | null;
  api: boolean;
  apiGapMs: number;
  outDir: string;
  tape: string | null;
}

function wholeNumber(
  value: string | undefined,
  name: string,
  fallback: number,
  min: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^[0-9]+$/.test(value.trim()))
    throw new Error(`${name} must be a whole number`);
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < min)
    throw new Error(`${name} must be at least ${min}`);
  return parsed;
}

/** The run's settings from the environment. Throws a sentence for a value that cannot be used. */
export function settingsFrom(
  env: Record<string, string | undefined>,
  root: string = ROOT,
): Settings {
  const rpcUrls = (env.RPC_URL ?? DEFAULT_RPC_URL)
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url !== "");
  if (rpcUrls.length === 0) throw new Error("RPC_URL is empty");
  for (const url of rpcUrls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("RPC_URL holds something that is not a URL");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      throw new Error("RPC_URL must be http or https");
  }
  const api = (env.EVIDENCE_API ?? "on").trim().toLowerCase();
  if (!["on", "off", "1", "0", "true", "false"].includes(api))
    throw new Error('EVIDENCE_API must be "on" or "off"');
  return {
    rpcUrls,
    chunkSize: wholeNumber(env.CHUNK_SIZE, "CHUNK_SIZE", DEFAULT_CHUNK_SIZE, 1),
    block: env.EVIDENCE_BLOCK?.trim()
      ? wholeNumber(env.EVIDENCE_BLOCK, "EVIDENCE_BLOCK", 0, 1)
      : null,
    api: ["on", "1", "true"].includes(api),
    apiGapMs: wholeNumber(env.API_GAP_MS, "API_GAP_MS", 13_000, 0),
    outDir: env.EVIDENCE_OUT?.trim() ? env.EVIDENCE_OUT.trim() : root,
    tape: env.EVIDENCE_TAPE?.trim() ? env.EVIDENCE_TAPE.trim() : null,
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonIfThere(path: string): unknown {
  try {
    return readJson(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Both files or neither: each is written beside its place first and moved in only when both exist. */
function writeBoth(outDir: string, markdown: string, json: string): string[] {
  const targets = [
    join(outDir, "EVIDENCE.md"),
    join(outDir, "evidence", "evidence.json"),
  ];
  mkdirSync(join(outDir, "evidence"), { recursive: true });
  const staged = targets.map((target) => `${target}.writing`);
  writeFileSync(staged[0] as string, markdown);
  writeFileSync(staged[1] as string, json);
  staged.forEach((from, index) => renameSync(from, targets[index] as string));
  return targets;
}

/** What a test puts in place of the network, the clock and the files the run reads. */
export interface Io {
  post?: HttpPost;
  get?: HttpGet;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  book?: DeploymentBook;
  houseFile?: unknown;
  launchRequests?: unknown;
  say?: (line: string) => void;
  complain?: (line: string) => void;
}

export async function main(
  env: Record<string, string | undefined> = process.env,
  io: Io = {},
): Promise<number> {
  const say = io.say ?? ((line: string) => console.log(`evidence: ${line}`));
  const complain =
    io.complain ?? ((line: string) => console.error(`evidence: ${line}`));
  try {
    const settings = settingsFrom(env);
    const tape = settings.tape
      ? emptyTape(
          "Every answer one run of scripts/evidence/build.ts got, for its tests to replay. Blocks, transactions, receipts and jobs keep only the fields the builder reads (see slimTape in tape.ts); logs, code and call results are whole.",
        )
      : null;
    const post = io.post ?? httpPost;
    const get: HttpGet = io.get ?? ((url, init) => fetch(url, init));
    const rpc = new Rpc(settings.rpcUrls, {
      post: tape ? recordingPost(post, tape) : post,
      ...(io.sleep ? { sleep: io.sleep } : {}),
    });
    const imd = settings.api
      ? imdReads({
          get: tape ? recordingGet(get, tape) : get,
          gapMs: settings.apiGapMs,
          ...(io.sleep ? { sleep: io.sleep } : {}),
        })
      : null;
    say(`reading from ${rpc.hosts.join(", ")}`);
    const document = await buildEvidence(
      {
        book: io.book ?? DEPLOYMENT_BOOK,
        houseFile:
          io.houseFile ??
          readJson(join(ROOT, "evidence", "house-wallets.json")),
        launchRequests:
          io.launchRequests !== undefined
            ? io.launchRequests
            : readJsonIfThere(join(ROOT, "evidence", "launch-requests.json")),
      },
      { chunkSize: settings.chunkSize, block: settings.block },
      { rpc, imd, now: io.now ?? (() => new Date()), say },
    );
    // Every read is done and every check has agreed before the first byte is written.
    const written = writeBoth(
      settings.outDir,
      render(document),
      `${JSON.stringify(document, null, 2)}\n`,
    );
    if (tape && settings.tape)
      writeFileSync(
        settings.tape,
        `${JSON.stringify(slimTape(tape), null, 2)}\n`,
      );
    say(`${document.checks.length} checks against the contracts agree`);
    for (const path of written) say(`wrote ${path}`);
    say(`pinned block ${document.pinnedBlock.number}`);
    return 0;
  } catch (error) {
    complain(error instanceof Error ? error.message : String(error));
    complain("nothing was written.");
    return 1;
  }
}

/**
 * True when this file is the script that was started. `import.meta.url` has every symbolic link
 * resolved and `process.argv[1]` is the path as given, so the two are compared as real paths: a
 * repository reached through a link (on macOS, /tmp is one) would otherwise run nothing and exit 0.
 */
export function isMainScript(
  argv1: string | undefined = process.argv[1],
  self: string = fileURLToPath(import.meta.url),
): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(self);
  } catch {
    return false;
  }
}

if (isMainScript()) {
  process.exit(await main());
}
