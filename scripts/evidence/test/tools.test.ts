import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isMainScript } from "../build.js";
import { CONTRACTS } from "../contracts.js";
import { imd, int, table, utc } from "../format.js";
import { houseList, parseHouseFile, Tally } from "../house.js";
import { DEPLOYMENT_BOOK } from "../shared.js";
import { emptyTape, slimTape } from "../tape.js";
import { HOUSE_FILE, ROOT, W1 } from "./helpers.js";

const node = (script: string, args: string[] = [], root: string = ROOT) =>
  spawnSync(process.execPath, [join(root, "scripts", "lib", script), ...args], {
    encoding: "utf8",
  });

/**
 * A folder that is a symbolic link to the repository, as a clone reached through /tmp on macOS
 * is. Every script must behave through it exactly as through the real path.
 */
const linkDir = mkdtempSync(join(tmpdir(), "hw-link-"));
const LINKED_ROOT = join(linkDir, "repository");
symlinkSync(ROOT, LINKED_ROOT, "dir");
afterAll(() => rmSync(linkDir, { recursive: true, force: true }));

describe("scripts/lib/book.mjs, the deployments book without an install", () => {
  it("prints the book exactly as the shared package holds it", () => {
    const run = node("book.mjs");
    expect(run.status).toBe(0);
    // The book as TypeScript sees it, through JSON, so that the two are compared as data.
    expect(JSON.parse(run.stdout)).toEqual(
      JSON.parse(JSON.stringify(DEPLOYMENT_BOOK)),
    );
  });

  it("lists every launched contract with the name of its build artifact", () => {
    const run = node("book.mjs", ["contracts"]);
    expect(run.status).toBe(0);
    const rows =
      run.stdout.trim() === ""
        ? []
        : run.stdout
            .trim()
            .split("\n")
            .map((line) => line.split(" "));
    const expected = CONTRACTS.flatMap((contract) => {
      const record = DEPLOYMENT_BOOK[contract.launch];
      const address = (record.contracts as Record<string, string | null>)[
        contract.key
      ];
      return address
        ? [
            [
              contract.launch,
              record.project,
              contract.name,
              address,
              String(record.block),
            ],
          ]
        : [];
    });
    expect(rows).toEqual(expected);
    // Launch A is live, so the list is not empty and `scripts/repro.sh` has something to compare.
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(node("book.mjs", ["chain-id"]).stdout.trim()).toBe(
      String(DEPLOYMENT_BOOK.chainId),
    );
  });

  it("prints the same when started through a symbolic link to the repository", () => {
    for (const args of [[], ["contracts"], ["chain-id"]]) {
      const direct = node("book.mjs", args);
      const linked = node("book.mjs", args, LINKED_ROOT);
      expect(direct.stdout.trim()).not.toBe("");
      expect([args, linked.status, linked.stdout]).toEqual([
        args,
        0,
        direct.stdout,
      ]);
    }
  });
});

describe("scripts/evidence/build.ts, started through a symbolic link", () => {
  it("knows it was started, whatever link the path went through", () => {
    const self = join(ROOT, "scripts", "evidence", "build.ts");
    expect(isMainScript(self, self)).toBe(true);
    expect(
      isMainScript(join(LINKED_ROOT, "scripts", "evidence", "build.ts"), self),
    ).toBe(true);
    expect(
      isMainScript(join(ROOT, "scripts", "evidence", "run.ts"), self),
    ).toBe(false);
    expect(isMainScript(undefined, self)).toBe(false);
    expect(isMainScript(join(linkDir, "nothing.ts"), self)).toBe(false);
  });

  it("runs, and refuses a setting it cannot use, instead of exiting 0 having done nothing", () => {
    // RPC_URL that is not a URL stops the run before any read: nothing reaches the network.
    const run = spawnSync(
      join(ROOT, "packages", "shared", "node_modules", ".bin", "tsx"),
      [join(LINKED_ROOT, "scripts", "evidence", "build.ts")],
      {
        encoding: "utf8",
        env: { ...process.env, RPC_URL: "not a url", EVIDENCE_OUT: linkDir },
      },
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      "evidence: RPC_URL holds something that is not a URL",
    );
    expect(run.stderr).toContain("evidence: nothing was written.");
  });
});

