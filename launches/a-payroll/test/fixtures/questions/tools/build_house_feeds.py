"""Write the three house feeds of the Robot Jobs Report as fixture files.

Usage: python3 -I build_house_feeds.py <fixtures dir>/feeds

Everything is derived here from a few constants, with an ABI encoder and keccak written in plain
Python, so the Solidity test that recomputes each feedId checks a second implementation.

Each of the three bodies written here was bought once from the live oracle on 12 and 13 October
2026 and attested. The records are in ../proofs and test/questions/HouseFeedProofs.t.sol checks
them against these files. Payrolls and hires are chain evidence with a pinned recipe. Employers is
judged by the panel's agreement: its first body, a log-rank recipe with a filter, was answered alike
by all five members and then not attested, because the oracle's own rerun does not take a filter
on a ranking (../proofs/employers-first-attempt.oracle.json).
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


def feed(name, title, answer_type, question, definitions, evidence, head, cadence, max_window, contiguous, notes):
    """`evidence` is "chain" (the oracle reruns the pinned recipe before it signs) or "panel" (the
    panel's agreement is the answer). The oracle's question hash covers `evidence` only when it is
    "panel", so a panel question carries it in the hashed prefix and a chain question in the tail."""
    assert evidence in ("chain", "panel")
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
        "definitions": definitions,
        "question": question,
        "v": 1,
        "window": {"fromBlock": 0, "toBlock": 0},
    }
    if evidence == "panel":
        document["evidence"] = "panel"
    if head is not None:
        document["head"] = head
    canonical = qlib.canonical(document)
    marker = '"window":{"fromBlock":'
    q_prefix = canonical[: canonical.index(marker) + len(marker)]
    assert canonical == q_prefix + '0,"toBlock":0}}'
    # What Questions looks for to tell a panel-judged question (it then refuses `submit`).
    assert ('"evidence":"panel"' in q_prefix) == (evidence == "panel")
    tail_fields = []
    if evidence == "chain":
        tail_fields.append(("evidence", "chain"))
    tail_fields += [("panelSize", 7), ("quorum", 5)]
    if evidence == "chain" and answer_type == "uint256":
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


def recipe_definitions(recipe):
    return {"recipe": compact(recipe) + PIN}


COMMON_CONFIRMED = [
    "questionHash rule: rebuilt for 23 attested requests and for 3 bodies read back from Intake Requested events (test/fixtures/questions/requests, intake/requested.json), and for this feed's own proof request (below)",
    "pinning a recipe in definitions.recipe with the sentence '- write recipe exactly this, event text included.': attested requests dbcac6c2 and c5e21f11, and this feed's own proof",
    "a contract building this kind of body on chain and buying it through the Intake with an explicit {fromBlock,toBlock} window: dbcac6c2 (Robinhood Chain, payer and consumer 0x3c81384a...), body bytes in intake/requested.json",
    "panelSize 7, quorum 5, validForSeconds 86400, evidence chain: the values of dbcac6c2, attested with agreed 5; and of this feed's own proof, attested with agreed 5",
    "a filter on the Transfer event's indexed `to` argument, the Ethereum IMD token as the log source, a window of 7,000 Ethereum blocks, and this body's key order (canonical order followed by the tail): this feed's own proof",
]
COMMON_UNCONFIRMED = [
    "a catch-up window longer than the proven 7,000 blocks (the feed asks about up to 21,600 after a missed or failed round)",
    "a real answer delivered to the launched contract by the Intake's callback: the proof was bought from a wallet with no callback, so it was signed for no consumer (the attestation's domain names the zero address) and proves the body, the question hash and the answer, not the delivery",
]


def proof(tx, block, intake_request, body_hash, oracle_request, from_block, to_block, question_hash, answer, record):
    return {
        "what": "one real request with exactly this feed's body, bought from an ordinary wallet through version 1 of the Intake (0x1397434cd35e8a9c8ac312a61d3a285eb31dea56) with no callback, before version 2 was adopted",
        "transaction": tx,
        "block": block,
        "intakeRequestId": intake_request,
        "bodyHash": body_hash,
        "oracleRequestId": oracle_request,
        "fromBlock": from_block,
        "toBlock": to_block,
        "questionHash": question_hash,
        "status": "attested",
        "answer": answer,
        "record": record,
    }


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
    recipe_definitions(
        {"kind": "log-sum", "address": IMD, "event": EVENT, "sumArg": "value", "abs": False, "filter": {"to": PAYEE}}
    ),
    "chain",
    None,
    7000,
    21600,
    True,
    {
        "proof": proof(
            "0xc75123bfb4cd49e0f1c55b236443b2a6d6d93ac981cd3e62f4f931bc2abc9cee",
            26179783,
            "0x4d4174fc45852abb13c02e7baf636eae304507c05220222c3bb368f78544c69c",
            "0xbbf7d6fdf20fe61d71b05bfe3ba358d4d0e97be43c2c43d17f9b0678b0a2873d",
            "3744d864-8cbf-4fcf-8a8c-3529fb1736cb",
            26172770,
            26179769,
            "0xa7eb81dbf5789fdd71e33f54c90cda86ac6cf4070c2320c6d1719e01e3a84dd3",
            "114000000000000000000 (114 IMD), agreed 5 of a panel of 7, attested 2026-10-12T23:50:00Z, 52 seconds after the request was admitted",
            "test/fixtures/questions/proofs/payrolls.oracle.json",
        ),
        "what": "A log-sum of IMD Transfer value where the recipient is the fee payee. Windows tile: each starts at the block after the last answered one, so the prints add up to the total with no gap and no double count. One request a day (7,000 blocks is 23 h 20 min, so a keeper can press at the same clock time every day); after a missed day the next window covers up to three days.",
        "modelledOn": "dbcac6c2-6328-47a9-8e07-4c7b55f78e45: the same sentence and the same recipe with `from` replaced by `to`, the token by Ethereum IMD and the address by the fee payee",
        "confirmed": COMMON_CONFIRMED
        + [
            "log-sum over ERC-20 Transfer `value` with a filter on an indexed argument, abs false, answer uint256, toleranceBps 0: dbcac6c2, c5e21f11 (Robinhood Chain); log-sum on Ethereum mainnet: 383a398f",
            "the body's key set is exactly that of dbcac6c2's on-chain body",
        ],
        "unconfirmed": COMMON_UNCONFIRMED,
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
    recipe_definitions({"kind": "log-count", "address": IMD, "event": EVENT, "filter": {"to": PAYEE}}),
    "chain",
    None,
    7000,
    21600,
    True,
    {
        "proof": proof(
            "0xd7ad398293c0c9138cf7895262f5861465f0ab610861b81426efe6c7e27b16ea",
            26179785,
            "0xb5ca523d0a4395f531e43f3fdd74ead0b5dbf3ac6eb7b53bc0bd576c123b5d35",
            "0xda6f13f65b9329f31f201dc06eed234f4c73bded9a9ebf64a061f4181a2b29a9",
            "df50bf76-41a0-4596-ae9e-9dcfd0e1ccd5",
            26172772,
            26179771,
            "0xdb20f183971eca9bda183646db40164a35cd6cec00acabff45918189f15e6dc5",
            "228, agreed 5 of a panel of 7, attested 2026-10-12T23:50:31Z, 62 seconds after the request was admitted",
            "test/fixtures/questions/proofs/hires.oracle.json",
        ),
        "what": "A log-count of the same transfers: how many IMD Transfer logs name the fee payee as recipient, zero-value transfers included. It is a count of transfers, not of paid actions. Same windows as payrolls when both are requested in the same block.",
        "modelledOn": "recipe: dcc0a889-47e2-4320-972e-6543c96eb98d (log-count with a filter on an indexed argument, Ethereum mainnet) and 54d11aa3 (log-count of Transfer events); sentence: the shape of dbcac6c2",
        "confirmed": COMMON_CONFIRMED
        + [
            "log-count recipe {kind, address, event, filter} with a filter on an indexed argument, answer uint256, toleranceBps 0: dcc0a889 (Ethereum mainnet)",
            "log-count of ERC-20 Transfer events: 54d11aa3 (Robinhood Chain)",
        ],
        "unconfirmed": COMMON_UNCONFIRMED,
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

# The employers feed is judged by the panel's agreement. The oracle offers no recipe that ranks
# senders among the transfers to one recipient only: its log-rank takes no filter (see the first
# attempt in ../proofs). So the method is written out in `definitions` for the panel's members to
# follow, and what the oracle signs is what at least five of the seven agreed on. It does not rerun
# anything itself. The question and both definitions are, byte for byte, those of the request that
# was attested on 13 October 2026.
EMPLOYERS_HEAD = 3
EMPLOYERS_TRANSFER = EVENT[len("event ") :]
feed(
    "employers",
    "Employers of the Week: the three addresses that paid the swarm the most IMD in the last seven days, as a panel of seven agents read it from the chain",
    "address[]",
    "Which three addresses sent the most IMD (token contract " + IMD + ") to " + PAYEE
    + " on Ethereum mainnet in the window? Rank senders by the sum of value over "
    + EMPLOYERS_TRANSFER + " events of that contract whose to argument is " + PAYEE
    + ", grouped by from; answer exactly the top 3 addresses, largest first, ties by ascending address.",
    {
        "method": "Read the " + EMPLOYERS_TRANSFER + " logs emitted by " + IMD
        + " on Ethereum mainnet in the block window, keep those whose to is " + PAYEE
        + ", add up value per from address, order by that total from largest to smallest with ties by ascending address, and answer the first 3 addresses.",
        "source": "Ethereum mainnet event logs only, read from any full node. No website or index.",
    },
    "panel",
    EMPLOYERS_HEAD,
    49000,
    50400,
    False,
    {
        "proof": proof(
            "0x14e7189cd2f65180452995c7a5ed1d12f9101dd8c42c23c63e21a1d86b48ba9d",
            26179860,
            "0x9caa88fda73ff7e9faebd35482e6a788f2aa258ed722b037e97d3d2ba7e938da",
            "0xf0841684ac251fd3f07386cc34d41cccbaef1bd64b8c2353a8c25b641ccce54a",
            "2cbe6bb3-13f9-4617-98b9-5d83754f9e1a",
            26129447,
            26179846,
            "0x3d14a9f53e3eaf1272d67871cff61223fc9b295f26e177c7a193ca5f90d52fc6",
            "[0x21919137e69ed667ac404c7fcb71b8179b645f46, 0x9fadab91f6fa03dbd7f4f8a08a338704baacf63f, 0x7b8c742f2e1eeb3fb2c10d72967fa6d4a22f0479], agreed 5 of a panel of 7, attested 2026-10-13T00:08:45Z, 4 minutes 16 seconds after the request was admitted",
            "test/fixtures/questions/proofs/employers.oracle.json",
        ),
        "firstAttempt": {
            "what": "the body this feed had until 13 October 2026: evidence chain, a pinned log-rank recipe with a filter on `to`, top 5, head 3",
            "transaction": "0x674b5e14572e1e53960802a3a664bac8403bdda0d0e39e6aad23fbaef2d38b0e",
            "oracleRequestId": "c1d0ba09-c732-46e7-b257-2722841215fe",
            "fromBlock": 26129374,
            "toBlock": 26179773,
            "questionHash": "0x6ad2c9985500d1dba60b5e899cbc9f02b801155af0fa7f0bed0a41b12e7d2482",
            "status": "mismatch",
            "failure": "the recipe did not reproduce the panel's answer",
            "why": "the oracle's recipe checker refuses a filter inside a log-rank recipe (the members' own notes say so), so each of the five members that answered recorded the filter under definitions and handed in the recipe without it. All five gave the same filtered ranking. The oracle then reran the agreed recipe, which had no filter, ranked every IMD transfer in the window, and got five other addresses. A ranking among the transfers to one recipient cannot be attested as chain evidence.",
            "feedIdThen": "0xc09b49435a17cb78599285e972df2f6f095b0f49658a8279812f653670633817",
            "record": "test/fixtures/questions/proofs/employers-first-attempt.oracle.json",
        },
        "what": "The three largest senders of IMD to the fee payee over the newest 50,400 blocks (seven days), asked about once a week. Not contiguous: a ranking is of a period, not a running total, and a fresh closing block keeps its hash checkable. The answer is exactly three addresses (`head` 3).",
        "panelJudged": [
            "IdentityMD does not recompute this answer. With evidence panel the oracle signs what the panel agreed on: at least 5 of 7 agents, each holding one seat, gave the same three addresses in the same order. The two daily feeds are different: there the oracle reruns the pinned recipe at the pinned blocks before it signs",
            "the method is pinned in `definitions` (which logs, which filter, how to add up, how to order, how ties fall), and both definitions are part of the hashed question, so an answer to any other wording is refused by the contract. The method tells the members what to do; nothing checks that they did it",
            "`minAgreed` equals the quorum, so the contract refuses any attestation whose `agreed` is below its signed quorum. For a panel-judged question that is the only agreement there is (the oracle's notes: `agreed` is below `quorum` only for chain evidence)",
            "`submit` is closed for this feed (Questions refuses it for a question a panel judges, because two panels can differ and whoever submits would choose). Only the Intake's own callback delivers: a round whose callback is missed, or that the service never serves, fails and backs off",
            "anybody can check an answer afterwards by reading the same logs with the method in `definitions`; the contract cannot",
        ],
        "confirmed": [
            "this exact body (prefix, window and tail, body hash 0xf0841684...e54a) was bought and attested: see proof",
            "the question hash the contract builds for the proof's window is the attested one, with `definitions`, `evidence` and `head` inside the hashed document",
            "panelSize 7, quorum 5, agreed 5; the signed list holds exactly `head` = 3 addresses; a 50,400-block window on Ethereum; the closing block hash",
        ],
        "unconfirmed": [
            "how often seven agents reading 50,400 blocks of logs agree: one request, one attestation. In that request five members answered and all five agreed; had one of them differed the quorum would not have been met",
            "a real answer delivered to the launched contract by the Intake's callback: the proof was bought from a wallet with no callback, so it was signed for no consumer (the attestation's domain names the zero address)",
        ],
        "limits": COMMON_LIMITS
        + [
            "a sender whose transfers to the fee payee were all zero-value is a group with a sum of zero: in a week with fewer than three paying senders it can take a place in the list",
            "in a week with fewer than three senders at all the question has no exact answer; what the panel then agrees on, if anything, is not predictable, and the round may fail",
            "the windows of two rounds overlap or leave a gap when the feed is not asked exactly once every 50,400 blocks: each list is of the round's own fromBlock to toBlock, not of a calendar week",
            "nothing may depend on this feed (build brief, section 11, decision 13): it is the only one of the three that rests on a panel's agreement, and the Jobs Report is complete without it",
        ],
    },
)
