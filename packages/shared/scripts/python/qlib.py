"""Helpers for the Standing Questions fixtures: keccak-256 and the oracle's canonical JSON.

Pure standard library so it runs with `python3 -I` and needs nothing installed.
"""

import json

_RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
_ROT = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14],
]
_M = (1 << 64) - 1


def _rol(x, n):
    n %= 64
    return ((x << n) | (x >> (64 - n))) & _M if n else x


def _f(a):
    for rc in _RC:
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        a = [[a[x][y] ^ d[x] for y in range(5)] for x in range(5)]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rol(a[x][y], _ROT[x][y])
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
        blk = p[off:off + rate]
        for i in range(rate // 8):
            a[i % 5][i // 5] ^= int.from_bytes(blk[8 * i:8 * i + 8], "little")
        a = _f(a)
    out = b""
    for i in range(4):
        out += a[i % 5][i // 5].to_bytes(8, "little")
    return out


def khex(data: bytes) -> str:
    return "0x" + keccak256(data).hex()


def canonical(value) -> str:
    """Keys sorted, no whitespace, strings as JSON.stringify writes them, raw UTF-8."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def question_document(doc: dict) -> dict:
    """The document the oracle hashes, built from a request detail document.

    `definitions` only when the request has any, `evidence` only when it is "panel", `head` only
    when the request has one.
    """
    q = {
        "answerType": doc["answerType"],
        "chainId": doc["chainId"],
        "question": doc["question"],
        "v": 1,
        "window": {"fromBlock": doc["window"]["fromBlock"], "toBlock": doc["window"]["toBlock"]},
    }
    if doc.get("definitions"):
        q["definitions"] = doc["definitions"]
    if doc.get("evidence") == "panel":
        q["evidence"] = "panel"
    if doc.get("head") is not None:
        q["head"] = doc["head"]
    return q


def question_hash(doc: dict) -> str:
    return khex(canonical(question_document(doc)).encode("utf-8"))


if __name__ == "__main__":
    assert khex(b"") == "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    assert khex(b"abc") == "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
    assert khex(b"a" * 136) == khex(bytes(b"a" * 136))
    print("keccak self-test ok")
