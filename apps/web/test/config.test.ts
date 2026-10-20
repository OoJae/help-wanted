/**
 * Configuration: IdentityMD's addresses (the shared package's), our own (the shared deployments
 * book: a contract reads "not launched yet" until its launch is written there), the house wallet
 * list and the environment. What is launched is never assumed here: a test injects the book it is
 * about (`BOOKS.none`, `BOOKS.aOnly`, `BOOKS.all`) or holds the site to the real one. Where the
 * repository carries the source of truth for a value (`Mainnet.sol`, `evidence/house-wallets.json`),
 * what this app prints is compared with it.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  CONTRACT_KEYS,
  deploymentEnvNames,
  LAUNCH_KEYS,
  NOT_LAUNCHED,
  resolveDeployments,
} from "~/config/deployments";
import { hostOf, readEnv } from "~/config/env";
import { HOUSE_WALLETS, houseSet } from "~/config/house";
import { DEPLOYMENT_BOOK, flattenBook, isLaunched, MAINNET, parseSpecInputs } from "@help-wanted/shared";
import { DEFAULT_RPC_URL, MULTICALL3, REFERENCE_JOB } from "~/config/chain";
import { inputsClause, kindLabel, NOT_OFFERED, specInputsProblem, TEMPLATES } from "~/config/templates";
import { HEADER_JOB } from "~/data";
import { allContracts, PUBLIC_RPC } from "~/models/common";
import { BOOKS, TEST_LAUNCH } from "./helpers";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

describe("IdentityMD's addresses", () => {
  it("are checksummed and distinct", () => {
    const values = (Object.values(MAINNET) as (string | number)[]).filter(
      (value): value is string => typeof value === "string" && value.length === 42,
    );
    expect(values.length).toBeGreaterThanOrEqual(20);
    for (const address of values) expect(getAddress(address)).toBe(address);
    expect(new Set(values.map((a) => a.toLowerCase())).size).toBe(values.length);
    // Multicall3 is this app's own convenience; it is not one of the protocol's addresses.
    expect(getAddress(MULTICALL3)).toBe(MULTICALL3);
    expect(values.map((a) => a.toLowerCase())).not.toContain(MULTICALL3.toLowerCase());
  });

  it("include the ones the brief names", () => {
    expect(MAINNET.IMD.toLowerCase()).toBe("0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7");
    expect(MAINNET.SIMD.toLowerCase()).toBe("0x9efa934d9fad4ae28c998a40195646b965a97247");
    expect(MAINNET.SEATS.toLowerCase()).toBe("0x0000ec93127baa929e58e97dd0095a2bfb38ec1d");
    expect(MAINNET.SEAT_ADAPTER.toLowerCase()).toBe("0xde152afb7db5373f34876e1499fbd893a82dd336");
    // The Intake is version 2; version 1 is legacy and holds the earlier history.
    expect(MAINNET.INTAKE.toLowerCase()).toBe("0xa43e6f75ee006411f79ac1c84120606c2330de82");
    expect(MAINNET.INTAKE_V1.toLowerCase()).toBe("0x1397434cd35e8a9c8ac312a61d3a285eb31dea56");
    expect(MAINNET.ORACLE_SIGNER.toLowerCase()).toBe("0x5598aa9146215bc13eb26f2c692ad1461fd32982");
    expect(MAINNET.WORK_REGISTRY.toLowerCase()).toBe("0xb6d0a187b050fa5bb0b87033a203f37becf4a775");
    expect(MAINNET.FEE_PAYEE.toLowerCase()).toBe("0x4e0fa57bde726079356537e2f34d671e9f41adbc");
    expect(MAINNET.PROJECT_FACTORY.toLowerCase()).toBe("0xff03410d0fe5fa8f7f59f743de35e333d9857120");
    expect(MAINNET.SEAT_COUNT).toBe(2000);
  });

  it("the reference job's two spellings agree", () => {
    expect(REFERENCE_JOB.jobIdBytes16).toBe(`0x${REFERENCE_JOB.jobId.replace(/-/g, "")}`);
    expect(REFERENCE_JOB.receipt).toBe("0x3db993254c94479c4bf74d1115c7db3bfb48e5859379a4e83467ab6c3338b2c5");
    expect(HEADER_JOB.jobIdBytes16).toBe(`0x${HEADER_JOB.jobId.replace(/-/g, "")}`);
    expect(HEADER_JOB.recordHash).toBe("0x990ae775288252e4b1b12c4a85bbe66db0140ca733e30002a6525814bfdaa17d");
  });

  const mainnetSol = `${ROOT}launches/a-payroll/src/interfaces/external/Mainnet.sol`;
  it.skipIf(!existsSync(mainnetSol))("match Mainnet.sol, constant for constant", () => {
    const source = readFileSync(mainnetSol, "utf8");
    const inSol = new Map<string, string>();
    for (const match of source.matchAll(/address internal constant ([A-Z0-9_]+) = (0x[0-9a-fA-F]{40});/g)) {
      inSol.set(match[1] ?? "", match[2] ?? "");
    }
    expect(inSol.size).toBeGreaterThan(10);
    let compared = 0;
    for (const [name, address] of Object.entries(MAINNET)) {
      // The shared list is the union of the three projects' copies; this file is launch A's.
      if (!inSol.has(name)) continue;
      expect(String(address).toLowerCase(), name).toBe(inSol.get(name)?.toLowerCase());
      compared++;
    }
    expect(compared).toBeGreaterThanOrEqual(8);
    expect(inSol.get("INTAKE")?.toLowerCase()).toBe(MAINNET.INTAKE.toLowerCase());
    expect(source).toContain(`uint256 internal constant SEAT_COUNT = ${MAINNET.SEAT_COUNT};`);
  });
});

describe("our own addresses", () => {
  it("with no launch in the book, every contract reads as not launched yet", () => {
    const deployments = resolveDeployments({}, BOOKS.none);
    expect(deployments.launchedCount).toBe(0);
    expect(deployments.fromEnv).toEqual([]);
    expect(Object.keys(deployments.contracts)).toEqual([...CONTRACT_KEYS]);
    for (const status of allContracts(deployments)) {
      expect(status).toMatchObject({ address: null, label: NOT_LAUNCHED, url: null });
    }
    for (const key of LAUNCH_KEYS) {
      expect(deployments.launches[key]).toMatchObject({ launchNumber: null, txHash: null, block: null });
    }
  });

  it("group into the three launches in manifest order", () => {
    const { launches } = resolveDeployments({}, BOOKS.none);
    expect(launches.A.contracts).toEqual(["questions", "jobsReport", "payroll"]);
    expect(launches.B.contracts).toEqual(["workProof", "workOrders", "crowdPots", "doorbell"]);
    expect(launches.C.contracts).toEqual(["rules", "endowments", "zap"]);
  });

  it("switch on from one place: a launch written into the deployments book", () => {
    // The same code, three books: nothing launched, launch A only, all three.
    const none = resolveDeployments({}, BOOKS.none);
    const aOnly = resolveDeployments({}, BOOKS.aOnly);
    const all = resolveDeployments({}, BOOKS.all);
    expect([none.launchedCount, aOnly.launchedCount, all.launchedCount]).toEqual([0, 3, 10]);
    for (const deployments of [none, aOnly, all]) expect(deployments.fromEnv).toEqual([]);

    // Launch A only: its three contracts have addresses and its launch is on record; B and C have nothing.
    expect(aOnly.contracts.questions.address?.toLowerCase()).toBe(BOOKS.aOnly.a.contracts.questions);
    expect(aOnly.launches.A).toMatchObject({
      launchNumber: TEST_LAUNCH.a.launchNumber,
      block: TEST_LAUNCH.a.block,
      txHash: TEST_LAUNCH.a.transaction,
    });
    expect(aOnly.launches.B).toMatchObject({ launchNumber: null, txHash: null, block: null });
    expect(aOnly.contracts.workOrders.address).toBeNull();
    expect(aOnly.contracts.zap.address).toBeNull();
    expect(
      allContracts(aOnly)
        .filter((c) => c.address !== null)
        .map((c) => c.launch),
    ).toEqual(["A", "A", "A"]);
    // All three: every contract has an address and every launch its transaction.
    expect(allContracts(all).every((c) => c.address !== null && c.url !== null)).toBe(true);
    for (const key of LAUNCH_KEYS) expect(all.launches[key].txHash).not.toBeNull();
  });

  it("follow the real deployments book, whatever it holds today", () => {
    // No launch is named here: this reads the shared book and holds the site to it, so writing
    // launch B and then launch C into the book needs no change to this test.
    const deployments = resolveDeployments({});
    const flat = flattenBook(DEPLOYMENT_BOOK);
    expect(deployments.fromEnv).toEqual([]);
    expect(deployments.launchedCount).toBe(CONTRACT_KEYS.filter((key) => flat[key] !== null).length);
    for (const key of CONTRACT_KEYS) expect(deployments.contracts[key].address).toBe(flat[key]);
    for (const [page, book] of [
      ["A", "a"],
      ["B", "b"],
      ["C", "c"],
    ] as const) {
      const record = DEPLOYMENT_BOOK[book];
      const addresses = Object.values(record.contracts);
      expect(deployments.launches[page]).toMatchObject({
        project: record.project,
        launchNumber: record.launchNumber,
        txHash: record.transaction,
        block: record.block,
      });
      // A launch is written in whole or not at all: its addresses come with its transaction, its
      // block and its number, and a launch with none of those has no address either.
      const launched = isLaunched(book);
      expect(addresses.every((address) => address !== null)).toBe(launched);
      expect(addresses.some((address) => address !== null)).toBe(launched);
      expect(record.transaction !== null).toBe(launched);
      expect(record.block !== null).toBe(launched);
      expect(record.launchNumber !== null).toBe(launched);
      if (record.transaction) expect(record.transaction).toMatch(/^0x[0-9a-f]{64}$/);
      for (const address of addresses) if (address) expect(isAddress(address, { strict: false })).toBe(true);
    }
    // No address appears twice. (Whether the shared list of mainnet constants also names one of
    // them is that list's business: a later launch's Mainnet.sol records an earlier launch's address.)
    const ours = CONTRACT_KEYS.map((key) => flat[key]?.toLowerCase()).filter(Boolean);
    expect(new Set(ours).size).toBe(ours.length);
  });

  it("can be filled from the environment, and ignore anything that is not an address", () => {
    const desk = "0x00000000000000000000000000000000000000d1";
    const deployments = resolveDeployments(
      {
        HW_ADDR_WORK_ORDERS: desk,
        HW_ADDR_JOBS_REPORT: "0x00000000000000000000000000000000000000E2",
        HW_ADDR_PAYROLL: "not-an-address",
        HW_ADDR_ZAP: "",
        HW_ADDR_CROWDPOTS: desk, // misspelt: the name is HW_ADDR_CROWD_POTS
      },
      BOOKS.none,
    );
    expect(deployments.launchedCount).toBe(2);
    expect(deployments.fromEnv).toEqual(["jobsReport", "workOrders"]);
    expect(deployments.contracts.workOrders.address).toBe(getAddress(desk));
    expect(deployments.contracts.payroll.address).toBeNull();
    expect(deployments.contracts.crowdPots.address).toBeNull();
    expect(allContracts(deployments).find((c) => c.key === "workOrders")).toMatchObject({
      label: getAddress(desk),
      url: `https://etherscan.io/address/${getAddress(desk)}`,
    });
    // An override sits on top of the book: it replaces an address the book has, and counts once.
    const over = resolveDeployments({ HW_ADDR_PAYROLL: desk }, BOOKS.aOnly);
    expect(over.launchedCount).toBe(3);
    expect(over.fromEnv).toEqual(["payroll"]);
    expect(over.contracts.payroll.address).toBe(getAddress(desk));
  });

  it("each has an environment name of the form HW_ADDR_<NAME>", () => {
    expect(deploymentEnvNames()).toEqual({
      questions: "HW_ADDR_QUESTIONS",
      jobsReport: "HW_ADDR_JOBS_REPORT",
      payroll: "HW_ADDR_PAYROLL",
      workProof: "HW_ADDR_WORK_PROOF",
      workOrders: "HW_ADDR_WORK_ORDERS",
      crowdPots: "HW_ADDR_CROWD_POTS",
      doorbell: "HW_ADDR_DOORBELL",
      rules: "HW_ADDR_RULES",
      endowments: "HW_ADDR_ENDOWMENTS",
      zap: "HW_ADDR_ZAP",
    });
    const example = readFileSync(fileURLToPath(new URL("../.env.example", import.meta.url)), "utf8");
    for (const name of Object.values(deploymentEnvNames())) expect(example).toContain(`${name}=`);
    for (const name of [
      "SITE_ORIGIN",
      "RPC_URL",
      "ARCHIVE_RPC_URL",
      "HISTORY_RPC_URL",
      "IMD_API_BASE",
      "IMD_API_MAX_PER_MINUTE",
      "HW_SAMPLE_DATA",
      "TALLY_DAYS",
      "RPC_LOG_WINDOW_BLOCKS",
    ]) {
      expect(example).toContain(`${name}=`);
    }
  });
});

describe("the house list", () => {
  it("holds valid, distinct addresses, and grows by our contracts once they exist", () => {
    for (const wallet of HOUSE_WALLETS) expect(isAddress(wallet.address)).toBe(true);
    const none = houseSet(resolveDeployments({}, BOOKS.none));
    expect(none.size).toBe(HOUSE_WALLETS.length);
    for (const wallet of HOUSE_WALLETS) expect(none.has(wallet.address.toLowerCase())).toBe(true);
    const withDesk = houseSet(
      resolveDeployments({ HW_ADDR_WORK_ORDERS: "0x00000000000000000000000000000000000000D1" }, BOOKS.none),
    );
    expect(withDesk.has("0x00000000000000000000000000000000000000d1")).toBe(true);
    expect(withDesk.size).toBe(HOUSE_WALLETS.length + 1);
    // Every contract a book holds is HOUSE: what Questions pays the swarm is never outside usage.
    expect(houseSet(resolveDeployments({}, BOOKS.aOnly)).size).toBe(HOUSE_WALLETS.length + 3);
    expect(houseSet(resolveDeployments({}, BOOKS.all)).size).toBe(HOUSE_WALLETS.length + 10);
    const today = houseSet(resolveDeployments({}));
    for (const address of Object.values(flattenBook(DEPLOYMENT_BOOK))) {
      if (typeof address === "string") expect(today.has(address.toLowerCase())).toBe(true);
    }
  });

  const evidence = `${ROOT}evidence/house-wallets.json`;
  it.skipIf(!existsSync(evidence))("is the list published in evidence/house-wallets.json", () => {
    const published = JSON.parse(readFileSync(evidence, "utf8")) as {
      wallets: { label: string; address: string; role: string }[];
      contracts?: { label: string; address: string; deployedIn: string; block: number }[];
    };
    expect(HOUSE_WALLETS.map((w) => ({ ...w }))).toEqual(published.wallets);
    // The contracts the evidence file publishes are the ones the deployments book holds, no more
    // and no fewer, each with the transaction and block of its launch.
    const deployments = resolveDeployments({});
    const launched = allContracts(deployments).filter((c) => c.address !== null);
    expect((published.contracts ?? []).map((c) => [c.label, c.address.toLowerCase()])).toEqual(
      launched.map((c) => [c.name, c.address?.toLowerCase()]),
    );
    for (const contract of published.contracts ?? []) {
      const ours = launched.find((c) => c.name === contract.label);
      const launch = deployments.launches[ours?.launch as "A" | "B" | "C"];
      expect([contract.deployedIn, contract.block]).toEqual([launch.txHash, launch.block]);
    }
  });
});

describe("the environment", () => {
  it("defaults to the public endpoints and to no sample data", () => {
    expect(readEnv({})).toEqual({
      siteOrigin: null,
      rpcUrl: "https://ethereum-rpc.publicnode.com",
      archiveRpcUrl: null,
      historyRpcUrl: "https://ethereum-rpc.publicnode.com",
      logWindowBlocks: 7200,
      tallyDays: 14,
      imdApiBase: "https://api.imd.fun",
      apiMaxPerMinute: 40,
      rpcMaxPerMinute: 240,
      clientIpHeader: null,
      keeperStatusPath: null,
      keeperStatusUrl: null,
      sampleData: false,
      repoUrl: null,
      xHandle: null,
      commit: null,
    });
    expect(PUBLIC_RPC).toBe(DEFAULT_RPC_URL);
  });

  it("keeps this server's own calls to the IdentityMD API far below the public limit of 120 a minute", () => {
    expect(readEnv({}).apiMaxPerMinute).toBeLessThanOrEqual(60);
    expect(readEnv({ IMD_API_MAX_PER_MINUTE: "500" }).apiMaxPerMinute).toBe(100);
    expect(readEnv({ IMD_API_MAX_PER_MINUTE: "0" }).apiMaxPerMinute).toBe(1);
    expect(readEnv({ IMD_API_MAX_PER_MINUTE: "lots" }).apiMaxPerMinute).toBe(40);
  });

  it("puts a ceiling on its own calls to the RPC too", () => {
    expect(readEnv({ RPC_MAX_PER_MINUTE: "60" }).rpcMaxPerMinute).toBe(60);
    expect(readEnv({ RPC_MAX_PER_MINUTE: "0" }).rpcMaxPerMinute).toBe(10);
    expect(readEnv({ RPC_MAX_PER_MINUTE: "plenty" }).rpcMaxPerMinute).toBe(240);
  });

  it("believes a header about who is asking only when told to, or behind Railway's edge", () => {
    // On its own the server uses the socket's address, which a caller cannot choose.
    expect(readEnv({}).clientIpHeader).toBeNull();
    // Railway's edge writes the visitor's address into X-Real-IP.
    expect(readEnv({ RAILWAY_PUBLIC_DOMAIN: "hw.up.railway.app" }).clientIpHeader).toBe("x-real-ip");
    expect(readEnv({ RAILWAY_ENVIRONMENT_NAME: "production" }).clientIpHeader).toBe("x-real-ip");
    expect(readEnv({ CLIENT_IP_HEADER: " CF-Connecting-IP " }).clientIpHeader).toBe("cf-connecting-ip");
    expect(readEnv({ CLIENT_IP_HEADER: "not a header!" }).clientIpHeader).toBeNull();
  });

  it("reads what is set, trims it, and refuses a URL that is not http(s)", () => {
    const env = readEnv({
      SITE_ORIGIN: " https://helpwanted.example/ ",
      RPC_URL: "https://rpc.example/v2/secret-key",
      ARCHIVE_RPC_URL: "ftp://nope",
      HW_SAMPLE_DATA: "TRUE",
      X_HANDLE: "@helpwanted",
      RPC_LOG_WINDOW_BLOCKS: "9000",
      RAILWAY_GIT_COMMIT_SHA: "abc123",
    });
    expect(env).toMatchObject({
      siteOrigin: "https://helpwanted.example",
      rpcUrl: "https://rpc.example/v2/secret-key",
      archiveRpcUrl: null,
      historyRpcUrl: "https://rpc.example/v2/secret-key",
      sampleData: true,
      xHandle: "helpwanted",
      logWindowBlocks: 9000,
      commit: "abc123",
    });
    // The receipt search asks its own RPC only when one is set.
    expect(
      readEnv({ RPC_URL: "https://a.example", HISTORY_RPC_URL: "https://b.example" }).historyRpcUrl,
    ).toBe("https://b.example");
    // A page names the host an answer came from, never the URL, which may carry a key.
    expect(hostOf(env.rpcUrl)).toBe("rpc.example");
    expect(readEnv({ RAILWAY_PUBLIC_DOMAIN: "hw.up.railway.app" }).siteOrigin).toBe(
      "https://hw.up.railway.app",
    );
  });
});

describe("the job templates on offer", () => {
  it("are the four kinds the runner can open, with distinct slugs", () => {
    expect(TEMPLATES.map((t) => [t.slug, t.kind])).toEqual([
      ["audit", "audit"],
      ["research", "skill:research-report"],
      ["image", "skill:create-image"],
      ["video", "skill:create-video"],
    ]);
    const offered = new Set(TEMPLATES.map((t) => t.slug));
    for (const item of NOT_OFFERED) expect(offered.has(item.slug)).toBe(false);
  });

  it("reads the inputs clause the way the runner does", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    // What the page writes, the runner's own parser (the shared package's) reads back.
    const clause = inputsClause([
      ["repoUrl", "https://github.com/o/r"],
      ["baseCommit", commit],
      ["focus", ""],
    ]);
    expect(clause).toBe(`Inputs: repoUrl=https://github.com/o/r; baseCommit=${commit}`);
    expect(parseSpecInputs(`Audit it. ${clause}`)).toEqual({
      ok: true,
      inputs: { repoUrl: "https://github.com/o/r", baseCommit: commit },
    });
    expect(inputsClause([["focus", ""]])).toBe("");
    // The older spelling, pairs separated by a space, is one pair with a space in its value: it
    // does not yield a commit, so an audit written that way is refused before it is posted.
    const spaced = specInputsProblem(
      "audit",
      `Audit it. Inputs: repoUrl=https://github.com/o/r baseCommit=${commit}`,
    );
    expect(spaced).toContain("No runner can open this job as written");
    expect(spaced).toContain("End the job text with: Inputs: repoUrl=https://github.com/owner/repo");
    expect(
      specInputsProblem("audit", `Audit it. Inputs: repoUrl=https://github.com/o/r; baseCommit=${commit}`),
    ).toBeNull();
    expect(
      specInputsProblem(
        "audit",
        `Audit it. Inputs: repoUrl=https://github.com/o/r; baseCommit=${commit.toUpperCase()}`,
      ),
    ).toContain("No runner can open this job as written");
    expect(specInputsProblem("audit", "Audit it.")).toContain("No runner can open this job as written");
    expect(specInputsProblem("skill:create-image", "Draw a doorbell.")).toBeNull();
    // A kind this site does not know is the desk's business, not the form's.
    expect(specInputsProblem("skill:something-new", "Do it.")).toBeNull();
    // IdentityMD's plain research template takes a shorter objective than the desk allows.
    expect(specInputsProblem("research", "x".repeat(3915))).toBeNull();
    expect(specInputsProblem("research", "x".repeat(3916))).toContain("at most 3,915 bytes");
  });

  it("gives an audit's measured record size as the range it was measured in, with what that means", () => {
    const audit = TEMPLATES.find((t) => t.slug === "audit");
    expect(audit?.recordSize).toBe("72 to 255 KB");
    expect(audit?.recordNote).toContain("A node refuses a transaction above 128 KB");
    expect(TEMPLATES.find((t) => t.slug === "research")?.recordNote).toBeUndefined();
  });

  it("names a kind for a card without inventing one", () => {
    expect(kindLabel("audit")).toBe("Audit");
    expect(kindLabel("skill:research-report")).toBe("Research report");
    expect(kindLabel("skill:oracle-assess")).toBe("Oracle assess");
    expect(kindLabel(null)).toBe("Job");
  });
});
