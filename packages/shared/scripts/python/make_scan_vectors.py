"""Writes vectors/work-record-scan-vectors.json: what the contract's own scanner answers.

usage: make_scan_vectors.py <shared package dir> <dir with cases.json and sol-results.txt> [<contract source>...]

The two input files come from a differential run kept outside the repository: `cases.json` holds
record bytes (well-formed records, hand-written edge cases and random mutations of both) with a
head length for each, and `sol-results.txt` holds, line for line, what `WorkProof.scan` in
launches/b-desk/src/proof answered for them in a Foundry test:

    ok:<keccak256(abi.encode(bytes16 jobId, bytes32 recordHash, bytes32 kindHash, bytes32 headHash,
                             bytes32 specHash, bytes32 stateHash, uint256[] agentIds))>
    err:<the revert data: a 4-byte selector, and for Malformed(uint256) the byte offset>

This script only selects: every hand-written case and an evenly spaced sample of the mutations. The
TypeScript scanner had no part in producing the expected values.
"""
import json
import os
import sys

import hashlib
import re

pkg, data = sys.argv[1], sys.argv[2]
# The contract sources the answers came from, so a later change to them can be noticed.
sources = {
    os.path.basename(p): p
    for p in sys.argv[3:]
}


def code_hash(path: str) -> str:
    """SHA-256 of a Solidity source with its comments and all whitespace removed.

    A comment or a reflow does not change what the contract answers, and should not ask for the
    vectors to be made again; any change to the code does. (Neither file holds `//` or `/*` inside
    a string, so removing comments by pattern is safe here.)
    """
    text = open(path, encoding="utf-8").read()
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    text = re.sub(r"//[^\n]*", "", text)
    text = re.sub(r"\s+", "", text)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
doc = json.load(open(os.path.join(data, "cases.json"), encoding="utf-8"))
cases, heads = doc["cases"], doc["heads"]
results = [line for line in open(os.path.join(data, "sol-results.txt"), encoding="utf-8").read().split("\n") if line]
assert len(cases) == len(heads) == len(results), (len(cases), len(heads), len(results))

# The run put 5,200 mutations of small records and then 500 mutations of real ones after the
# hand-written cases.
MUTATED_SMALL, MUTATED_REAL = doc.get("mutatedSmall", 5200), doc.get("mutatedReal", 500)
hand = doc.get("handWritten", len(cases) - MUTATED_SMALL - MUTATED_REAL)
assert hand + MUTATED_SMALL + MUTATED_REAL == len(cases)
picked = list(range(hand))
picked += list(range(hand, hand + MUTATED_SMALL, 13))
picked += list(range(hand + MUTATED_SMALL, len(cases), 125))

vectors = [{"hex": cases[i], "headLen": heads[i], "result": results[i]} for i in picked]

# What was compared: the TypeScript scanner and the cases as they are now, and every version of the
# contract's code that has been run over all the cases against exactly that scanner with no
# disagreement. A test fails when the scanner, or the contract code in the repository, is not one of
# these: the comparison then has to be made again (scripts/scan-differential/run.sh).
path = os.path.join(pkg, "vectors", "work-record-scan-vectors.json")
scanner = hashlib.sha256(open(os.path.join(pkg, "src", "workRecord.ts"), "rb").read()).hexdigest()
cases_hash = hashlib.sha256(open(os.path.join(data, "cases.json"), "rb").read()).hexdigest()
contract = {name: code_hash(p) for name, p in sorted(sources.items())}
earlier = []
if os.path.exists(path):
    was = json.load(open(path, encoding="utf-8")).get("compared", {})
    if was.get("scannerSha256") == scanner and was.get("casesSha256") == cases_hash:
        earlier = [c for c in was.get("contractCode", []) if c != contract]
compared = {
    "rule": "scannerSha256 is the SHA-256 of src/workRecord.ts; casesSha256 of the generated cases.json; each contractCode entry holds, per file of launches/b-desk/src/proof, the SHA-256 of its UTF-8 source after removing /* */ and // comments and all whitespace. Every entry is a version of the contract that was run over all the cases, not only the sample below, and agreed with this scanner on every one.",
    "scannerSha256": scanner,
    "casesSha256": cases_hash,
    "casesCompared": len(cases),
    # The newest last; a dozen is more history than any review needs.
    "contractCode": (earlier + [contract])[-12:],
}
out = {
    "about": "What WorkProof.scan(record, headLen) of launches/b-desk/src/proof answers for record bytes that are well formed, subtly wrong, or mutated at random. 'result' is 'ok:' followed by keccak256(abi.encode(bytes16 jobId, bytes32 recordHash, bytes32 kindHash, bytes32 headHash, bytes32 specHash, bytes32 stateHash, uint256[] agentIds)), or 'err:' followed by the revert data (selectors, as `cast sig` gives them: Malformed(uint256) 0x45ef4133 followed by the byte offset, MissingKey() 0x6daf24f7, WrongSchema() 0x21b8eeb9, HeadTooLong() 0x75c27a79). The expected values were produced by the Solidity contract in a Foundry test over " + f"{len(cases):,}" + " cases on 11 Oct 2026 (JsonScan.sol and WorkProof.sol as they stood that day, with the rule that a signal ending in ,\"value\":0} names no agent); this file keeps every hand-written case and an evenly spaced sample of the mutations. scanWorkRecord in this package must give the same answer for each.",
    "compared": compared,
    "counts": {
        "handWritten": hand,
        "mutatedSample": len(picked) - hand,
        "accepted": sum(1 for v in vectors if v["result"].startswith("ok:")),
        "refused": sum(1 for v in vectors if v["result"].startswith("err:")),
    },
    "vectors": vectors,
}
with open(path, "w", encoding="utf-8") as f:
    json.dump(out, f, indent=1)
    f.write("\n")
print(path, out["counts"], os.path.getsize(path), "bytes")
