"""Write the three house feeds of the Robot Jobs Report as fixture files.

Usage: python3 -I build_house_feeds.py <fixtures dir>/feeds

Everything is derived here from a few constants, with an ABI encoder and keccak written in plain
Python, so the Solidity test that recomputes each feedId checks a second implementation.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import qlib  # noqa: E402

out_dir = sys.argv[1]
os.makedirs(out_dir, exist_ok=True)

IMD = "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7"
PAYEE = "0x4e0fa57bde726079356537e2f34d671e9f41adbc"
ACTION = "0x" + b"oracle.request@oracle-1".ljust(32, b"\0").hex()
EVENT = "event Transfer(address indexed from, address indexed to, uint256 value)"
PIN = " - write recipe exactly this, event text included."
ANSWER_TYPES = ["bool", "address", "bytes32", "uint256", "address[]", "bytes32[]"]
# The mainnet head when the fixtures were built; the example window is the one a first request
# made in this block would ask about.
EXAMPLE_BLOCK = 26164239


def compact(value):
    """The recipe as its author would write it: insertion order kept, no whitespace."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def word(n):
    return int(n).to_bytes(32, "big")


def encode_feed_id(p, q_prefix, tail):
    gate = bytes.fromhex(p["gateData"][2:])
    static = [
        bytes.fromhex(p["action"][2:]),
        word(p["chainId"]),
        word(p["answerType"]),
        word(p["panelSize"]),
        word(p["quorum"]),
        word(p["minAgreed"]),
        word(p["validFor"]),
        word(p["cadenceBlocks"]),
        word(p["maxWindowBlocks"]),
        word(p["lagBlocks"]),
        word(1 if p["contiguous"] else 0),
        word(1 if p["pinHash"] else 0),
        word(p["maxPrice"]),
        word(p["tip"]),
        word(p["gateCmp"]),
        word(int(p["gateTarget"], 16)),
        word(p["gateThreshold"]),
    ]
    assert len(static) == 17
    tuple_enc = b"".join(static) + word(18 * 32) + word(len(gate)) + gate.ljust((len(gate) + 31) // 32 * 32, b"\0")
    enc = word(0x60) + qlib.keccak256(q_prefix) + qlib.keccak256(tail) + tuple_enc
    return "0x" + qlib.keccak256(enc).hex()


def feed(name, title, answer_type, question, recipe, head, cadence, max_window, contiguous, notes):
    params = {
        "action": ACTION,
        "chainId": 1,
        "answerType": ANSWER_TYPES.index(answer_type),
        "panelSize": 7,
        "quorum": 5,
        "minAgreed": 5,
        "validFor": 86400,
        "cadenceBlocks": cadence,
        "maxWindowBlocks": max_window,
        "lagBlocks": 12,
        "contiguous": contiguous,
        "pinHash": True,
        "maxPrice": "2000000000000000000",
        "tip": "50000000000000000",
        "gateCmp": 0,
        "gateTarget": "0x0000000000000000000000000000000000000000",
        "gateThreshold": "0",
        "gateData": "0x",
    }
    document = {
        "answerType": answer_type,
        "chainId": 1,
        "definitions": {"recipe": compact(recipe) + PIN},
        "question": question,
        "v": 1,
        "window": {"fromBlock": 0, "toBlock": 0},
    }
    if head is not None:
        document["head"] = head
    canonical = qlib.canonical(document)
    marker = '"window":{"fromBlock":'
    q_prefix = canonical[: canonical.index(marker) + len(marker)]
    assert canonical == q_prefix + '0,"toBlock":0}}'
    tail_fields = [("evidence", "chain"), ("panelSize", 7), ("quorum", 5)]
    if answer_type == "uint256":
        tail_fields.append(("toleranceBps", 0))
    tail_fields.append(("validForSeconds", 86400))
    tail = "," + compact(dict(tail_fields))[1:]

    to_block = EXAMPLE_BLOCK - params["lagBlocks"]
    span = cadence if contiguous else max_window
    from_block = to_block + 1 - span
    shared = f'{q_prefix}{from_block},"toBlock":{to_block}}}'
    body = shared + tail
    json.loads(body)  # the body must be valid JSON
    hashed = shared + "}"
    assert json.loads(hashed) == {**document, "window": {"fromBlock": from_block, "toBlock": to_block}}
    assert hashed == qlib.canonical(json.loads(hashed))
    assert len(body.encode()) + 16 < 16384
    for key, value in document["definitions"].items():
        assert len(key) <= 64 and len(value) <= 512, (name, len(value))
    assert len(question) <= 2000

    params_for_id = dict(params, maxPrice=int(params["maxPrice"]), tip=int(params["tip"]), gateThreshold=0)
    out = {
        "name": name,
        "title": title,
        "feedId": encode_feed_id(params_for_id, q_prefix.encode(), tail.encode()),
        "feedIdRule": "keccak256(abi.encode(params, keccak256(qPrefix), keccak256(tail)))",
        "params": params,
        "qPrefix": q_prefix,
        "qPrefixHex": "0x" + q_prefix.encode().hex(),
        "tail": tail,
        "tailHex": "0x" + tail.encode().hex(),
        "example": {
            "requestBlock": EXAMPLE_BLOCK,
            "fromBlock": from_block,
            "toBlock": to_block,
            "body": body,
            "bodyHex": "0x" + body.encode().hex(),
            "questionHash": qlib.khex(hashed.encode()),
        },
        "notes": notes,
    }
    path = os.path.join(out_dir, name + ".json")
    open(path, "w", encoding="utf-8").write(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    print(name, out["feedId"], "body bytes", len(body.encode()), "prefix", len(q_prefix), "tail", len(tail))


COMMON_CONFIRMED = [
    "questionHash rule: rebuilt for 23 attested requests and for 3 bodies read back from Intake Requested events (test/fixtures/questions/requests, intake/requested.json)",
    "pinning a recipe in definitions.recipe with the sentence '- write recipe exactly this, event text included.': attested requests dbcac6c2 and c5e21f11",
    "a contract building this kind of body on chain and buying it through the Intake with an explicit {fromBlock,toBlock} window: dbcac6c2 (Robinhood Chain, payer and consumer 0x3c81384a...), body bytes in intake/requested.json",
    "panelSize 7, quorum 5, validForSeconds 86400, evidence chain: the values of dbcac6c2, attested with agreed 5",
]
COMMON_UNCONFIRMED = [
    "this exact body has not been through the protocol's free POST /requests/check and no request with it has been bought; do both from a wallet before funding the meter (a refused body costs 0.5 IMD)",
    "a filter on the Transfer event's indexed `to` argument: attested samples filter on `from` (Transfer) and on `id` (Uniswap v4 Swap)",
    "the Ethereum IMD token as the log source",
    "body key order: this body is in canonical key order followed by the tail; the three bodies read back from the chain are in another order, which JSON parsing should not care about",
]

# What each figure does and does not mean. These are limits of the recipes, not of the contract, and
# they are part of each feed's documentation (build brief, section 11, decision 12). `title` and
# `notes` are not part of a feed's id.
COMMON_LIMITS = [
    "any IMD transfer to the fee payee is included, whatever it was for: the chain does not say which transfers bought an action from the swarm",
    "the feeds' own purchases are included: every request the Questions contract buys from the Intake is itself an IMD Transfer from Questions to the fee payee, so it adds to the sum and to the count, and the Questions address can appear in the ranking",
]

feed(
    "payrolls",
    "Non-Human Payrolls: IMD paid to the swarm's fee payee, per day",
    "uint256",
    "What is the sum of the value argument of every " + EVENT[len("event ") :] + " event emitted by the token contract "
    + IMD + " whose to argument is " + PAYEE + " in the window?",
    {"kind": "log-sum", "address": IMD, "event": EVENT, "sumArg": "value", "abs": False, "filter": {"to": PAYEE}},
    None,
    7000,
    21600,
    True,
    {
        "what": "A log-sum of IMD Transfer value where the recipient is the fee payee. Windows tile: each starts at the block after the last answered one, so the prints add up to the total with no gap and no double count. One request a day (7,000 blocks is 23 h 20 min, so a keeper can press at the same clock time every day); after a missed day the next window covers up to three days.",
        "modelledOn": "dbcac6c2-6328-47a9-8e07-4c7b55f78e45: the same sentence and the same recipe with `from` replaced by `to`, the token by Ethereum IMD and the address by the fee payee",
        "confirmed": COMMON_CONFIRMED
        + [
            "log-sum over ERC-20 Transfer `value` with a filter on an indexed argument, abs false, answer uint256, toleranceBps 0: dbcac6c2, c5e21f11 (Robinhood Chain); log-sum on Ethereum mainnet: 383a398f",
            "the body's key set is exactly that of dbcac6c2's on-chain body",
        ],
        "unconfirmed": COMMON_UNCONFIRMED
        + [
            "window length: the longest attested log-sum windows in the fixtures are 150 blocks on Ethereum and 8,851 on Robinhood Chain; this feed asks about 7,000 to 21,600 Ethereum blocks",
        ],
        "limits": COMMON_LIMITS
        + [
            "a zero-value transfer adds nothing to the sum, so this figure cannot be raised for gas alone",
            "after a failed or a late round one print covers more than a day (up to 21,600 blocks, three days): take each print's period from its own fromBlock and toBlock",
        ],
    },
)

feed(
    "hires",
    "Hires: IMD transfers to the swarm's fee payee, per day (every Transfer log, zero-value ones included)",
    "uint256",
    "How many " + EVENT[len("event ") :] + " events did the token contract " + IMD
    + " emit whose to argument is " + PAYEE + " in the window?",
    {"kind": "log-count", "address": IMD, "event": EVENT, "filter": {"to": PAYEE}},
    None,
    7000,
    21600,
    True,
    {
        "what": "A log-count of the same transfers: how many IMD Transfer logs name the fee payee as recipient, zero-value transfers included. It is a count of transfers, not of paid actions. Same windows as payrolls when both are requested in the same block.",
        "modelledOn": "recipe: dcc0a889-47e2-4320-972e-6543c96eb98d (log-count with a filter on an indexed argument, Ethereum mainnet) and 54d11aa3 (log-count of Transfer events); sentence: the shape of dbcac6c2",
        "confirmed": COMMON_CONFIRMED
        + [
            "log-count recipe {kind, address, event, filter} with a filter on an indexed argument, answer uint256, toleranceBps 0: dcc0a889 (Ethereum mainnet)",
            "log-count of ERC-20 Transfer events: 54d11aa3 (Robinhood Chain)",
        ],
        "unconfirmed": COMMON_UNCONFIRMED
        + [
            "the question sentence is new wording (the attested counts name their block numbers in the sentence, which a standing question cannot)",
            "window length: the attested log-count windows in the fixtures are 299 blocks on Ethereum and 8,851 on Robinhood Chain",
        ],
        "limits": [
            "zero-value transfers are counted (build brief, section 11, decision 12): the recipe counts every Transfer log whose `to` is the fee payee. A log-count filter reaches indexed arguments only (the protocol's documentation: 'optionally filtered by indexed fields'), `value` is not indexed, and no attested recipe shape excludes a transfer by its value. Anyone can therefore raise this count by one, for gas alone, with a zero-value IMD transfer to the fee payee; the payrolls sum does not move when they do",
            "an unofficial tally (the indexer, the web page) must count the same way, every Transfer log to the fee payee with zero-value ones included, or the two numbers will not agree",
        ]
        + COMMON_LIMITS
        + [
            "after a failed or a late round one count covers more than a day (up to 21,600 blocks, three days): take each count's period from its own fromBlock and toBlock",
        ],
    },
)

feed(
    "employers",
    "Employers of the Week: who paid the swarm the most IMD in the last seven days",
    "address[]",
    "Which addresses sent the most IMD (token contract " + IMD + ") to " + PAYEE
    + " on Ethereum mainnet in the window? Rank senders by the sum of value over "
    + EVENT[len("event ") :] + " events of that contract whose to argument is " + PAYEE
    + ", grouped by from; answer the top 5, largest first, ties by ascending address.",
    {
        "kind": "log-rank",
        "address": IMD,
        "event": EVENT,
        "sumArg": "value",
        "abs": False,
        "groupBy": "from",
        "topN": 5,
        "filter": {"to": PAYEE},
    },
    3,
    49000,
    50400,
    False,
    {
        "what": "A log-rank of the same transfers by sender over the newest 50,400 blocks (seven days), asked about once a week. Not contiguous: a ranking is of a period, not a running total, and a fresh closing block keeps its hash checkable. `head` is 3: the first three entries must agree and are what the signed list holds.",
        "modelledOn": "a4d33e90-1c2c-49bd-a4aa-2d8e3f6570f3 (which address sent the most PEPE, ranked by the sum of Transfer value grouped by from, top 5): its sentence, and the recipe its panel agreed on with a filter added",
        "confirmed": [
            COMMON_CONFIRMED[0],
            "log-rank recipe {kind, address, event, sumArg, abs, groupBy: from, topN: 5} over ERC-20 Transfer, answer address[]: a4d33e90 (Ethereum mainnet), 05ce467c (Robinhood Chain)",
            "`head` is part of the hashed question document: all 5 list-typed fixtures (a4d33e90, 05ce467c, 13766f38, 18b11d16, 954eba86)",
            "a log-rank over 7,200 Ethereum blocks: 954eba86",
            "the signed list holds `head` entries, not topN: every list-typed fixture has head 1 and one signed entry beside five computed",
        ],
        "unconfirmed": COMMON_UNCONFIRMED
        + [
            "a `filter` inside a log-rank recipe: no attested sample has one. If the recipe engine refuses it every round fails; the fallback is a feed without the filter clause, which is a different feed id",
            "pinning a log-rank recipe through definitions.recipe: in the attested samples the panel derived the recipe from the sentence",
            "head 3: every attested sample has head 1 (the protocol's documentation shows a ranking with head 3)",
            "no list-typed request attested after the attestation moved to domain version 2 on 30 Sep was found (all five samples are from 21 to 27 Sep), so neither the `head` hash rule nor panelSize/quorum/agreed on a list answer is confirmed since then. A wrong pinned hash would fail every round: buy one canary request with this body before launch and compare its attested questionHash with the one the builder gives for its window; if they differ, set pinHash to false (a different feed id; `submit` is then unavailable)",
            "a 50,400-block window on Ethereum",
        ],
        "limits": COMMON_LIMITS
        + [
            "a sender whose transfers to the fee payee were all zero-value is a group with a sum of zero: in a week with fewer than three paying senders it can take a place in the list (the recipe cannot exclude a transfer by its value; see hires)",
            "the windows of two rounds overlap or leave a gap when the feed is not asked exactly once every 50,400 blocks: each list is of the round's own fromBlock to toBlock, not of a calendar week",
            "nothing may depend on this feed (build brief, section 11, decision 13): its body is the least certain of the three, and the Jobs Report is complete without it",
        ],
    },
)
