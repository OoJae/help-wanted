#!/usr/bin/env python3
"""Builds and checks the work-record fixtures in this folder.

The fixtures are real IdentityMD work records. Each one is stored as hexadecimal text of the bytes
the API served (`records/<job8>-<kind>-<hash8>.hex`, a `0x` prefix and no newline), and `index.json`
says where each came from and what a correct reader must find in it. Hex is used so that this
folder carries data and no third-party prose; nothing is lost, and `decode` gives the JSON back.
The hash the WorkRegistry holds can be read straight off a file: `cast keccak $(cat records/<name>.hex)`.

    python3 build_fixtures.py check
        Offline. Decodes every fixture, hashes it, re-derives every value in index.json that can be
        derived from the bytes, and compares. This is the command to run to trust the index.

    python3 build_fixtures.py decode records/<name>.hex [out.json]
        Writes the record's bytes exactly as they were served (to stdout when no file is given).

    python3 build_fixtures.py build <fetch_dir> [--no-chain] [--add <jobId>:<hash>:<note> ...]
        Rebuilds the fixtures and index.json from fetched files. Needs `cast` and network access for
        WorkRegistry.latest unless --no-chain reuses the values already in index.json. <fetch_dir>
        holds what these public GET requests returned, saved under these names:
          wr-<jobId>-<hash>.bin    https://api.imd.fun/work-records/<hash>.json   (the record)
          records-<jobId>.json     https://api.imd.fun/jobs/<jobId>/records       (its receipts)
          candidates*.json         a list of the jobs from https://api.imd.fun/jobs?limit=500&before=<time>
                                   (fields id, template, state, launchKind, createdAt)
        Every record found there is listed under "observed"; the ones already in index.json, and
        the ones named with --add, are stored as fixtures.

The expected values come from the small scanner in this file, which shares nothing with the
Solidity code and is itself compared, member by member, with Python's own JSON parser.
"""
import datetime
import glob
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(HERE, "index.json")
REGISTRY = "0xb6d0a187b050fa5bb0b87033a203f37becf4a775"
RPCS = [
    "https://ethereum-rpc.publicnode.com",
    "https://eth.drpc.org",
    "https://1rpc.io/eth",
    "https://rpc.mevblocker.io",
]
SCHEMA = "identitymd-work-v1"
MAX_AGENTS = 16

# ---------------------------------------------------------------- keccak256 (pure Python)
RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000, 0x000000000000808B,
    0x0000000080000001, 0x8000000080008081, 0x8000000000008009, 0x000000000000008A, 0x0000000000000088,
    0x0000000080008009, 0x000000008000000A, 0x000000008000808B, 0x800000000000008B, 0x8000000000008089,
    0x8000000000008003, 0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]
M = (1 << 64) - 1


def _rol(x, n):
    return ((x << n) | (x >> (64 - n))) & M if n else x


