/**
 * Writes `src/abi/<name>.ts` for the contracts that are not ours (IdentityMD's and the token
 * standards) from the signatures in `abi-sources.ts`.
 *
 *   pnpm --filter @help-wanted/shared abis
 *
 * Our own contracts' ABIs are written by `gen-abis.ts` from the build output instead.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ABI_SOURCES } from "./abi-sources.js";
import { renderAbiFile, renderIndexFile } from "./render-abi.js";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "abi");
mkdirSync(outDir, { recursive: true });
for (const source of ABI_SOURCES) {
  writeFileSync(join(outDir, `${source.name}.ts`), renderAbiFile(source));
}
writeFileSync(join(outDir, "index.ts"), renderIndexFile(ABI_SOURCES));
console.log(`wrote ${ABI_SOURCES.length} ABI files to ${outDir}`);
