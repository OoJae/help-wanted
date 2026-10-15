#!/usr/bin/env node
// Compares the runtime bytecode Foundry built for one contract with the code at an address.
//
// A contract's constructor arguments that are stored as immutables are written into its runtime
// code at deployment, so the built code and the deployed code differ exactly there. Foundry lists
// those places in the artifact (`deployedBytecode.immutableReferences`: byte offset and length).
// Both codes are compared with those ranges set to zero. Everything else must be equal, byte for
// byte, and so must the lengths.
//
// Usage: node compare-code.mjs <artifact.json> <file with the on-chain code as 0x hex> [--immutables]
// Prints one line of facts, separated by tabs:
//   MATCH|DIFFERENT|NO_CODE  <built bytes>  <on-chain bytes>  <ranges blanked>  <bytes blanked>  <note>
// With --immutables it then prints one line per blanked range: its offset and the word on chain.
// Exit status: 0 for MATCH, 1 for anything else, 2 when an input cannot be read.
import { readFileSync } from "node:fs";

function fail(message) {
  console.error(`compare-code.mjs: ${message}`);
  process.exit(2);
}

function hexOf(text, what) {
  const hex = String(text).trim().toLowerCase().replace(/^0x/, "");
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) fail(`${what} is not hex bytes`);
  return hex;
}

const [artifactPath, onChainPath, flag] = process.argv.slice(2);
if (!artifactPath || !onChainPath)
  fail("usage: compare-code.mjs <artifact.json> <on-chain code file> [--immutables]");

let artifact;
try {
  artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
} catch (error) {
  fail(`cannot read ${artifactPath}: ${error instanceof Error ? error.message : String(error)}`);
}
const deployed = artifact?.deployedBytecode;
if (typeof deployed?.object !== "string") fail(`${artifactPath} has no deployedBytecode.object`);
// An unlinked library leaves a placeholder that is not hex; none of our contracts uses one.
const built = hexOf(deployed.object, "the built runtime bytecode");

let onChain;
try {
  onChain = hexOf(readFileSync(onChainPath, "utf8"), "the on-chain code");
} catch (error) {
  fail(`cannot read ${onChainPath}: ${error instanceof Error ? error.message : String(error)}`);
}

const ranges = [];
for (const list of Object.values(deployed.immutableReferences ?? {})) {
  for (const range of list) {
    if (
      !Number.isSafeInteger(range?.start) ||
      !Number.isSafeInteger(range?.length) ||
      range.start < 0 ||
      range.length <= 0
    ) {
      fail(`${artifactPath} lists an immutable range that is not a start and a length`);
    }
    ranges.push({ start: range.start, length: range.length });
  }
}
ranges.sort((a, b) => a.start - b.start);
const builtBytes = built.length / 2;
const onChainBytes = onChain.length / 2;
const blankedBytes = ranges.reduce((sum, r) => sum + r.length, 0);

function blank(hex) {
  let out = hex;
  for (const { start, length } of ranges) {
    if ((start + length) * 2 > out.length) return null;
    out = out.slice(0, start * 2) + "0".repeat(length * 2) + out.slice((start + length) * 2);
  }
  return out;
}

function report(status, note) {
  console.log([status, builtBytes, onChainBytes, ranges.length, blankedBytes, note].join("\t"));
}

if (onChainBytes === 0) {
  report("NO_CODE", "there is no code at the address");
  process.exit(1);
}
if (builtBytes === 0) {
  report("DIFFERENT", "the artifact holds no runtime bytecode");
  process.exit(1);
}
if (builtBytes !== onChainBytes) {
  report("DIFFERENT", `lengths differ: built ${builtBytes} bytes, on chain ${onChainBytes} bytes`);
  process.exit(1);
}
const a = blank(built);
const b = blank(onChain);
if (a === null || b === null) {
  report("DIFFERENT", "an immutable range lies beyond the end of the code");
  process.exit(1);
}
if (a !== b) {
  let at = 0;
  while (at < a.length && a[at] === b[at]) at++;
  report("DIFFERENT", `first differing byte at offset ${Math.floor(at / 2)}, outside every immutable range`);
  process.exit(1);
}
// The built code must hold zeros where an immutable goes: otherwise the ranges are not what they claim.
const builtHoldsZeros = ranges.every(({ start, length }) =>
  /^0*$/.test(built.slice(start * 2, (start + length) * 2)),
);
report(
  "MATCH",
  builtHoldsZeros
    ? "equal outside the immutable ranges"
    : "equal outside the immutable ranges (the built code is not zero inside one of them)",
);
if (flag === "--immutables") {
  for (const { start, length } of ranges) {
    console.log(`  offset ${start}\t0x${onChain.slice(start * 2, (start + length) * 2)}`);
  }
}
process.exit(0);
