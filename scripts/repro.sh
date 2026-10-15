#!/usr/bin/env bash
# Rebuilds every launched contract of HELP WANTED from the source in this repository and compares
# the result with the code at its address.
#
# For each contract the deployments book (packages/shared/src/deployments.ts) holds an address for:
#   1. its Foundry project is built with the compiler settings in that project's foundry.toml,
#      into a temporary folder, so nothing in the repository is written;
#   2. the runtime bytecode and the list of immutable ranges are taken from the build output
#      (deployedBytecode.object and deployedBytecode.immutableReferences of the artifact);
#   3. the code at the address is fetched with `cast code`;
#   4. the immutable ranges are set to zero in both, and the two are compared byte for byte.
#
# An immutable is a constructor argument the compiler writes into the runtime code at deployment.
# Those bytes differ between a build and a deployment by design, so they are left out of the
# comparison and nothing else is. What they hold on chain can be printed (see below) and held
# against the launch manifest in each project's docs/LAUNCH.md.
#
# One line is printed per contract. The exit status is 0 only when every contract matches; 1 when
# one differs or has no code; 2 when something could not be built or read, the deployments book
# included: a book that gives no launched contract is an error, not a pass.
#
# It needs Foundry (forge, cast), Node 18 or newer (no packages: nothing to install) and an
# Ethereum mainnet RPC. It sends no transaction and reads no key.
#
# Usage, from the repository root:
#   bash scripts/repro.sh                      # or: pnpm repro
#   RPC_URL=https://your.node bash scripts/repro.sh
#
# Settings (environment):
#   RPC_URL          the node to read the code from. Default https://ethereum-rpc.publicnode.com
#   REPRO_IMMUTABLES 1 to print, under each contract, every immutable word found on chain
#   REPRO_FULL       1 to build the tests and scripts of each project too (slower; the contracts'
#                    bytecode is the same either way)
#   REPRO_KEEP       1 to keep the temporary build folder and print where it is
set -euo pipefail

# `pwd -P` gives the folder with every symbolic link resolved (on macOS, /tmp is one), which is
# the path Node sees for the scripts it runs.
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
RPC_URL="${RPC_URL:-https://ethereum-rpc.publicnode.com}"

for tool in forge cast node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "repro: $tool is not installed" >&2; exit 2; }
done

CONTRACTS="$(node "$ROOT/scripts/lib/book.mjs" contracts)" || exit 2
BOOK_CHAIN="$(node "$ROOT/scripts/lib/book.mjs" chain-id)" || exit 2
# Three launches are recorded in the book, so an empty answer means it was not read as it should be.
if [ -z "$CONTRACTS" ]; then
  echo "repro: the deployments book gave no launched contract, so nothing was compared." >&2
  exit 2
fi
if [ -z "$BOOK_CHAIN" ]; then
  echo "repro: the deployments book gave no chain id, so nothing was compared." >&2
  exit 2
fi

NODE_CHAIN="$(cast chain-id --rpc-url "$RPC_URL")" || { echo "repro: the RPC did not answer" >&2; exit 2; }
if [ "$NODE_CHAIN" != "$BOOK_CHAIN" ]; then
  echo "repro: the RPC is chain $NODE_CHAIN, the book is for chain $BOOK_CHAIN" >&2
  exit 2
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/help-wanted-repro.XXXXXX")"
cleanup() {
  if [ "${REPRO_KEEP:-0}" = "1" ]; then echo "build output kept in $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

echo "repro: chain $NODE_CHAIN, $(forge --version | head -n 1)"

# Build each project that has a launched contract, once.
PROJECTS="$(printf '%s\n' "$CONTRACTS" | awk '{print $2}' | sort -u)"
for project in $PROJECTS; do
  name="$(basename "$project")"
  mkdir -p "$WORK/$name"
  echo "repro: building $project (a clean build; via_ir makes it take a few minutes)"
  if [ "${REPRO_FULL:-0}" = "1" ]; then SKIP=(); else SKIP=(--skip test --skip script); fi
  if ! (cd "$ROOT/$project" && forge build ${SKIP[@]+"${SKIP[@]}"} \
        --out "$WORK/$name/out" --cache-path "$WORK/$name/cache" >"$WORK/$name/build.log" 2>&1); then
    echo "repro: forge build failed for $project. The end of its output:" >&2
    tail -n 30 "$WORK/$name/build.log" >&2
    exit 2
  fi
done

STATUS=0
MATCHED=0
TOTAL=0
while read -r launch project contract address block; do
  [ -n "$launch" ] || continue
  TOTAL=$((TOTAL + 1))
  name="$(basename "$project")"
  label="$(printf 'launch %s  %-11s %s' "$(printf '%s' "$launch" | tr '[:lower:]' '[:upper:]')" "$contract" "$address")"
  artifact="$WORK/$name/out/$contract.sol/$contract.json"
  if [ ! -f "$artifact" ]; then
    echo "UNREAD     $label  the build wrote no artifact at out/$contract.sol/$contract.json"
    STATUS=2
    continue
  fi
  if ! cast code "$address" --rpc-url "$RPC_URL" >"$WORK/$name/$contract.onchain.hex" 2>"$WORK/$name/$contract.err"; then
    echo "UNREAD     $label  cast code failed: $(head -n 1 "$WORK/$name/$contract.err")"
    STATUS=2
    continue
  fi
  FLAG=""
  [ "${REPRO_IMMUTABLES:-0}" = "1" ] && FLAG="--immutables"
  set +e
  RESULT="$(node "$ROOT/scripts/lib/compare-code.mjs" "$artifact" "$WORK/$name/$contract.onchain.hex" $FLAG)"
  CODE=$?
  set -e
  if [ "$CODE" -ge 2 ] || [ -z "$RESULT" ]; then
    echo "UNREAD     $label  the comparison could not be made"
    STATUS=2
    continue
  fi
  IFS=$'\t' read -r verdict built onchain ranges blanked note <<<"$(printf '%s\n' "$RESULT" | head -n 1)"
  codehash="$(cast keccak "$(cat "$WORK/$name/$contract.onchain.hex")")"
  printf '%-10s %s  built %s bytes, on chain %s bytes, %s immutable ranges (%s bytes) set to zero in both: %s. keccak256 of the on-chain code: %s\n' \
    "$verdict" "$label" "$built" "$onchain" "$ranges" "$blanked" "$note" "$codehash"
  if [ "${REPRO_IMMUTABLES:-0}" = "1" ]; then printf '%s\n' "$RESULT" | tail -n +2; fi
  if [ "$verdict" = "MATCH" ]; then MATCHED=$((MATCHED + 1)); elif [ "$STATUS" -lt 1 ]; then STATUS=1; fi
done <<<"$CONTRACTS"

echo "repro: $MATCHED of $TOTAL launched contracts match the code built from this repository."
exit "$STATUS"
