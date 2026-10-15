// Compares the TypeScript record scanner with what the contract answered for the same bytes, over
// every case of a differential run (see run.sh). Exits non-zero when any case disagrees.
//
//   node --import tsx compare.mts <dir with cases.json and sol-results.txt>
import { readFileSync } from "node:fs";
import { encodeAbiParameters, hexToBytes, keccak256, toFunctionSelector, type Hex } from "viem";
import * as shared from "../../src/index.js";

const DATA = process.argv[2];
if (!DATA) throw new Error("usage: compare.mts <data dir>");
const { cases, heads } = JSON.parse(readFileSync(`${DATA}/cases.json`, "utf8")) as {
  cases: string[];
  heads: number[];
};
const sol = readFileSync(`${DATA}/sol-results.txt`, "utf8")
  .split("\n")
  .filter((l) => l.length > 0);
const sel = (sig: string) => toFunctionSelector(sig);
const MAL = sel("Malformed(uint256)"),
  MIS = sel("MissingKey()"),
  WRS = sel("WrongSchema()"),
  HTL = sel("HeadTooLong()");
function tsResult(hex: string, head: number): string {
  try {
    const s = shared.scanWorkRecord(hexToBytes(hex as Hex), head);
    return `ok:${keccak256(
      encodeAbiParameters(
        [
          { type: "bytes16" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "uint256[]" },
        ],
        [s.jobIdBytes16, s.recordHash, s.kindHash, s.headHash, s.specHash, s.stateHash, s.agentIds],
      ),
    )}`;
  } catch (e) {
    if (e instanceof shared.WorkRecordError) {
      if (e.code === "Malformed")
        return `err:${MAL}${BigInt(e.pos ?? -1)
          .toString(16)
          .padStart(64, "0")}`;
      if (e.code === "MissingKey") return `err:${MIS}`;
      if (e.code === "WrongSchema") return `err:${WRS}`;
      if (e.code === "HeadTooLong") return `err:${HTL}`;
      return `err:OTHER:${e.code}`;
    }
    return `throw:${String(e).slice(0, 80)}`;
  }
}
let diff = 0,
  ok = 0;
if (sol.length !== cases.length) throw new Error(`sol ${sol.length} cases ${cases.length}`);
for (let i = 0; i < cases.length; i++) {
  const t = tsResult(cases[i]!, heads[i]!);
  if (t.startsWith("ok")) ok++;
  if (t !== sol[i]) {
    diff++;
    if (diff < 10) {
      const text = Buffer.from(hexToBytes(cases[i] as Hex))
        .toString("latin1")
        .slice(0, 160);
      console.log("MISMATCH", i, "here", t, "contract", sol[i], text);
    }
  }
}
console.log("cases", cases.length, "accepted by both", ok, "mismatches", diff);
if (diff > 0) process.exit(1);