describe("scripts/lib/compare-code.mjs, the comparison behind scripts/repro.sh", () => {
  const dir = mkdtempSync(join(tmpdir(), "hw-repro-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // Sixteen bytes of code with one four-byte immutable at offset 4.
  const BUILT = "0x6080604000000000aabbccddeeff0011";
  const artifact = (
    object: string,
    references: unknown = { "7": [{ start: 4, length: 4 }] },
  ) => {
    const path = join(
      dir,
      `artifact-${Math.random().toString(16).slice(2)}.json`,
    );
    writeFileSync(
      path,
      JSON.stringify({
        deployedBytecode: { object, immutableReferences: references },
      }),
    );
    return path;
  };
  const onChain = (hex: string) => {
    const path = join(dir, `code-${Math.random().toString(16).slice(2)}.hex`);
    writeFileSync(path, `${hex}\n`);
    return path;
  };
  const compare = (a: string, b: string, ...flags: string[]) => {
    const run = node("compare-code.mjs", [a, b, ...flags]);
    return {
      status: run.status,
      lines: run.stdout.trim().split("\n"),
      fields: run.stdout.trim().split("\n")[0]?.split("\t") ?? [],
    };
  };

  it("matches when the two differ only inside the immutable ranges", () => {
    const run = compare(
      artifact(BUILT),
      onChain("0x60806040deadbeefaabbccddeeff0011"),
      "--immutables",
    );
    expect(run.status).toBe(0);
    expect(run.fields).toEqual([
      "MATCH",
      "16",
      "16",
      "1",
      "4",
      "equal outside the immutable ranges",
    ]);
    // The word that was blanked is shown, to be held against the launch manifest.
    expect(run.lines[1]).toBe("  offset 4\t0xdeadbeef");
  });

  it("reports one differing byte outside the ranges, and where", () => {
    const run = compare(
      artifact(BUILT),
      onChain("0x60806040deadbeefaabbccddeeff0012"),
    );
    expect(run.status).toBe(1);
    expect(run.fields[0]).toBe("DIFFERENT");
    expect(run.fields[5]).toBe(
      "first differing byte at offset 15, outside every immutable range",
    );
  });

  it("reports a difference in length, and an address with no code", () => {
    const longer = compare(
      artifact(BUILT),
      onChain("0x60806040deadbeefaabbccddeeff001100"),
    );
    expect([longer.status, longer.fields[0], longer.fields[5]]).toEqual([
      1,
      "DIFFERENT",
      "lengths differ: built 16 bytes, on chain 17 bytes",
    ]);
    const empty = compare(artifact(BUILT), onChain("0x"));
    expect([empty.status, empty.fields[0]]).toEqual([1, "NO_CODE"]);
  });

  it("does not let a range beyond the code pass, and says when an input cannot be read", () => {
    const beyond = compare(
      artifact(BUILT, { "7": [{ start: 14, length: 4 }] }),
      onChain(BUILT),
    );
    expect([beyond.status, beyond.fields[0]]).toEqual([1, "DIFFERENT"]);
    expect(
      node("compare-code.mjs", [join(dir, "nothing.json"), onChain(BUILT)])
        .status,
    ).toBe(2);
    expect(
      node("compare-code.mjs", [
        artifact("0x60__$placeholder$__"),
        onChain(BUILT),
      ]).status,
    ).toBe(2);
    expect(node("compare-code.mjs", []).status).toBe(2);
  });

  it("compares everything when the contract has no immutable", () => {
    const same = compare(
      artifact(BUILT, {}),
      onChain(BUILT.toUpperCase().replace("0X", "0x")),
    );
    expect(same.fields).toEqual([
      "MATCH",
      "16",
      "16",
      "0",
      "0",
      "equal outside the immutable ranges",
    ]);
    expect(
      compare(
        artifact(BUILT, {}),
        onChain("0x60806040deadbeefaabbccddeeff0011"),
      ).status,
    ).toBe(1);
  });
});

describe("scripts/repro.sh", () => {
  const repro = join(ROOT, "scripts", "repro.sh");

  it("is valid shell and builds into a temporary folder, not into the repository", () => {
    expect(spawnSync("bash", ["-n", repro]).status).toBe(0);
    const text = readFileSync(repro, "utf8");
    expect(text).toContain(
      '--out "$WORK/$name/out" --cache-path "$WORK/$name/cache"',
    );
    expect(text).not.toMatch(/cast send|--private-key|--account|forge clean/);
  });

  /**
   * The whole script, with `forge` and `cast` played by two small shell scripts: the first writes
   * an artifact for every launched contract, the second answers with the code the test chooses.
   * Nothing is built and no node is asked.
   */
  function run(
    onChain: string,
    options: { chain?: string; failCode?: boolean; script?: string } = {},
  ) {
    const bin = mkdtempSync(join(tmpdir(), "hw-repro-bin-"));
    const work = mkdtempSync(join(tmpdir(), "hw-repro-work-"));
    const launched = CONTRACTS.filter(
      (contract) =>
        (
          DEPLOYMENT_BOOK[contract.launch].contracts as Record<
            string,
            string | null
          >
        )[contract.key],
    ).map((contract) => contract.name);
    writeFileSync(
      join(bin, "forge"),
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "forge Version: a stand-in for the test"; exit 0; fi
out=""
while [ "$#" -gt 0 ]; do if [ "$1" = "--out" ]; then out="$2"; fi; shift; done
for name in ${launched.join(" ")}; do
  mkdir -p "$out/$name.sol"
  printf '%s' '{"deployedBytecode":{"object":"0x6080604000000000aabbccddeeff0011","immutableReferences":{"7":[{"start":4,"length":4}]}}}' > "$out/$name.sol/$name.json"
done
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, "cast"),
      `#!/usr/bin/env bash
case "$1" in
  chain-id) echo "${options.chain ?? "1"}" ;;
  code) ${options.failCode ? 'echo "the node did not answer" >&2; exit 1' : `echo "${onChain}"`} ;;
  keccak) echo "0x00" ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    const result = spawnSync("bash", [options.script ?? repro], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        TMPDIR: work,
        RPC_URL: "https://stand-in.example",
      },
    });
    rmSync(bin, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
    return {
      status: result.status,
      lines: result.stdout.trim().split("\n"),
      stderr: result.stderr,
      launched,
    };
  }

  it("prints one line per launched contract and exits 0 when every one matches", () => {
    const { status, lines, launched } = run(
      "0x60806040deadbeefaabbccddeeff0011",
    );
    expect(status).toBe(0);
    const verdicts = lines.filter((line) =>
      /^(MATCH|DIFFERENT|NO_CODE|UNREAD)/.test(line),
    );
    expect(verdicts).toHaveLength(launched.length);
    expect(verdicts.every((line) => line.startsWith("MATCH "))).toBe(true);
    expect(lines.at(-1)).toBe(
      `repro: ${launched.length} of ${launched.length} launched contracts match the code built from this repository.`,
    );
  });

  it("exits 1 when the code at an address differs outside the immutable ranges", () => {
    const { status, lines, launched } = run(
      "0x60806040deadbeefaabbccddeeff0012",
    );
    expect(status).toBe(1);
    expect(lines.filter((line) => line.startsWith("DIFFERENT "))).toHaveLength(
      launched.length,
    );
    expect(lines.at(-1)).toBe(
      `repro: 0 of ${launched.length} launched contracts match the code built from this repository.`,
    );
  });

  it("exits 1 when an address holds no code, and 2 when the code cannot be read", () => {
    expect(run("0x").status).toBe(1);
    const unread = run("0x", { failCode: true });
    expect(unread.status).toBe(2);
    expect(unread.lines.some((line) => line.startsWith("UNREAD "))).toBe(true);
  });

  it("refuses a node on another chain before building anything", () => {
    expect(
      run("0x60806040deadbeefaabbccddeeff0011", { chain: "11155111" }).status,
    ).toBe(2);
  });

  it("compares every launched contract when started through a symbolic link to the repository", () => {
    const { status, lines, launched } = run(
      "0x60806040deadbeefaabbccddeeff0011",
      { script: join(LINKED_ROOT, "scripts", "repro.sh") },
    );
    expect(launched.length).toBeGreaterThanOrEqual(3);
    expect(status).toBe(0);
    expect(lines.filter((line) => line.startsWith("MATCH "))).toHaveLength(
      launched.length,
    );
    expect(lines.at(-1)).toBe(
      `repro: ${launched.length} of ${launched.length} launched contracts match the code built from this repository.`,
    );
  });

  it("exits 2, not 0, when the deployments book gives no launched contract", () => {
    // A copy of the script and its two helpers beside a book whose every address is null.
    const copy = mkdtempSync(join(tmpdir(), "hw-repro-empty-"));
    mkdirSync(join(copy, "scripts", "lib"), { recursive: true });
    mkdirSync(join(copy, "packages", "shared", "src"), { recursive: true });
    for (const path of [
      ["scripts", "repro.sh"],
      ["scripts", "lib", "book.mjs"],
      ["scripts", "lib", "compare-code.mjs"],
    ])
      copyFileSync(join(ROOT, ...path), join(copy, ...path));
    const book = readFileSync(
      join(ROOT, "packages", "shared", "src", "deployments.ts"),
      "utf8",
    ).replace(/"0x[0-9a-fA-F]{40}"/g, "null");
    writeFileSync(
      join(copy, "packages", "shared", "src", "deployments.ts"),
      book,
    );
    expect(node("book.mjs", ["contracts"], copy).stdout).toBe("");
    const empty = run("0x60806040deadbeefaabbccddeeff0011", {
      script: join(copy, "scripts", "repro.sh"),
    });
    rmSync(copy, { recursive: true, force: true });
    expect(empty.status).toBe(2);
    expect(empty.stderr).toContain(
      "repro: the deployments book gave no launched contract, so nothing was compared.",
    );
    expect(empty.lines.some((line) => line.startsWith("MATCH "))).toBe(false);
  });

  it("exits 2, not 0, when the deployments book gives no chain id", () => {
    // A copy of the script and its two helpers beside a book with no `chainId`.
    const copy = mkdtempSync(join(tmpdir(), "hw-repro-nochain-"));
    mkdirSync(join(copy, "scripts", "lib"), { recursive: true });
    mkdirSync(join(copy, "packages", "shared", "src"), { recursive: true });
    for (const path of [
      ["scripts", "repro.sh"],
      ["scripts", "lib", "book.mjs"],
      ["scripts", "lib", "compare-code.mjs"],
    ])
      copyFileSync(join(ROOT, ...path), join(copy, ...path));
    const source = readFileSync(
      join(ROOT, "packages", "shared", "src", "deployments.ts"),
      "utf8",
    );
    const book = source.replace(/^\s*chainId: 1,\n/m, "");
    expect(book).not.toBe(source);
    writeFileSync(
      join(copy, "packages", "shared", "src", "deployments.ts"),
      book,
    );
    const script = join(copy, "scripts", "repro.sh");
    const neverBuilt = (lines: string[]) =>
      lines.some((line) => /^(MATCH|repro: chain|repro: building)/.test(line));

    // book.mjs refuses such a book, so the script stops at its first question to it.
    const helper = node("book.mjs", ["chain-id"], copy);
    const refused = run("0x60806040deadbeefaabbccddeeff0011", { script });

    // A helper that lists contracts but answers `chain-id` with nothing and exit 0 is refused too.
    writeFileSync(
      join(copy, "scripts", "lib", "book.mjs"),
      `if (process.argv[2] === "contracts") console.log("a launches/a-payroll Questions 0x${"1".repeat(40)} 1");\n`,
    );
    const silent = run("0x60806040deadbeefaabbccddeeff0011", { script });
    rmSync(copy, { recursive: true, force: true });

    expect([helper.status, helper.stdout]).toEqual([1, ""]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("the book has no chainId");
    expect(neverBuilt(refused.lines)).toBe(false);
    expect(silent.status).toBe(2);
    expect(silent.stderr).toContain(
      "repro: the deployments book gave no chain id, so nothing was compared.",
    );
    expect(neverBuilt(silent.lines)).toBe(false);
  });
});

describe("the house list", () => {
  it("holds the published wallets, then every contract of the book, once each", () => {
    const published = parseHouseFile(HOUSE_FILE);
    const list = houseList(published, [
      {
        name: "Questions",
        launch: "a",
        address: "0xEECE4628ceb091C13393fc64056Be8b8501fD3F6",
      },
      {
        name: "WorkOrders",
        launch: "b",
        address: "0x00000000000000000000000000000000000b0002",
      },
    ]);
    expect(list.entries.map((entry) => entry.label)).toEqual([
      "W1",
      "H1",
      "Questions",
      "WorkOrders",
      "JobsReport",
      "Payroll",
    ]);
    expect(list.sideOf(W1.toUpperCase().replace("0X", "0x"))).toBe("HOUSE");
    expect(list.sideOf("0x00000000000000000000000000000000000b0002")).toBe(
      "HOUSE",
    );
    expect(list.sideOf("0x00000000000000000000000000000000000a11ce")).toBe(
      "OUTSIDE",
    );
    expect(list.sideOf(null)).toBe("OUTSIDE");
    expect(list.labelOf("0x00000000000000000000000000000000000b0002")).toBe(
      "WorkOrders",
    );
  });

  it("refuses a list it cannot read", () => {
    expect(() => parseHouseFile({ wallets: [] })).toThrow(/lists no wallets/);
    expect(() =>
      parseHouseFile({ wallets: [{ label: "W1", address: "0x12" }] }),
    ).toThrow(/W1 has no address/);
    expect(() => parseHouseFile(null)).toThrow(/is not an object/);
  });

  it("adds up HOUSE and OUTSIDE apart and always gives both", () => {
    const tally = new Tally(true)
      .add("HOUSE", 5n)
      .add("OUTSIDE", 7n)
      .add("OUTSIDE");
    expect(tally.counted()).toEqual({
      total: 3,
      house: 1,
      outside: 2,
      imd: { totalWei: "12", houseWei: "5", outsideWei: "7" },
    });
    expect(new Tally().counted()).toEqual({ total: 0, house: 0, outside: 0 });
  });
});

describe("formatting", () => {
  it("prints an amount exactly, never rounded", () => {
    expect(imd("0")).toBe("0");
    expect(imd("550000000000000000")).toBe("0.55");
    expect(imd("112000000000000000000")).toBe("112");
    expect(imd("1234567000000000000000001")).toBe(
      "1,234,567.000000000000000001",
    );
    expect(int(26_184_132)).toBe("26,184,132");
    expect(int("999")).toBe("999");
    expect(() => int("1.5")).toThrow(TypeError);
    expect(utc("2026-10-13T13:10:35Z")).toBe("13 Oct 2026, 13:10:35 UTC");
  });

  it("keeps a pipe or a line break from ending a table cell", () => {
    expect(table(["a", "b"], [["x|y", "one\ntwo"]])).toBe(
      "| a | b |\n| --- | --- |\n| x\\|y | one two |",
    );
  });
});

describe("the recording", () => {
  it("keeps only what the builder reads of a block, a transaction, a receipt and a job", () => {
    const tape = emptyTape("test");
    tape.rpc['eth_getBlockByNumber ["finalized",false]'] = {
      result: {
        number: "0x1",
        hash: "0x2",
        timestamp: "0x3",
        transactions: ["0x4"],
      },
    };
    tape.rpc['eth_getTransactionByHash ["0xaa"]'] = {
      result: {
        hash: "0xaa",
        from: "0x1",
        to: "0x2",
        blockNumber: "0x3",
        input: "0xffff",
      },
    };
    tape.rpc['eth_getTransactionReceipt ["0xaa"]'] = {
      result: {
        status: "0x1",
        gasUsed: "0x5",
        logs: [{ address: "0x1", topics: [], data: "0x", logIndex: "0x0" }],
      },
    };
    tape.rpc['eth_getCode ["0x1","0x2"]'] = { result: "0x6080" };
    tape.api["/jobs/abc"] = {
      status: 200,
      body: {
        id: "abc",
        state: "executing",
        objective: "x".repeat(500),
        nodes: [1, 2],
        project: {},
      },
    };
    const slim = slimTape(tape);
    expect(slim.rpc['eth_getBlockByNumber ["finalized",false]']).toEqual({
      result: { number: "0x1", hash: "0x2", timestamp: "0x3" },
    });
    expect(slim.rpc['eth_getTransactionByHash ["0xaa"]']).toEqual({
      result: { hash: "0xaa", from: "0x1", to: "0x2", blockNumber: "0x3" },
    });
    expect(slim.rpc['eth_getTransactionReceipt ["0xaa"]']).toEqual({
      result: {
        status: "0x1",
        logs: [{ address: "0x1", topics: [], data: "0x" }],
      },
    });
    expect(slim.rpc['eth_getCode ["0x1","0x2"]']).toEqual({ result: "0x6080" });
    const job = slim.api["/jobs/abc"]?.body as {
      objective: string;
      nodes?: unknown;
    };
    expect(job.objective.length).toBeLessThan(200);
    expect(job.nodes).toBeUndefined();
  });

  it("keeps of a launch's own record the list row's fields and its contracts", () => {
    const tape = emptyTape("t");
    const artifacts = [
      {
        name: "Payroll",
        address: "0x1",
        verifiedAt: "2026-10-13T10:10:51.787Z",
        verifyFailure: null,
      },
    ];
    tape.api["/launches/92bb495f-f565-414a-9b0d-d4bc62e699ac"] = {
      status: 200,
      body: {
        id: "92bb495f-f565-414a-9b0d-d4bc62e699ac",
        launchNumber: 1531,
        status: "live",
        artifacts,
        attestation: { contracts: [1, 2, 3] },
        jobs: [{ objective: "x".repeat(500) }],
        allocations: {},
      },
    };
    const body = slimTape(tape).api[
      "/launches/92bb495f-f565-414a-9b0d-d4bc62e699ac"
    ]?.body as Record<string, unknown>;
    expect(body).toEqual({
      id: "92bb495f-f565-414a-9b0d-d4bc62e699ac",
      launchNumber: 1531,
      status: "live",
      artifacts,
    });
  });
});