def _f(a):
    for rc in RC:
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        a = [[a[x][y] ^ d[x] for y in range(5)] for x in range(5)]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rol(a[x][y], ROT[x][y])
        a = [[b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
        a[0][0] ^= rc
    return a


def keccak256(data: bytes) -> bytes:
    rate = 136
    p = bytearray(data)
    p.append(0x01)
    while len(p) % rate:
        p.append(0)
    p[-1] |= 0x80
    a = [[0] * 5 for _ in range(5)]
    for off in range(0, len(p), rate):
        for i in range(rate // 8):
            a[i % 5][i // 5] ^= int.from_bytes(p[off + 8 * i: off + 8 * i + 8], "little")
        a = _f(a)
    return b"".join(a[i % 5][i // 5].to_bytes(8, "little") for i in range(4))


assert keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"


def hx(x: bytes) -> str:
    return "0x" + x.hex()


# ---------------------------------------------------------------- reference scanner
def skip_string(b, i):
    """i is at the opening quote; returns the index just past the closing quote."""
    i += 1
    while True:
        c = b[i]
        if c == 0x5C:
            i += 2
        elif c == 0x22:
            return i + 1
        else:
            i += 1


def skip_value(b, i):
    c = b[i]
    if c == 0x22:
        return skip_string(b, i)
    if c in b"{[":
        depth = 0
        while True:
            c = b[i]
            if c == 0x22:
                i = skip_string(b, i)
                continue
            if c in b"{[":
                depth += 1
            elif c in b"}]":
                depth -= 1
                if depth == 0:
                    return i + 1
            i += 1
    while b[i] not in b",}":
        i += 1
    return i


def top_level(b):
    """Ordered list of (key, valueStart, valueEnd) for the top-level object."""
    assert b[0] == 0x7B
    out = []
    i = 1
    prev = None
    while True:
        assert b[i] == 0x22, i
        j = i + 1
        while b[j] != 0x22:
            assert b[j] != 0x5C
            j += 1
        key = bytes(b[i + 1: j])
        assert prev is None or key > prev, (prev, key)
        prev = key
        assert b[j + 1] == 0x3A
        v = j + 2
        e = skip_value(b, v)
        out.append((key.decode(), v, e))
        if b[e] == 0x7D:
            assert e == len(b) - 1
            return out
        assert b[e] == 0x2C
        i = e + 1


def agent_ids(signals):
    """The ids a correct reader reports: each agent once, in order of first appearance, at most
    sixteen, leaving out every signal that records a rejected submission (value 0)."""
    out = []
    for sig in signals:
        assert list(sig.keys())[0] == "agentId" and list(sig.keys())[-1] == "value", sig.keys()
        assert sig["value"] in (0, 1), sig["value"]
        agent = int(sig["agentId"])
        if sig["value"] != 0 and agent not in out:
            out.append(agent)
            if len(out) == MAX_AGENTS:
                break
    return out


def derive(b: bytes):
    """Everything index.json states about a record that follows from its bytes alone."""
    members = top_level(b)
    doc = json.loads(b)
    assert [k for k, _, _ in members] == list(doc.keys())
    for k, v, e in members:  # the spans found here agree with Python's own parser
        assert json.loads(b[v:e]) == doc[k], k
    span = {k: (v, e) for k, v, e in members}
    # The served bytes are the canonical form: sorted keys, no whitespace, UTF-8 left raw.
    assert json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode() == b

    def raw(k):
        v, e = span[k]
        assert b[v] == 0x22 and b[e - 1] == 0x22
        return b[v + 1: e - 1], v + 1

    kind_raw, _ = raw("kind")
    state_raw, _ = raw("state")
    obj_raw, obj_start = raw("objective")
    assert doc["schema"] == SCHEMA
    jid = doc["jobId"]
    assert re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", jid)
    rejected = sum(1 for s in doc["signals"] if s["value"] == 0)
    return {
        "jobId": jid,
        "jobIdBytes16": "0x" + jid.replace("-", ""),
        "recordHash": hx(keccak256(b)),
        "size": len(b),
        "kind": doc["kind"],
        "kindHash": hx(keccak256(kind_raw)),
        "state": doc["state"],
        "stateHash": hx(keccak256(state_raw)),
        "previousHash": "0x" + doc["previousHash"],
        "parentJobId": doc["parentJobId"],
        "objectiveStart": obj_start,
        "objectiveRawLen": len(obj_raw),
        "objectiveHash": hx(keccak256(obj_raw)),
        "objectiveBackslashes": obj_raw.count(b"\\"),
        "scanStopsAt": span["state"][1],
        "signalsCount": len(doc["signals"]),
        "rejectedSignals": rejected,
        "agentIds": agent_ids(doc["signals"]),
        "trailingNewlineServed": b.endswith(b"\n"),
    }


def read_hex(path: str) -> bytes:
    text = open(path, "r", encoding="ascii").read()
    assert text.startswith("0x") and not text.endswith("\n"), path
    return bytes.fromhex(text[2:])


def write_hex(path: str, data: bytes):
    with open(path, "w", encoding="ascii") as f:
        f.write("0x" + data.hex())


def fixture_name(jid: str, kind: str, h: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", kind.lower()).strip("-")
    return f"records/{jid[:8]}-{slug}-{h[:8]}.hex"


# ---------------------------------------------------------------- check
def check():
    index = json.load(open(INDEX))
    fixtures = index["fixtures"]
    assert index["count"] == len(fixtures)
    on_disk = sorted(os.path.relpath(p, HERE) for p in glob.glob(os.path.join(HERE, "records", "*")))
    assert on_disk == sorted(f["file"] for f in fixtures), "records/ and index.json list different files"
    kinds = set()
    for f in fixtures:
        b = read_hex(os.path.join(HERE, f["file"]))
        got = derive(b)
        for key, value in got.items():
            assert f[key] == value, (f["file"], key, f[key], value)
        assert f["file"] == fixture_name(f["jobId"], f["kind"], f["recordHash"][2:]), f["file"]
        assert f["source"].endswith(f["recordHash"][2:] + ".json")
        assert f["isLatest"] == (f["onChainLatest"] == f["recordHash"])
        kinds.add(f["kind"])
    observed = index["observed"]
    assert index["observedCount"] == len(observed)
    stored = {o["storedAs"] for o in observed if o["storedAs"]}
    assert stored == {f["file"] for f in fixtures}
    all_kinds = {o["kind"] for o in observed}
    print(f"{len(fixtures)} fixtures agree with index.json; {len(kinds)} of the {len(all_kinds)} kinds observed are stored")
    missing = sorted(all_kinds - kinds)
    if missing:
        print("kinds observed but not stored:", ", ".join(missing))


# ---------------------------------------------------------------- build
def cast_latest(job16: str):
    for rpc in RPCS:
        try:
            r = subprocess.run(
                ["cast", "call", REGISTRY, "latest(bytes16)(bytes32)", job16, "--rpc-url", rpc, "--rpc-timeout", "20"],
                capture_output=True, text=True, timeout=40,
            )
            out = r.stdout.strip()
            if r.returncode == 0 and re.fullmatch(r"0x[0-9a-f]{64}", out):
                return out, rpc
        except subprocess.TimeoutExpired:
            pass
    return None, None


def no_receipt(fetch_dir, meta):
    """Jobs whose /records listing had nothing with status "sent" when it was fetched."""
    out = []
    for f in sorted(glob.glob(os.path.join(fetch_dir, "records-*.json"))):
        mm = re.fullmatch(r"records-([0-9a-f-]{36})\.json", os.path.basename(f))
        if not mm:
            continue
        jid = mm.group(1)
        d = json.load(open(f))
        recs = d.get("records", [])
        if any(r["status"] == "sent" for r in recs):
            continue
        m = meta.get(jid, {})
        out.append({
            "jobId": jid, "template": m.get("template"), "launchKind": m.get("launchKind"),
            "jobStateInApi": m.get("state"), "jobCreatedAt": m.get("createdAt"),
            "records": [{"status": r["status"], "hash": "0x" + r["hash"]} for r in recs],
            "oracleBatches": len(d.get("oracleBatches", [])),
        })
    return sorted(out, key=lambda o: (o["template"] or "", o["jobCreatedAt"] or ""))


def build(argv):
    fetch_dir = argv[0]
    no_chain = "--no-chain" in argv
    prior_index = json.load(open(INDEX)) if os.path.exists(INDEX) else {"fixtures": []}
    prior = {(e["jobId"], e["recordHash"]): e for e in prior_index["fixtures"]}
    # What to store, in order: everything already stored, then what --add names.
    chosen = {(e["jobId"], e["recordHash"][2:]): e.get("note", "") for e in prior_index["fixtures"]}
    prior_roles = {e["file"]: e.get("role", "") for e in prior_index["fixtures"]}
    for i, a in enumerate(argv):
        if a == "--add":
            jid, h, note = argv[i + 1].split(":", 2)
            chosen[(jid, h.removeprefix("0x"))] = note
    order = {k: i for i, k in enumerate(chosen)}

    meta = {}
    for f in sorted(glob.glob(os.path.join(fetch_dir, "candidates*.json"))):
        for c in json.load(open(f)):
            meta[c["id"]] = c
    for e in prior_index["fixtures"]:  # what earlier listings said, for jobs no longer listed
        meta.setdefault(e["jobId"], {
            "template": e["template"], "state": e["jobStateInApi"], "launchKind": e["launchKind"],
            "createdAt": e["jobCreatedAt"],
        })

    files = []
    for f in glob.glob(os.path.join(fetch_dir, "wr-*-*.bin")):
        mm = re.fullmatch(r"wr-([0-9a-f-]{36})-([0-9a-f]{64})\.bin", os.path.basename(f))
        if mm:
            files.append((mm.group(1), mm.group(2)))
    files.sort(key=lambda k: (order.get(k, 10**6), k))
    missing = set(chosen) - set(files)
    assert not missing, f"not in {fetch_dir}: {sorted(missing)}"

    os.makedirs(os.path.join(HERE, "records"), exist_ok=True)
    for old in glob.glob(os.path.join(HERE, "records", "*")):
        os.remove(old)

    latest_cache = {}
    entries = []
    observed = []
    for jid, h in files:
        b = open(os.path.join(fetch_dir, f"wr-{jid}-{h}.bin"), "rb").read()
        got = derive(b)
        assert got["recordHash"] == "0x" + h and got["jobId"] == jid, (jid, h)
        recs = json.load(open(os.path.join(fetch_dir, f"records-{jid}.json")))["records"]
        rec = [r for r in recs if r["hash"] == h][0]
        key = (jid, got["recordHash"])
        if no_chain and key in prior:
            latest, rpc = prior[key]["onChainLatest"], prior[key].get("onChainReadVia")
        else:
            if jid not in latest_cache:
                latest_cache[jid] = cast_latest(got["jobIdBytes16"])
            latest, rpc = latest_cache[jid]
        assert latest is not None, f"no RPC answered for {jid}"

        m = meta.get(jid, {})
        is_fixture = (jid, h) in chosen
        name = fixture_name(jid, got["kind"], h)
        observed.append({
            "jobId": jid, "recordHash": got["recordHash"], "onChainLatest": latest,
            "isLatest": latest == got["recordHash"], "kind": got["kind"], "template": m.get("template"),
            "launchKind": m.get("launchKind"), "state": got["state"], "size": got["size"],
            "scanStopsAt": got["scanStopsAt"], "signalsCount": got["signalsCount"],
            "rejectedSignals": got["rejectedSignals"], "distinctAgents": len(got["agentIds"]),
            "previousHash": got["previousHash"], "receiptsListedForJob": len(recs),
            "jobCreatedAt": m.get("createdAt"), "storedAs": name if is_fixture else None,
        })
        if not is_fixture:
            print("observed only:", jid[:8], got["size"], got["kind"], got["state"])
            continue
        write_hex(os.path.join(HERE, name), b)
        entries.append({
            "file": name,
            "jobId": jid,
            "jobIdBytes16": got["jobIdBytes16"],
            "recordHash": got["recordHash"],
            "onChainLatest": latest,
            "isLatest": latest == got["recordHash"],
            "onChainReadVia": rpc,
            "size": got["size"],
            "kind": got["kind"],
            "kindHash": got["kindHash"],
            "template": m.get("template"),
            "launchKind": m.get("launchKind"),
            "state": got["state"],
            "stateHash": got["stateHash"],
            "jobStateInApi": m.get("state"),
            "jobCreatedAt": m.get("createdAt"),
            "previousHash": got["previousHash"],
            "parentJobId": got["parentJobId"],
            "objectiveStart": got["objectiveStart"],
            "objectiveRawLen": got["objectiveRawLen"],
            "objectiveHash": got["objectiveHash"],
            "objectiveBackslashes": got["objectiveBackslashes"],
            "scanStopsAt": got["scanStopsAt"],
            "signalsCount": got["signalsCount"],
            "rejectedSignals": got["rejectedSignals"],
            "agentIds": got["agentIds"],
            "receiptStatus": rec["status"],
            "receiptTx": rec.get("txHash"),
            "receiptsListedForJob": len(recs),
            "source": f"https://api.imd.fun/work-records/{h}.json",
            "foundVia": f"https://api.imd.fun/jobs/{jid}/records",
            "trailingNewlineServed": got["trailingNewlineServed"],
            "note": chosen[(jid, h)],
            # Why this record is stored; written by hand and carried over from the index as it was.
            "role": prior_roles.get(name, ""),
        })
        print(name, got["size"], got["kind"], got["state"],
              "latest" if latest == got["recordHash"] else "SUPERSEDED", got["agentIds"])

    index = {
        "about": "Real IdentityMD work records, byte for byte as served by "
                 "https://api.imd.fun/work-records/<hash>.json (HTTP GET; none of them ends with a newline). Each is "
                 "stored as hexadecimal text of those bytes (0x prefix, no newline), so that this folder holds data "
                 "and no third-party prose: `python3 build_fixtures.py decode <file>` gives the JSON back, and "
                 "`python3 build_fixtures.py check` re-derives this index from the files. recordHash is keccak256 of "
                 "the decoded bytes (`cast keccak $(cat <file>)` prints it); onChainLatest is "
                 "WorkRegistry.latest(jobId) read with `cast call` when the "
                 "fixture was built. Expected values (hashes, offsets, agent ids) were derived by build_fixtures.py, "
                 "outside the Solidity code, with a separate scanner cross-checked against Python's JSON parser. "
                 "agentIds leaves out the agents whose only signals record a rejected submission (value 0); "
                 "rejectedSignals counts those signals.",
        # Which records are stored and why; written by hand and carried over.
        "selection": prior_index.get("selection", ""),
        "encoding": "hex",
        "registry": REGISTRY,
        "fetchedOn": prior_index.get("fetchedOn", "2026-10-10"),
        "onChainReadOn": prior_index.get("onChainReadOn", prior_index.get("fetchedOn"))
        if no_chain else datetime.date.today().isoformat(),
        "jobListings": prior_index.get("jobListings", []),
        "count": len(entries),
        "fixtures": entries,
        "observedCount": len(observed),
        "observed": sorted(observed, key=lambda o: (o["kind"], o["size"])),
        "jobsWithoutAReceipt": no_receipt(fetch_dir, meta),
    }
    with open(INDEX, "w") as f:
        json.dump(index, f, indent=2)
        f.write("\n")
    print("wrote", INDEX, len(entries))


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "check":
        check()
    elif len(sys.argv) >= 3 and sys.argv[1] == "decode":
        data = read_hex(sys.argv[2])
        if len(sys.argv) >= 4:
            with open(sys.argv[3], "wb") as f:
                f.write(data)
        else:
            sys.stdout.buffer.write(data)
    elif len(sys.argv) >= 3 and sys.argv[1] == "build":
        build(sys.argv[2:])
        check()
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
