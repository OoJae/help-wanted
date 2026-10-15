#!/bin/sh
# Reruns the scanner's differential test and rewrites vectors/work-record-scan-vectors.json.
#
#   sh packages/shared/scripts/scan-differential/run.sh
#
# Run it whenever launches/b-desk/src/proof/JsonScan.sol or WorkProof.sol change in code, and
# whenever src/workRecord.ts changes: a test in packages/shared fails until the two have been
# compared again. Each run adds the contract's code, as it then stands, to the versions the scanner
# is known to agree with; changing the scanner or the cases starts that list afresh.
#
# What it does, in a throwaway directory outside the repository (so no launch project's build is
# touched): copies the two contracts and their interface, generates the cases, runs the contract
# over them with Foundry, keeps a sample with the contract's answers as vectors, and then runs the
# TypeScript scanner over every case and over the vectors. Needs node, python3 and forge.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
PKG=$(cd "$HERE/../.." && pwd)
REPO=$(cd "$PKG/../.." && pwd)
DESK="$REPO/launches/b-desk"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/src/proof" "$WORK/src/interfaces" "$WORK/test" "$WORK/data"
cp "$DESK/src/proof/JsonScan.sol" "$DESK/src/proof/WorkProof.sol" "$WORK/src/proof/"
cp "$DESK/src/interfaces/IWorkProof.sol" "$WORK/src/interfaces/"
cp "$HERE/Diff.t.sol" "$WORK/test/"
# The launch settings, plus room to read and write the case files.
cat > "$WORK/foundry.toml" <<TOML
[profile.default]
src = "src"
out = "out"
test = "test"
libs = []
solc = "0.8.26"
evm_version = "cancun"
optimizer = true
optimizer_runs = 200
via_ir = true
bytecode_hash = "none"
cbor_metadata = false
ffi = false
memory_limit = 4294967296
gas_limit = "18446744073709551615"
fs_permissions = [{ access = "read-write", path = "./data" }]
allow_paths = ["$DESK/lib"]
remappings = ["forge-std/=$DESK/lib/forge-std/src/"]
TOML

node "$HERE/gen-cases.mjs" "$WORK/data"
(cd "$WORK" && forge test)
# Every case, not only the sample kept as vectors. A disagreement stops here, before anything is
# written: the vectors record only versions of the contract the scanner agreed with throughout.
(cd "$PKG" && node --import tsx "$HERE/compare.mts" "$WORK/data")
python3 -I "$PKG/scripts/python/make_scan_vectors.py" "$PKG" "$WORK/data" \
  "$WORK/src/proof/JsonScan.sol" "$WORK/src/proof/WorkProof.sol"
(cd "$PKG" && node_modules/.bin/vitest run test/workRecord.test.ts)
