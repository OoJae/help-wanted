"""Builds the golden vectors under packages/shared/vectors with implementations that share no code
with the TypeScript package: Python's json module, hashlib, and a standard-library keccak.

usage: make_vectors.py <shared package dir> [<dir with more record files to add as fixtures>]

    pnpm --filter @help-wanted/shared vectors

`vectors/header-vectors.json` is written here with a hand-rolled ABI encoding and the keccak in
qlib.py. The hire desk keeps a file of its own in the same shape, made with `cast`
(launches/b-desk/test/fixtures/desk/header-vectors.json); the package's tests run both, so the two
files check each other without having to be the same bytes.
"""
import hashlib
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from qlib import khex, canonical, question_document  # noqa: E402

pkg = sys.argv[1]
extra_records = sys.argv[2] if len(sys.argv) > 2 else None
vec = os.path.join(pkg, "vectors")
fix = os.path.join(pkg, "fixtures")


def dump(name, obj):
    with open(os.path.join(vec, name), "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write("\n")


def hexs(b: bytes) -> str:
    return "0x" + b.hex()


# ---------------------------------------------------------------- canonical JSON
# `text` is JSON that is parsed into the value; `canonical` is the exact text expected back. The
# expected strings were written by hand from the rules, then checked against Python's serialiser
# where Python and JSON.stringify agree.
canon_cases = [
    ("empty object", "{}", "{}"),
    ("empty array", "[]", "[]"),
    ("null, booleans", '{"t":true,"f":false,"n":null}', '{"f":false,"n":null,"t":true}'),
    ("keys sort by code unit: capitals first", '{"b":1,"a":2,"B":3,"A":4}', '{"A":4,"B":3,"a":2,"b":1}'),
    ("digits sort before letters, by text not by number", '{"10":1,"9":2,"a":3}', '{"10":1,"9":2,"a":3}'),
    ("nested objects sort at every depth", '{"z":{"y":1,"x":[{"b":1,"a":2}]},"a":0}', '{"a":0,"z":{"x":[{"a":2,"b":1}],"y":1}}'),
    ("array order is kept", "[3,1,2]", "[3,1,2]"),
    ("whitespace is removed", '{ "a" : [ 1 , 2 ] }', '{"a":[1,2]}'),
    ("non-ASCII stays raw", '{"k":"café «» — 日本"}', '{"k":"café «» — 日本"}'),
    ("an astral character stays raw", '{"k":"\U0001F916"}', '{"k":"\U0001F916"}'),
    ("quote and backslash are escaped", '{"k":"say \\"hi\\" \\\\ bye"}', '{"k":"say \\"hi\\" \\\\ bye"}'),
    ("short escapes", '{"k":"a\\nb\\tc\\rd\\be\\ff"}', '{"k":"a\\nb\\tc\\rd\\be\\ff"}'),
    ("other control characters use \\u00xx in lowercase", '{"k":"\\u0001\\u001f"}', '{"k":"\\u0001\\u001f"}'),
    ("slash and DEL are not escaped", '{"k":"a/b\\u007f"}', '{"k":"a/b\u007f"}'),
    ("line separators are not escaped", '{"k":"\\u2028\\u2029"}', '{"k":"  "}'),
    ("an escaped key", '{"a\\"b":1}', '{"a\\"b":1}'),
    ("negative and large integers", '{"a":-5,"b":9007199254740991,"c":0}', '{"a":-5,"b":9007199254740991,"c":0}'),
    ("a work-record style document", '{"schema":"identitymd-work-v1","jobId":"e9efec16-56f3-40d3-9243-52c453effc7d","signals":[{"value":1,"agentId":"52211"}],"parentJobId":null}', '{"jobId":"e9efec16-56f3-40d3-9243-52c453effc7d","parentJobId":null,"schema":"identitymd-work-v1","signals":[{"agentId":"52211","value":1}]}'),
]
canon_out = []
for note, text, expected in canon_cases:
    value = json.loads(text)
    py = canonical(value)
    # Python escapes DEL and the short escapes the same way; it differs only on \b and \f, which it
    # writes as \u0008 and \u000c. Compare where it can be compared.
    if "\\b" not in expected and "\\f" not in expected:
        assert py == expected, (note, py, expected)
    data = expected.encode("utf-8")
    canon_out.append({
        "note": note,
        "json": text,
        "canonical": expected,
        "utf8Hex": hexs(data),
        "sha256": "0x" + hashlib.sha256(data).hexdigest(),
        "keccak256": khex(data),
    })
dump("canonical-vectors.json", {
    "about": "Canonical JSON as IdentityMD's worker writes it (canonicalize in dist/client.js): keys in UTF-16 code unit order, no whitespace, strings as JSON.stringify writes them, raw UTF-8, integers only. 'json' is parsed and must serialise to 'canonical' exactly. Hashes are over 'utf8Hex' and were computed with Python's hashlib and a standard-library keccak, not with this package.",
    "vectors": canon_out,
    "refused": [
        {"note": "a fraction", "js": "1.5"},
        {"note": "not a number", "js": "NaN"},
        {"note": "infinity", "js": "Infinity"},
        {"note": "undefined inside an object", "js": "({ a: undefined })"},
        {"note": "a bigint", "js": "1n"},
        {"note": "a Date", "js": "new Date(0)"},
        {"note": "a Map", "js": "new Map()"},
    ],
})

# ---------------------------------------------------------------- order ticket and header
# ticket = keccak256(abi.encode(uint256 chainId, address desk, uint256 orderId, uint256 claimSeq,
# address runner)): five 32-byte words, each value right-aligned. Encoded here by hand.
def word(n: int) -> bytes:
    return n.to_bytes(32, "big")


header_cases = [
    ("first order, first claim, Ethereum mainnet", 1, "0x5FbDB2315678afecb367f032d93F642f64180aa3", 1, 1, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"),
    ("the same order and runner on a second claim: only claimSeq differs", 1, "0x5FbDB2315678afecb367f032d93F642f64180aa3", 1, 2, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"),
    ("another order, another runner", 1, "0x5FbDB2315678afecb367f032d93F642f64180aa3", 42, 3, "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"),
    ("the same claim numbers on another desk", 1, "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512", 42, 3, "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"),
    ("the same claim numbers on Sepolia", 11155111, "0x5FbDB2315678afecb367f032d93F642f64180aa3", 42, 3, "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"),
    ("values wider than 53 bits: order id 2^64+5, claimSeq 2^32-1", 31337, "0x000000000000000000000000000000000000dEaD", 2**64 + 5, 2**32 - 1, "0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF"),
    ("all-zero edge case (never produced by the desk; ids and claimSeq start at 1)", 1, "0x0000000000000000000000000000000000000001", 0, 0, "0x0000000000000000000000000000000000000000"),
]
PREFIX, SUFFIX = "[help-wanted order ", "] "
header_out = []
for note, chain_id, desk, order_id, claim_seq, runner in header_cases:
    preimage = word(chain_id) + word(int(desk, 16)) + word(order_id) + word(claim_seq) + word(int(runner, 16))
    assert len(preimage) == 160
    ticket = khex(preimage)
    header = PREFIX + ticket[2:] + SUFFIX
    assert len(header) == 85 and header == header.lower().replace("[help-wanted order ", PREFIX)
    header_out.append({
        "note": note,
        "chainId": str(chain_id),
        "desk": desk,
        "orderId": str(order_id),
        "claimSeq": str(claim_seq),
        "runner": runner,
        "preimage": hexs(preimage),
        "ticket": ticket,
        "header": header,
        "headerHex": hexs(header.encode("ascii")),
        "headerHash": khex(header.encode("ascii")),
    })
# A spec may end with one machine-readable clause: `Inputs: key=value; key=value` (pairs separated
# by a semicolon and a space, keys of letters and digits, no semicolon inside a value).
example_spec = (
    "Audit the repository at the pinned commit and report every finding with a severity. "
    "Inputs: repoUrl=https://github.com/example/repo; baseCommit=0123456789abcdef0123456789abcdef01234567"
)
example_objective = header_out[0]["header"] + example_spec
dump("header-vectors.json", {
    "about": "Order header vectors for HELP WANTED's hire desk (WorkOrders). ticket = keccak256(abi.encode(uint256 chainId, address desk, uint256 orderId, uint256 claimSeq, address runner)); header = '[help-wanted order ' + 64 lowercase hex characters of the ticket + '] ' (85 bytes); objective = header + spec. Integers are decimal strings so that no 53-bit limit applies. 'preimage' is the 160 ABI-encoded bytes that are hashed. Produced with a hand-written ABI encoding and a standard-library keccak in Python, independently of this package and of the Solidity library; the hire desk keeps a file in the same shape made with `cast` (launches/b-desk/test/fixtures/desk/header-vectors.json), and the package's tests run both. The example spec ends with the one inputs clause every part of the product reads: 'Inputs: key=value; key=value'.",
    "headerLength": 85,
    "prefix": PREFIX,
    "suffix": SUFFIX,
    "vectors": header_out,
    "objectiveExample": {
        "vector": 0,
        "spec": example_spec,
        "specHash": khex(example_spec.encode("ascii")),
        "objective": example_objective,
        "objectiveHex": hexs(example_objective.encode("ascii")),
        "inputs": {
            "repoUrl": "https://github.com/example/repo",
            "baseCommit": "0123456789abcdef0123456789abcdef01234567",
        },
    },
})

# ---------------------------------------------------------------- spec character rules
A = 0x61
spec_cases = [
    ("one letter", bytes([A]), None),
    ("empty", b"", 0),
    ("a leading space", b" x", 0),
    ("a trailing space", b"x ", 1),
    ("a lone space", b" ", 0),
    ("a double quote", b'say "hi"', 4),
    ("a backslash", b"back\\slash", 4),
    ("a line break", b"line\nbreak", 4),
    ("a tab", b"tab\there", 3),
    ("DEL", b"a\x7fb", 1),
    ("tilde is allowed", b"a~b", None),
    ("two spaces inside are fine", b"two  spaces", None),
    ("every allowed punctuation mark", b"!#$%&'()*+,-./0123456789:;<=>?@[]^_`{|}~", None),
    ("UTF-8 e-acute: its first byte", "café".encode("utf-8"), 3),
    ("NUL", b"a\x00b", 1),
    ("a leading space is reported before a later control byte", b" \x01", 0),
    ("a control byte is reported before a trailing space", b"ab\tc ", 2),
    ("a bad byte in the second 32-byte word", b"a" * 40 + b'"' + b"a" * 5, 40),
    ("a bad byte at the last position of a word", b"a" * 31 + b"\\" + b"a" * 10, 31),
    ("a bad byte in the final partial word", b"a" * 70 + b"\n", 70),
    ("exactly 32 bytes", b"a" * 32, None),
    ("the longest spec", b"a" * 7900, None),
    ("one byte too long", b"a" * 7901, 7900),
    ("too long is reported before a leading space", b" " + b"a" * 7900, 7900),
]
spec_out = []
for note, data, at in spec_cases:
    entry = {"note": note, "bytes": len(data), "firstBad": at}
    if len(data) > 200 and len(set(data)) == 1:
        entry["repeatByteHex"] = hexs(data[:1])
    elif len(data) > 200:
        entry["hex"] = hexs(data)
    else:
        entry["hex"] = hexs(data)
    if at is None:
        entry["specHash"] = khex(data)
    spec_out.append(entry)
dump("spec-vectors.json", {
    "about": "Spec character rules of WorkOrders.createOrder (SpecText.firstBad): 1 to 7,900 bytes, printable ASCII 0x20-0x7E, no double quote (0x22), no backslash (0x5C), no leading or trailing space. 'firstBad' is the index SpecInvalid(at) reports, or null for an acceptable spec: 0 for empty or a leading space, 7900 for too long, else the lowest index of a byte not allowed where it stands (a trailing space reports the last index). A spec is given as 'hex', or as 'repeatByteHex' repeated 'bytes' times. specHash is keccak256 of the spec bytes.",
    "maxBytes": 7900,
    "vectors": spec_out,
})

# ---------------------------------------------------------------- oracle question hash and body
req_dir = os.path.join(fix, "oracle", "requests")
oracle_out = []
for name in sorted(os.listdir(req_dir)):
    doc = json.load(open(os.path.join(req_dir, name), encoding="utf-8"))
    q = question_document(doc)
    text = canonical(q)
    assert khex(text.encode("utf-8")) == doc["questionHash"], name
    marker = '"window":{"fromBlock":'
    cut = text.rindex(marker) + len(marker)
    q_prefix = text[:cut]
    rest = {"panelSize": doc["panelSize"], "quorum": doc["quorum"], "validForSeconds": doc["validForSeconds"]}
    if doc.get("evidence") != "panel":
        rest["evidence"] = "chain"
    # `head` is hashed, so it sits in the prefix with the rest of the question, never in the tail.
    for key in ("toleranceBps", "guards", "consumer"):
        if key in doc:
            rest[key] = doc[key]
    assert "head" not in rest
    tail = "," + canonical(rest)[1:]
    f, t = doc["window"]["fromBlock"], doc["window"]["toBlock"]
    body = f'{q_prefix}{f},"toBlock":{t}}}{tail}'
    parsed = json.loads(body)  # the assembled body is one JSON object
    assert parsed["window"] == {"fromBlock": f, "toBlock": t}
    assert khex(f'{q_prefix}{f},"toBlock":{t}}}}}'.encode("utf-8")) == doc["questionHash"]
    oracle_out.append({
        "id": doc["id"],
        "status": doc["status"],
        "answerType": doc["answerType"],
        "evidence": doc.get("evidence"),
        "hasDefinitions": bool(doc.get("definitions")),
        "head": doc.get("head"),
        "questionDocument": text,
        "questionHash": doc["questionHash"],
        "fromBlock": f,
        "toBlock": t,
        "qPrefix": q_prefix,
        "tail": tail,
        "body": body,
        "bodyBytes": len(body.encode("utf-8")),
    })
# A rule that no fixture exercises is a rule nobody checked: there must be list questions here.
assert sum(1 for v in oracle_out if v["head"] is not None) >= 5, "no list-typed request among the fixtures"
dump("oracle-vectors.json", {
    "about": "Oracle question hashes of real IdentityMD requests (fixtures/oracle/requests/<id>.json, served by GET https://api.imd.fun/oracle/requests/<id>?members=0 on 10 Oct 2026; fixtures/PROVENANCE.json says who fetched each). questionHash is the value the API reports; questionDocument is the canonical JSON whose keccak256 it is: {answerType, chainId, definitions (only when the request has any), evidence (only when it is \"panel\"), head (only when the request has one), question, v: 1, window: {fromBlock, toBlock}}. `head` is hashed, so it is part of qPrefix and never of tail. qPrefix, tail and body show how a Questions feed assembles the same request on chain: body = qPrefix + dec(fromBlock) + ',\"toBlock\":' + dec(toBlock) + '}' + tail, and questionHash = keccak256(qPrefix + dec(fromBlock) + ',\"toBlock\":' + dec(toBlock) + '}}'). Built with Python's json module and a standard-library keccak, not with this package.",
    "windowOpen": '"window":{"fromBlock":',
    "windowMid": ',"toBlock":',
    "vectors": oracle_out,
})

# ---------------------------------------------------------------- work records
def scan_expect(path, head_len):
    raw = open(path, "rb").read()
    doc = json.loads(raw)
    marker = b',"objective":"'
    assert raw.count(marker) >= 1
    # The top-level objective is the member that follows the top-level nodes array; find it by
    # re-serialising everything before it canonically.
    before = {k: v for k, v in doc.items() if k < "objective"}
    prefix = canonical(before)[:-1].encode("utf-8") + marker
    assert raw.startswith(prefix), path
    start = len(prefix)
    obj_raw = json.dumps(doc["objective"], ensure_ascii=False)[1:-1].encode("utf-8")
    assert raw[start:start + len(obj_raw)] == obj_raw, path
    ids = []
    for s in doc["signals"]:
        # A signal whose last member is "value": 0 records a submission that verification rejected:
        # the contract reads it and does not count it. Keys are sorted, so "last" is the largest key.
        if max(s.keys()) == "value" and s["value"] == 0 and len(s) > 1:
            continue
        n = int(s["agentId"])
        if n not in ids:
            ids.append(n)
    return {
        "bytes": len(raw),
        "recordHash": khex(raw),
        "jobId": doc["jobId"],
        "jobIdBytes16": "0x" + doc["jobId"].replace("-", ""),
        "kind": doc["kind"],
        "kindHash": khex(doc["kind"].encode("utf-8")),
        "state": doc["state"],
        "stateHash": khex(doc["state"].encode("utf-8")),
        "schema": doc["schema"],
        "objectiveStart": start,
        "objectiveRawBytes": len(obj_raw),
        "objectiveHash": khex(obj_raw),
        "headLen": head_len,
        "headHash": khex(obj_raw[:head_len]),
        "specHash": khex(obj_raw[head_len:]),
        "agentIds": [str(i) for i in ids[:16]],
        "signalsCount": len(doc["signals"]),
    }

rec_dir = os.path.join(fix, "work-records")
for name in sorted(os.listdir(extra_records)) if extra_records else []:
    if not re.fullmatch(r"[0-9a-f]{8}-.+-[0-9a-f]{8}\.json", name):
        continue
    raw = open(os.path.join(extra_records, name), "rb").read()
    dest = os.path.join(rec_dir, khex(raw)[2:] + ".json")
    if not os.path.exists(dest):
        with open(dest, "wb") as f:
            f.write(raw)
rec_out = []
for name in sorted(os.listdir(rec_dir)):
    path = os.path.join(rec_dir, name)
    exp = scan_expect(path, 85)
    assert exp["recordHash"] == "0x" + name[:-5], name
    exp["file"] = name
    rec_out.append(exp)
dump("work-record-vectors.json", {
    "about": "What WorkProof.scan(record, 85) returns for real IdentityMD work records (fixtures/work-records/<keccak256>.json, byte for byte as served, no trailing newline). objectiveStart is the offset of the first byte of the top-level objective's contents; headHash and specHash are over the first 85 raw bytes of it and over the rest. agentIds are the top-level signals[].agentId, each once, in order of first appearance, at most 16, leaving out the signals of rejected submissions (those whose last member is \"value\": 0). Derived with Python's json module and a standard-library keccak, not with this package.",
    "vectors": rec_out,
})
print("vectors written:", sorted(os.listdir(vec)))
