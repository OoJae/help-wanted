/**
 * ABIs of HELP WANTED's own contracts, taken from what the compiler wrote.
 *
 * Each launch project is a Foundry project; `forge build` leaves one artifact per contract at
 * `launches/<project>/out/<File>.sol/<Contract>.json`. The generator (`gen-abis.ts`) copies the
 * `abi` of each artifact listed here into `src/abi/generated/<name>.ts` as an `as const` array, so
 * nothing about our own contracts is typed by hand. A test renders the same files again and fails
 * when one differs, and fails when an artifact is older than the sources it was compiled from.
 *
 * Only `out/` is read. The `out-<area>` folders beside it are left over from the first build wave
 * and are stale.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";

export type LaunchProject = "a-payroll" | "b-desk" | "c-company";

export interface BuiltContract {
  /** File name under `src/abi/generated`; the exported constant is `<name>Abi`. */
  name: string;
  project: LaunchProject;
  /** The Solidity file the artifact folder is named after, without `.sol`. */
  file: string;
  /** The contract or interface inside that file. */
  contract: string;
  comment: string;
}

export const BUILT_CONTRACTS: readonly BuiltContract[] = [
  {
    name: "questions",
    project: "a-payroll",
    file: "Questions",
    contract: "Questions",
    comment: "Questions (launch A): Standing Questions, the contract that buys its own oracle answers.",
  },
  {
    name: "jobsReport",
    project: "a-payroll",
    file: "JobsReport",
    contract: "JobsReport",
    comment: "JobsReport (launch A): the Robot Jobs Report, printed from the payrolls and hires feeds.",
  },
  {
    name: "payroll",
    project: "a-payroll",
    file: "Payroll",
    contract: "Payroll",
    comment: "Payroll (launch A): the fee split, the staker stream, the seat pool and the feed budget.",
  },
  {
    name: "workProof",
    project: "b-desk",
    file: "WorkProof",
    contract: "WorkProof",
    comment: "WorkProof (launch B): checks a work record against IdentityMD's WorkRegistry.",
  },
  {
    name: "workOrders",
    project: "b-desk",
    file: "WorkOrders",
    contract: "WorkOrders",
    comment: "WorkOrders (launch B): the hire desk.",
  },
  {
    name: "workEmployer",
    project: "b-desk",
    file: "IWorkOrders",
    contract: "IWorkEmployer",
    comment: "IWorkEmployer (launch B): the callback an employer contract implements.",
  },
  {
    name: "crowdPots",
    project: "b-desk",
    file: "CrowdPots",
    contract: "CrowdPots",
    comment: "CrowdPots (launch B): pots that many wallets chip into and that hire through the desk.",
  },
  {
    name: "doorbell",
    project: "b-desk",
    file: "Doorbell",
    contract: "Doorbell",
    comment: "Doorbell (launch B): the ownerless demo employer; every 25th ring opens an order.",
  },
  {
    name: "rules",
    project: "c-company",
    file: "Rules",
    contract: "Rules",
    comment: "Rules (launch C): WHEN a condition holds, THEN hire or pay.",
  },
  {
    name: "endowments",
    project: "c-company",
    file: "Endowments",
    contract: "Endowments",
    comment: "Endowments (launch C): staked IMD whose yield funds a meter, a pot or a recipient.",
  },
  {
    name: "zap",
    project: "c-company",
    file: "Zap",
    contract: "Zap",
    comment: "Zap (launch C): pay with ETH; swaps to IMD and chips in, funds a meter or buys.",
  },
];

/** The repository root, from `packages/shared/scripts`. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** Where the generated files live. */
export const GENERATED_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "abi", "generated");

export function projectDir(project: LaunchProject, root: string = REPO_ROOT): string {
  return join(root, "launches", project);
}

/** `launches/<project>/out/<File>.sol/<Contract>.json`, relative to the repository root. */
export function artifactRelPath(c: BuiltContract): string {
  return `launches/${c.project}/out/${c.file}.sol/${c.contract}.json`;
}

export function artifactPath(c: BuiltContract, root: string = REPO_ROOT): string {
  return join(root, artifactRelPath(c));
}

interface Artifact {
  abi: unknown[];
  metadata?: { sources?: Record<string, { keccak256?: string }> };
}

/** The artifact as Foundry wrote it, or null when the project has not been built. */
export function readArtifact(c: BuiltContract, root: string = REPO_ROOT): Artifact | null {
  const path = artifactPath(c, root);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Artifact;
  if (!Array.isArray(parsed.abi)) throw new Error(`${artifactRelPath(c)} has no abi`);
  return parsed;
}

/**
 * The source files an artifact was compiled from that no longer match the files on disk. The
 * compiler records the keccak256 of every source in the artifact's metadata, so a changed file
 * shows even when the ABI happens to be the same. An empty list means the artifact is current.
 * A source that is no longer on disk is listed too.
 */
export function staleSources(c: BuiltContract, root: string = REPO_ROOT): string[] {
  const artifact = readArtifact(c, root);
  if (artifact === null) return [];
  const sources = artifact.metadata?.sources;
  if (sources === undefined) return ["(the artifact carries no metadata: build with Foundry's defaults)"];
  const stale: string[] = [];
  for (const [path, info] of Object.entries(sources)) {
    const file = join(projectDir(c.project, root), path);
    if (!existsSync(file)) {
      stale.push(`${path} (not on disk)`);
      continue;
    }
    if (keccak256(new Uint8Array(readFileSync(file))) !== info.keccak256) stale.push(path);
  }
  return stale;
}

/** The text of `src/abi/generated/<name>.ts` for one artifact's ABI. */
export function renderBuiltAbiFile(c: BuiltContract, abi: unknown[]): string {
  return (
    `// Generated by scripts/gen-abis.ts from ${artifactRelPath(c)}.\n` +
    "// Do not edit by hand. After a contract changes, run `forge build` in its launch project and\n" +
    "// then `pnpm --filter @help-wanted/shared abi:gen`.\n" +
    `\n/** ${c.comment} */\n` +
    `export const ${c.name}Abi = ${JSON.stringify(abi, null, 2)} as const;\n`
  );
}

/** The text of `src/abi/generated/index.ts`. */
export function renderBuiltIndexFile(contracts: readonly BuiltContract[] = BUILT_CONTRACTS): string {
  return (
    "// Generated by scripts/gen-abis.ts. Do not edit by hand.\n\n" +
    contracts.map((c) => `export { ${c.name}Abi } from "./${c.name}.js";`).join("\n") +
    "\n"
  );
}
