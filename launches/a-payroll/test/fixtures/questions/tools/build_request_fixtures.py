"""Place the fetched oracle request documents under test/fixtures/questions and index them.

Usage: python3 -I build_request_fixtures.py <fetch dir> <fixtures dir>

Each request document is copied byte for byte as the API served it
(GET https://api.imd.fun/oracle/requests/<id>?members=0). The index is derived from them.
"""

import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import qlib  # noqa: E402

fetch_dir, out_dir = sys.argv[1], sys.argv[2]
req_out = os.path.join(out_dir, "requests")
os.makedirs(req_out, exist_ok=True)
os.makedirs(os.path.join(out_dir, "intake"), exist_ok=True)


rows = []
for path in sorted(glob.glob(os.path.join(fetch_dir, "requests", "*.json"))):
    raw = open(path, "rb").read()
    d = json.loads(raw)
    assert d["status"] == "attested", d["id"]
    rebuilt = qlib.question_hash(d)
    assert rebuilt == d["questionHash"] == d["attestation"]["questionHash"], d["id"]
    open(os.path.join(req_out, d["id"] + ".json"), "wb").write(raw)
    recipe = ((d.get("agreement") or {}).get("recipe") or {}).get("kind")
    rows.append(
        {
            "id": d["id"],
            "answerType": d["answerType"],
            "chainId": d["chainId"],
            "evidence": d.get("evidence"),
            "recipe": recipe if d.get("evidence") == "chain" else None,
            "hasDefinitions": "definitions" in d,
            "head": d.get("head"),
            "hasGuards": "guards" in d,
            "windowBlocks": d["window"]["toBlock"] - d["window"]["fromBlock"] + 1,
            "attestationDomainVersion": 2 if "agreed" in d["attestation"] else 1,
            "consumer": d.get("consumer"),
            "questionHash": d["questionHash"],
            "createdAt": d["createdAt"],
        }
    )

index = {
    "source": "GET https://api.imd.fun/oracle/requests/<id>?members=0, fetched 2026-10-10; each file is the served bytes",
    "rule": "questionHash = keccak256(canonical JSON of {answerType, chainId, definitions (only when the request has it), evidence (only when \"panel\"), head (only when the request has it), question, v: 1, window: {fromBlock, toBlock}}); canonical = keys sorted, no whitespace, strings as JSON.stringify writes them, raw UTF-8",
    "count": len(rows),
    "ids": [r["id"] for r in rows],
    "requests": rows,
}
open(os.path.join(req_out, "index.json"), "w", encoding="utf-8").write(
    json.dumps(index, indent=2, ensure_ascii=False) + "\n"
)

samples = json.load(open(os.path.join(fetch_dir, "requested_samples.json"), encoding="utf-8"))
requested = {
    "source": "Intake `Requested` events read with eth_getLogs from public RPC nodes on 2026-10-10: the body is the bytes each payer sent on chain",
    "intake": "0x1397434cd35e8a9c8ac312a61d3a285eb31dea56",
    "topic0": "0x1c521a43c9b0f72a335bc80a6918abce08af7949ebbd1c41fe2a576074379063",
    "count": len(samples),
    "requests": samples,
}
open(os.path.join(out_dir, "intake", "requested.json"), "w", encoding="utf-8").write(
    json.dumps(requested, indent=2, ensure_ascii=False) + "\n"
)
print("requests", len(rows), "on-chain bodies", len(samples))
for r in rows:
    print(r["id"][:8], r["answerType"], r["chainId"], r["evidence"], r["recipe"], "head", r["head"], "v", r["attestationDomainVersion"])
