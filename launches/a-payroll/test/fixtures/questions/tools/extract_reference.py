"""Copy a fenced Solidity block out of the protocol's REFERENCE.md, byte for byte.

Usage: python3 -I extract_reference.py <REFERENCE.md> <section heading text> <out file> [--check]

The section is the `## \\`<name>\\`` heading; the block is the first ```solidity fence after it.
With --check nothing is written: the script exits 1 unless <out file> already equals the block.
"""

import hashlib
import sys

ref_path, section, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
check = "--check" in sys.argv[4:]

raw = open(ref_path, "rb").read()
heading = ("## `" + section + "`\n").encode()
at = raw.index(heading)
assert raw.count(heading) == 1, "heading is not unique"
open_fence = b"\n```solidity\n"
start = raw.index(open_fence, at) + len(open_fence)
end = raw.index(b"\n```\n", start) + 1  # keep the newline that ends the last code line
block = raw[start:end]
assert b"```" not in block

digest = hashlib.sha256(block).hexdigest()
if check:
    have = open(out_path, "rb").read()
    same = have == block
    print(("identical" if same else "DIFFERENT"), len(block), "bytes", "sha256", digest)
    sys.exit(0 if same else 1)
open(out_path, "wb").write(block)
print("wrote", out_path, len(block), "bytes", "sha256", digest)
