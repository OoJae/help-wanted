import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LAUNCH_KEYS } from "../contracts.js";
import type { EvidenceDocument } from "../document.js";
import { render } from "../render.js";
import { checksumAddress, DEPLOYMENT_BOOK, isLaunched } from "../shared.js";
import { EM_DASH, privateText, REFUSED, ROOT } from "./helpers.js";

const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");
const README = read("README.md");

/** The rows of the README's status table, by launch letter. */
function statusRows(): Record<string, string> {
  const section = README.slice(
    README.indexOf("## Status of each launch"),
    README.indexOf("## Check it yourself"),
  );
  const rows: Record<string, string> = {};
  for (const line of section.split("\n")) {
    const found = /^\| ([ABC]) \|/.exec(line);
    if (found?.[1]) rows[found[1].toLowerCase()] = line;
  }
  return rows;
}

describe("the front door: README.md", () => {
  it("has a row for each launch that says what the deployments book says", () => {
    const rows = statusRows();
    expect(Object.keys(rows).sort()).toEqual(["a", "b", "c"]);
    for (const key of LAUNCH_KEYS) {
      const record = DEPLOYMENT_BOOK[key];
      const row = rows[key] as string;
      expect(row).toContain(`launches/${record.project.split("/")[1]}`);
      expect(row).toContain(`${record.project}/docs/THREATS.md`);
      if (isLaunched(key)) {
        // A launch in the book is a launch the README calls live, with its transaction and every address.
        expect([key, row.includes("**Live**")]).toEqual([key, true]);
        expect(row).toContain(record.transaction as string);
        for (const address of Object.values(record.contracts))
          expect(row).toContain(checksumAddress(address as string));
        if (record.launchNumber !== null)
          expect(row).toContain(`IdentityMD launch ${record.launchNumber}`);
      } else {
        // A launch the book holds no address for must not be called live, here or anywhere on the page.
        expect([key, /\*\*Not (live|submitted)\.\*\*/.test(row)]).toEqual([
          key,
          true,
        ]);
        expect(row).not.toContain("**Live**");
        expect(README).not.toMatch(
          new RegExp(`Launch ${key.toUpperCase()} is live`, "i"),
        );
      }
    }
  });

  it("names every contract of the book, and no address the book does not hold", () => {
    const known = new Set(
      LAUNCH_KEYS.flatMap((key) =>
        Object.values(DEPLOYMENT_BOOK[key].contracts),
      )
        .filter((address): address is `0x${string}` => address !== null)
        .map((address) => address.toLowerCase()),
    );
    // Addresses of IdentityMD's own contracts that the check commands read.
    const theirs = new Set([
      "0xb6d0a187b050fa5bb0b87033a203f37becf4a775", // WorkRegistry
      "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7", // IMD
    ]);
    const inStatus = README.slice(
      README.indexOf("## Status of each launch"),
      README.indexOf("## Check it yourself"),
    );
    for (const address of inStatus.match(/0x[0-9a-fA-F]{40}\b/g) ?? []) {
      expect([address, known.has(address.toLowerCase())]).toEqual([
        address,
        true,
      ]);
    }
    for (const address of README.match(/0x[0-9a-fA-F]{40}\b/g) ?? []) {
      const lower = address.toLowerCase();
      expect([address, known.has(lower) || theirs.has(lower)]).toEqual([
        address,
        true,
      ]);
    }
  });

  it("points only at files that exist", () => {
    const targets = [...README.matchAll(/\]\(([^)#\s]+)\)/g)]
      .map((m) => m[1] as string)
      .filter((t) => !/^https?:/.test(t));
    expect(targets.length).toBeGreaterThan(15);
    for (const target of targets)
      expect([target, existsSync(join(ROOT, target))]).toEqual([target, true]);
    // Paths named in code spans, where they are paths of this repository.
    const spans = [
      ...README.matchAll(
        /`((?:launches|packages|bots|apps|scripts|evidence)\/[A-Za-z0-9_./-]+)`/g,
      ),
    ].map((m) => m[1] as string);
    for (const path of spans)
      expect([path, existsSync(join(ROOT, path))]).toEqual([path, true]);
  });

  it("gives commands that exist in package.json", () => {
    const scripts = (
      JSON.parse(read("package.json")) as { scripts: Record<string, string> }
    ).scripts;
    for (const name of [
      "evidence",
      "evidence:test",
      "repro",
      "test",
      "typecheck",
    ]) {
      expect([name, typeof scripts[name]]).toEqual([name, "string"]);
    }
    for (const found of README.matchAll(
      /pnpm (evidence(?::test)?|repro|typecheck)\b/g,
    )) {
      expect(scripts[found[1] as string]).toBeDefined();
    }
    expect(scripts.repro).toBe("bash scripts/repro.sh");
    expect(scripts.test).toContain("evidence:test");
  });

  it("carries the licence of the launch folders", () => {
    const licence = read("LICENSE");
    expect(licence).toBe(read("launches", "a-payroll", "LICENSE"));
    expect(licence.startsWith("MIT License")).toBe(true);
  });
});

describe("the front door: SECURITY.md", () => {
  const SECURITY = read("SECURITY.md");

  it("names every contract of the book as in scope, at its address, and the bots", () => {
    for (const key of LAUNCH_KEYS) {
      for (const address of Object.values(DEPLOYMENT_BOOK[key].contracts)) {
        if (address === null) continue;
        expect([address, SECURITY.includes(checksumAddress(address))]).toEqual([
          address,
          true,
        ]);
      }
    }
    expect(SECURITY).toContain("`bots/keeper`");
    expect(SECURITY).toContain("`bots/runner`");
  });

  it("says how to report privately, and that there is no bounty", () => {
    expect(SECURITY).toContain("private vulnerability reporting");
    expect(SECURITY).toContain("https://github.com/OoJae/help-wanted");
    expect(SECURITY).toMatch(/^## No bounty$/m);
    expect(SECURITY).toContain("There is no bounty.");
  });
});

describe("the generated evidence in the working tree", () => {
  const jsonPath = join(ROOT, "evidence", "evidence.json");
  const markdownPath = join(ROOT, "EVIDENCE.md");
  const present = existsSync(jsonPath) && existsSync(markdownPath);

  it.runIf(present)(
    "EVIDENCE.md is exactly what evidence.json renders to: neither was edited by hand",
    () => {
      const doc = JSON.parse(
        readFileSync(jsonPath, "utf8"),
      ) as EvidenceDocument;
      expect(readFileSync(markdownPath, "utf8")).toBe(render(doc));
      expect(doc.checks.every((check) => check.agree)).toBe(true);
    },
  );

  it.runIf(present)(
    "agrees with the README about who has used the contracts and which launches exist",
    () => {
      const doc = JSON.parse(
        readFileSync(jsonPath, "utf8"),
      ) as EvidenceDocument;
      // The README may say nobody outside has used the contracts only while the evidence says so.
      if (doc.headline.transactions.outside > 0)
        expect(README).not.toMatch(/Nobody outside the team has used/);
      for (const key of LAUNCH_KEYS) {
        // The evidence may be older than the book (run `pnpm evidence` after recording a launch),
        // and must never claim a launch the book does not hold.
        if (doc.launches[key].launched)
          expect([key, isLaunched(key)]).toEqual([key, true]);
      }
    },
  );
});

describe("everything written for the front door", () => {
  function files(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) files(path, out);
      else out.push(path);
    }
    return out;
  }
  const ours = [
    join(ROOT, "README.md"),
    join(ROOT, "SECURITY.md"),
    join(ROOT, "LICENSE"),
    ...["EVIDENCE.md", "evidence/evidence.json"]
      .map((name) => join(ROOT, name))
      .filter((path) => existsSync(path)),
    join(ROOT, "evidence", "launch-requests.json"),
    join(ROOT, "packages", "shared", "src", "chainRead.ts"),
    join(ROOT, "packages", "shared", "test", "chainRead.test.ts"),
    ...files(join(ROOT, "scripts", "evidence")),
    ...files(join(ROOT, "scripts", "lib")),
    join(ROOT, "scripts", "repro.sh"),
  ];

  it("holds nothing private, none of the refused words and no em dash", () => {
    expect(ours.length).toBeGreaterThan(25);
    for (const path of ours) {
      const text = readFileSync(path, "utf8");
      const name = path.slice(ROOT.length + 1);
      expect([name, privateText(text)]).toEqual([name, null]);
      expect([name, REFUSED.exec(text)?.[0] ?? null]).toEqual([name, null]);
      expect([name, EM_DASH.test(text)]).toEqual([name, false]);
    }
  });
});
