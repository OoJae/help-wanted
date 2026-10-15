#!/usr/bin/env bash
# Buys one real oracle request per house feed, from an ordinary wallet, through IdentityMD's Intake,
# with no callback. It proves that the live oracle accepts and answers each feed body before launch A,
# because the feed ids cannot change once the contracts are launched.
#
# Each request costs 0.5 IMD and is never refunded. The script shows every body and asks before it
# sends anything. It follows docs/LAUNCH.md section 5 of launches/a-payroll line for line; a test in
# that project checks that the body built this way is byte for byte what Questions will send.
#
# Usage, from the repository root:
#   RPC=<Ethereum mainnet RPC URL> ACCOUNT=<name of a cast keystore> bash scripts/proof-requests.sh
#   RPC=... ACCOUNT=... bash scripts/proof-requests.sh payrolls          # one feed only
#
# The keystore is made once with `cast wallet import <name> --interactive`; this script never sees
# the key and cast asks for the keystore password at each transaction.
set -euo pipefail

: "${RPC:?set RPC to an Ethereum mainnet RPC URL}"
: "${ACCOUNT:?set ACCOUNT to the name of a cast keystore (cast wallet import NAME --interactive)}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# FEEDS_DIR can be set to try a candidate body before it replaces a fixture.
FEEDS_DIR="${FEEDS_DIR:-$ROOT/launches/a-payroll/test/fixtures/questions/feeds}"
OUT_DIR="${OUT_DIR:-$ROOT/evidence/proof-requests}"
mkdir -p "$OUT_DIR"

IMD=0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7
# Version 2 of the Intake. The proofs of 12 and 13 October were bought through version 1
# (0x1397434cd35e8a9c8ac312a61d3a285eb31dea56) before version 2 was adopted.
INTAKE=0xa43e6f75ee006411f79ac1c84120606c2330de82
ACTION=0x6f7261636c652e72657175657374406f7261636c652d31000000000000000000
PRICE=500000000000000000

[ "$(cast chain-id --rpc-url "$RPC")" = "1" ] || { echo "RPC is not Ethereum mainnet"; exit 1; }

if [ "$#" -gt 0 ]; then FEEDS=("$@"); else FEEDS=(payrolls hires employers); fi
NEED=$((PRICE * ${#FEEDS[@]}))

WALLET_ADDR="$(cast wallet address --account "$ACCOUNT")"
BAL="$(cast call $IMD "balanceOf(address)(uint256)" "$WALLET_ADDR" --rpc-url "$RPC" | awk '{print $1}')"
ETH="$(cast balance "$WALLET_ADDR" --ether --rpc-url "$RPC")"
LIVE_PRICE="$(cast call $INTAKE "priceOf(bytes32,address)(uint256)" $ACTION $IMD --rpc-url "$RPC" | awk '{print $1}')"
echo "Wallet $WALLET_ADDR holds $(cast from-wei "$BAL") IMD and $ETH ETH."
echo "The Intake's price is $(cast from-wei "$LIVE_PRICE") IMD per request; this run buys ${#FEEDS[@]}."
[ "$LIVE_PRICE" = "$PRICE" ] || { echo "The live price is not 0.5 IMD. Stop and check before paying."; exit 1; }
[ "$(echo "$BAL >= $NEED" | bc)" = "1" ] || { echo "Not enough IMD for ${#FEEDS[@]} request(s)."; exit 1; }

ALLOW="$(cast call $IMD "allowance(address,address)(uint256)" "$WALLET_ADDR" $INTAKE --rpc-url "$RPC" | awk '{print $1}')"
if [ "$(echo "$ALLOW < $NEED" | bc)" = "1" ]; then
  read -r -p "Approve the Intake to take $(cast from-wei "$NEED") IMD from this wallet? [y/N] " OK
  [ "$OK" = "y" ] || exit 1
  cast send $IMD "approve(address,uint256)" $INTAKE "$NEED" --rpc-url "$RPC" --account "$ACCOUNT"
fi

for FEED in "${FEEDS[@]}"; do
  case "$FEED" in
    payrolls|hires) BLOCKS=7000 ;;
    employers) BLOCKS=50400 ;;
    *) echo "unknown feed $FEED"; exit 1 ;;
  esac
  F="$FEEDS_DIR/$FEED.json"
  HEAD="$(cast block-number --rpc-url "$RPC")"
  TO=$((HEAD - 12)); FROM=$((TO - BLOCKS + 1))
  WINDOW="$FROM,\"toBlock\":$TO}"
  BODY="$(cast concat-hex "$(jq -r .qPrefixHex "$F")" "$(cast from-utf8 "$WINDOW")" "$(jq -r .tailHex "$F")")"
  QHASH="$(cast keccak "$(cast concat-hex "$(jq -r .qPrefixHex "$F")" "$(cast from-utf8 "$WINDOW}")")")"

  echo
  echo "=== $FEED: blocks $FROM to $TO"
  echo "question hash $QHASH"
  cast to-utf8 "$BODY"
  echo
  read -r -p "Pay 0.5 IMD (never refunded) to ask this? [y/N] " OK
  [ "$OK" = "y" ] || { echo "skipped $FEED"; continue; }

  TX="$(cast send $INTAKE "request(bytes32,bytes,(address,bytes4),address,uint256)" \
    $ACTION "$BODY" "(0x0000000000000000000000000000000000000000,0x00000000)" $IMD $PRICE \
    --rpc-url "$RPC" --account "$ACCOUNT" --json | jq -r .transactionHash)"
  echo "sent: $TX"
  jq -n --arg feed "$FEED" --arg tx "$TX" --arg qhash "$QHASH" --argjson from "$FROM" --argjson to "$TO" \
    --arg wallet "$WALLET_ADDR" '{feed:$feed, tx:$tx, questionHash:$qhash, fromBlock:$from, toBlock:$to, wallet:$wallet}' \
    > "$OUT_DIR/$FEED.json"
  echo "saved $OUT_DIR/$FEED.json"
done

echo
echo "Done. An answer usually takes 15 to 60 minutes. Read each result with:"
echo "  curl -s https://api.imd.fun/intake/1/<tx> | jq '.entries[0] | {state, reason, completion}'"
