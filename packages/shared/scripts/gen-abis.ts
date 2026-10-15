/**
 * Writes `src/abi/generated/<name>.ts` from the Foundry build output of the launch projects.
 *
 *   pnpm --filter @help-wanted/shared abi:gen
 *
 * It refuses to write from a missing or an out-of-date artifact, and says which project to build:
 *
 *   cd launches/<project> && forge build
 *
 * (never `forge clean`). `--allow-stale` writes from what is there anyway, for a contract whose
 * sources are being edited; the test that guards this folder will still say the artifact is old.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUILT_CONTRACTS,
  GENERATED_DIR,
  artifactRelPath,
  readArtifact,
  renderBuiltAbiFile,
  renderBuiltIndexFile,
  staleSources,
} from "./abi-build.js";

const allowStale = process.argv.includes("--allow-stale");
const problems: string[] = [];
const files: { path: string; text: string }[] = [];

for (const contract of BUILT_CONTRACTS) {
  const artifact = readArtifact(contract);
  if (artifact === null) {
    problems.push(
      `${artifactRelPath(contract)} is missing: run \`forge build\` in launches/${contract.project}`,
    );
    continue;
  }
  const stale = staleSources(contract);
  if (stale.length > 0) {
    const message = `${artifactRelPath(contract)} was built from other sources than those on disk (${stale.join(", ")}): run \`forge build\` in launches/${contract.project}`;
    if (allowStale) console.warn(`warning: ${message}`);
    else problems.push(message);
  }
  files.push({
    path: join(GENERATED_DIR, `${contract.name}.ts`),
    text: renderBuiltAbiFile(contract, artifact.abi),
  });
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error("nothing was written");
  process.exit(1);
}

mkdirSync(GENERATED_DIR, { recursive: true });
for (const file of files) writeFileSync(file.path, file.text);
writeFileSync(join(GENERATED_DIR, "index.ts"), renderBuiltIndexFile());
console.log(`wrote ${files.length} ABI files to ${GENERATED_DIR}`);
