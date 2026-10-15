/**
 * The judges page prints every limit the three launch projects disclose. This test reads the three
 * `docs/THREATS.md` files, when the launch projects are in the repository beside this app, and holds
 * `src/config/limits.ts` to them: every entry of a document is in the list, in the document's order,
 * and each row's words are the document's own.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DISCLOSED_LIMITS, limitText, THREATS_DOCUMENT, type LimitLaunch } from "~/config/limits";
import { BANNED } from "./helpers";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const LAUNCHES: LimitLaunch[] = ["A", "B", "C"];

/**
 * A document's text as the list words it: one line, test names left out, no Markdown marks. Emphasis
 * is either `*word*` or, as prettier writes it, `_word_`; an underscore inside a name such as
 * `FLAG_ALLOW_CLAIMED` is not emphasis and stays.
 */
function plain(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s*\((?:[^()]*`(?:integration\/`: )?`?(?:test|invariant|testFuzz)[^()]*)\)/g, "")
    .replace(/\s*\(`(?:test|invariant|testFuzz)_[^)]*\)/g, "")
    .replace(/(^|[\s(])_([^_\s`](?:[^_`]*[^_\s`])?)_(?=[\s.,;:)]|$)/g, "$1$2")
    .replace(/`/g, "")
    .replace(/\*/g, "")
    .replace(/ - /g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}

/** A row's text as its sentences. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?:])\s+(?=[A-Z("])/).filter((sentence) => sentence.length > 0);
}

interface Entry {
  id: string;
  /** For a trust root: the table's cells. */
  cells?: string[];
}

/** The ids of every entry of a threats document, in its order: trust roots, limits, inherited, not verified. */
function entriesOf(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const part of text.split(/^## /m).slice(1)) {
    const newline = part.indexOf("\n");
    const title = part.slice(0, newline).trim();
    const body = part.slice(newline + 1);
    if (/static analysis/i.test(title)) continue;
    if (/trust roots/i.test(title)) {
      for (const line of body.split("\n")) {
        // A formatted table pads the id's cell: "| T1  |" as well as "| T10 |".
        if (!/^\| T\d+ +\|/.test(line)) continue;
        const cells = line
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((cell) => plain(cell));
        entries.push({ id: cells[0] ?? "", cells });
      }
      continue;
    }
    const bullets = [...body.matchAll(/^- \*\*/gm)].length;
    if (/not verified/i.test(title)) {
      for (let i = 1; i <= bullets; i++) entries.push({ id: `N${i}` });
      continue;
    }
    if (/inherits/i.test(title)) {
      for (let i = 1; i <= bullets; i++) entries.push({ id: `I${i}` });
      continue;
    }
    for (const match of body.matchAll(/^\*\*([A-Z]\d+)\. /gm)) entries.push({ id: match[1] ?? "" });
  }
  return entries;
}

describe("the list of disclosed limits", () => {
  it("names a document for each launch, and every row belongs to one", () => {
    expect(Object.keys(THREATS_DOCUMENT)).toEqual(LAUNCHES);
    for (const row of DISCLOSED_LIMITS) {
      expect(LAUNCHES).toContain(row.launch);
      expect(row.id).toMatch(/^[A-Z]+\d+$/);
      expect(row.section.length).toBeGreaterThan(3);
      expect(row.limit.length, `${row.launch} ${row.id}`).toBeGreaterThanOrEqual(8);
    }
    // An id names one entry of its document.
    const keys = DISCLOSED_LIMITS.map((row) => `${row.launch}:${row.id}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("uses none of the words this site does not use", () => {
    for (const row of DISCLOSED_LIMITS) {
      expect(`${limitText(row)} ${row.since ?? ""}`, `${row.launch} ${row.id}`).not.toMatch(BANNED);
    }
  });

  it("joins a heading that begins a sentence to the rest of it without a gap", () => {
    expect(
      limitText({ launch: "A", id: "X1", section: "s", limit: "A heading", detail: ", and the rest." }),
    ).toBe("A heading, and the rest.");
    expect(limitText({ launch: "A", id: "X1", section: "s", limit: "A heading.", detail: "More." })).toBe(
      "A heading. More.",
    );
    expect(limitText({ launch: "A", id: "X1", section: "s", limit: "Only a heading.", detail: "" })).toBe(
      "Only a heading.",
    );
  });

  describe.each(LAUNCHES)("launch %s against its THREATS.md", (launch) => {
    const path = `${ROOT}${THREATS_DOCUMENT[launch]}`;
    const present = existsSync(path);
    const rows = DISCLOSED_LIMITS.filter((row) => row.launch === launch);

    it.skipIf(!present)("has every entry of the document, in the document's order, and no other", () => {
      const entries = entriesOf(readFileSync(path, "utf8"));
      expect(entries.length).toBeGreaterThan(40);
      expect(rows.map((row) => row.id)).toEqual(entries.map((entry) => entry.id));
    });

    it.skipIf(!present)("words every trust root as the document's table does", () => {
      const entries = entriesOf(readFileSync(path, "utf8")).filter((entry) => entry.cells);
      expect(entries.length).toBeGreaterThan(5);
      for (const entry of entries) {
        const row = rows.find((r) => r.id === entry.id);
        expect(row, `${launch} ${entry.id}`).toBeDefined();
        const [, party = "", trusted = "", fails = ""] = entry.cells ?? [];
        expect(row!.section).toBe("Trust roots");
        expect(row!.limit.toLowerCase(), `${launch} ${entry.id}`).toBe(`trusts ${party.toLowerCase()}`);
        const full = `Trusted for: ${trusted}${fails ? ` If it fails: ${fails}` : ""}`;
        // The row gives how the cells begin; it never says anything the cells do not.
        expect(full.startsWith(row!.detail), `${launch} ${entry.id}: ${row!.detail}`).toBe(true);
        expect(row!.detail.startsWith("Trusted for: ")).toBe(true);
      }
    });

    it.skipIf(!present)(
      "words every other entry as the document does: its heading, then how its text goes on",
      () => {
        const document = plain(readFileSync(path, "utf8"));
        const others = rows.filter((row) => row.section !== "Trust roots");
        expect(others.length).toBeGreaterThan(30);
        for (const row of others) {
          // A numbered entry sits under its own number in the document; the two bulleted lists
          // (inherited, not verified) are found by their headings.
          const numbered = !/^[IN]\d+$/.test(row.id);
          const heading = plain(numbered ? `${row.id}. ${row.limit}` : row.limit);
          const start = document.indexOf(heading);
          expect(
            start,
            `${launch} ${row.id}: heading not in the document: ${heading}`,
          ).toBeGreaterThanOrEqual(0);
          // Then every sentence of the row is a sentence of the document, in the document's order.
          // (An entry that is a list is given by the head of each item, so sentences may be skipped;
          // none is reworded and none is added.)
          let from = numbered ? start + row.id.length + 2 : start;
          for (const sentence of sentences(plain(limitText(row)))) {
            const at = document.indexOf(sentence, from);
            expect(
              at,
              `${launch} ${row.id} is not worded as the document: ${sentence}`,
            ).toBeGreaterThanOrEqual(from);
            // No row reaches past its own entry into the next one: a sentence is found close by.
            expect(at - from, `${launch} ${row.id} strays from its entry: ${sentence}`).toBeLessThan(2500);
            from = at + sentence.length;
          }
        }
      },
    );
  });

  it("a row that later events overtook keeps the document's words and adds what happened since", () => {
    const since = DISCLOSED_LIMITS.filter((row) => row.since);
    // Launch A's document was written before its launch: the rows its launch overtook say so. Its
    // list of what is not verified has carried its own dated note since 15 October 2026 (N1), which
    // says what the launch showed of the pipeline, the audit, the callback and the gas, so those
    // rows need none. Launch B's document was brought up to date after its launch, and launch C's
    // on 15 October 2026, after launches A and B and the first order paid on a receipt, so none of
    // their rows needs a note.
    expect(since.map((row) => `${row.launch}:${row.id}`)).toEqual(["A:B1", "A:B3"]);
    for (const row of since) expect(row.since).toMatch(/^Since this was written, /);
    // A note never replaces the document's words: the row still carries them in full.
    for (const row of since) expect(row.limit.length + row.detail.length).toBeGreaterThan(40);
  });
});
