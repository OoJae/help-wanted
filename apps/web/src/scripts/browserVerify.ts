/**
 * The receipt check, run again in the visitor's own browser.
 *
 * The server has already run it and stamped its box on the slip. This script repeats it without
 * the server's help where it matters: the receipt is read by the browser straight from a public
 * Ethereum RPC, and the record's bytes are hashed here, in this tab. The bytes come through this
 * site only because IdentityMD's record server sends no CORS header; that does not weaken the
 * check, since bytes that had been changed on the way would not hash to the receipt on chain.
 *
 * The second box on the slip is the browser's. It is empty until this check has really finished;
 * then each step is marked and the stamp lands. Nothing is drawn ahead of the result: the marks
 * and the stamp say only what this tab found, and the time shown is the time the check took.
 * Without JavaScript the box is not in the page at all.
 */
import { latestCalldata } from "~/lib/ids";
import { createEthReader } from "~/lib/jsonrpc";
import { stampSvg, VERDICT_INK } from "~/lib/stamp";
import { STAMP, verifyJob, type Verdict, type VerifyResult } from "~/lib/verify";

const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
/** A beat between marks, so a reader can follow the four steps to the stamp. None when motion is unwelcome. */
const pause = (ms: number) => (calm ? Promise.resolve() : new Promise<void>((done) => setTimeout(done, ms)));

function text(root: ParentNode, selector: string, value: string): void {
  const node = root.querySelector(selector);
  if (node) node.textContent = value;
}

function setMark(mark: Element | null, ok: boolean | null | "waiting" | "working"): void {
  if (!mark) return;
  const word =
    ok === true
      ? "pass"
      : ok === false
        ? "fail"
        : ok === "working"
          ? "checking"
          : ok === "waiting"
            ? "waiting"
            : "not reached";
  mark.textContent = `Browser: ${word}`;
  mark.className = `mark ${ok === true ? "mark--pass" : ok === false ? "mark--fail" : "mark--skip"}`;
}

function waiting(box: Element | null, words: string): void {
  if (!box) return;
  const line = document.createElement("span");
  line.className = "inspect__wait";
  line.setAttribute("role", "status");
  line.textContent = words;
  box.replaceChildren(line);
}

async function run(panel: HTMLElement): Promise<void> {
  const jobId = panel.dataset.job ?? "";
  const rpcUrl = panel.dataset.rpc ?? "";
  const registry = panel.dataset.registry ?? "";
  const rpcHost = new URL(rpcUrl).host;
  const stampBox = panel.querySelector("[data-browser-stamp]");
  const button = panel.querySelector<HTMLButtonElement>("[data-browser-run]");
  const marks = new Map<string, Element>();
  for (const row of document.querySelectorAll<HTMLElement>("[data-steps] [data-step]")) {
    const mark = row.querySelector("[data-browser-mark]");
    if (mark && row.dataset.step) marks.set(row.dataset.step, mark);
  }

  if (button) button.disabled = true;
  for (const mark of marks.values()) setMark(mark, "waiting");
  waiting(stampBox, "Reading the receipt from the chain…");
  text(panel, "[data-browser-summary]", `Asking ${rpcHost} for WorkRegistry.latest(jobId).`);
  text(document, "[data-browser-note]", "");
  setMark(marks.get("receipt") ?? null, "working");

  const started = performance.now();
  const reader = createEthReader(rpcUrl, { timeoutMs: 20_000 });
  let result: VerifyResult;
  try {
    result = await verifyJob(jobId, {
      readReceipt: async (id) => {
        const receipt = await reader.call(registry, latestCalldata(id));
        waiting(stampBox, "Receipt read. Working through the rest…");
        setMark(marks.get("record") ?? null, "working");
        return receipt;
      },
      fetchRecord: async (hash) => {
        const response = await fetch(`/api/v1/work-records/${hash.slice(2)}.json`);
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`the record could not be fetched (HTTP ${response.status})`);
        return new Uint8Array(await response.arrayBuffer());
      },
    });
  } catch (error) {
    for (const mark of marks.values()) setMark(mark, null);
    if (stampBox) stampBox.innerHTML = stampSvg(STAMP.unchecked, { ink: "void", size: "big" });
    text(
      panel,
      "[data-browser-summary]",
      `The check could not run in this browser: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (button) button.disabled = false;
    return;
  }
  const ms = Math.round(performance.now() - started);

  // The check is done. Its four findings are set down in order, and the stamp comes last.
  for (const step of result.steps) {
    setMark(marks.get(step.key) ?? null, step.ok);
    await pause(150);
  }
  if (stampBox) {
    stampBox.innerHTML = stampSvg(STAMP[result.verdict], {
      ink: VERDICT_INK[result.verdict],
      size: "big",
      fresh: true,
    });
  }
  // Each sentence below says only what this tab did. A check that could not finish read nothing
  // it can vouch for, so it claims nothing and leaves the server's result standing on its own.
  const server = panel.dataset.serverVerdict;
  const serverStamp = server && server in STAMP ? STAMP[server as Verdict] : "nothing";
  const did =
    result.verdict === "unchecked"
      ? ""
      : result.record
        ? ` Your browser read the receipt from ${rpcHost} and hashed the record itself, in ${ms} ms.`
        : ` Your browser read the registry at ${rpcHost} itself, in ${ms} ms.`;
  const compared =
    result.verdict === "unchecked"
      ? " This box proves nothing either way: run it again, or use the commands below."
      : server === result.verdict
        ? " It agrees with the server."
        : ` The server printed ${serverStamp}; your browser found ${STAMP[result.verdict]}. Trust your browser, and the commands below.`;
  text(panel, "[data-browser-summary]", `${result.summary}${did}${compared}`);
  text(
    document,
    "[data-browser-note]",
    result.verdict === "unchecked"
      ? ""
      : `The browser's receipt came directly from ${rpcHost}, not from this site. The record's bytes pass through this site, because IdentityMD's record server sends no CORS header, and your browser hashes them itself: bytes changed on the way could not hash to the receipt on chain.`,
  );
  if (button) button.disabled = false;
}

for (const panel of document.querySelectorAll<HTMLElement>("[data-browser-check]")) {
  try {
    new URL(panel.dataset.rpc ?? "");
  } catch {
    continue;
  }
  panel.querySelector("[data-browser-run]")?.addEventListener("click", () => void run(panel));
  void run(panel);
}
