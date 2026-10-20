#!/usr/bin/env bash
# HELP WANTED's first receipt-backed ERC-8004 reviews: one entry in the ERC-8004 Reputation Registry
# for each IdentityMD agent that did an order on the hire desk (agent 51519, order 1; agent 52142,
# order 2), given by the wallet that paid for its swarm job, H1. Each entry points at a feedback file
# on the site (apps/web/public/erc8004/) whose proofOfPayment names the job's x402 payment and whose
# helpwanted field names the WorkRegistry receipt and the desk's settlement. The site labels them
# HOUSE: the team reviews the work its own runner bought.
#
#   ACCOUNT=<keystore> bash scripts/feedback.sh
#
# ACCOUNT names a cast keystore (`cast wallet import NAME --interactive`) that holds H1
# (0x60CcC928eb8EEE1d64CA0164565BfA9858669560), the client both files name; the script stops if it
# holds any other address. cast asks for its password at each of the two transactions. This script
# never sees a key. Needs cast, jq, curl and od.
#
# For each order it first checks that the site serves the feedback file byte for byte as this
# repository has it, and puts keccak256 of those bytes on chain as feedbackHash, which is what
# ERC-8004 requires for a URI that is not content-addressed. Deploy the site before running it.
#
# It can be run again: an agent this wallet has already reviewed with these tags is skipped.
#
# SITE is the origin written on chain (default: the live site). FETCH_SITE is where the files are
# read for that check (default: SITE). On a local fork (an RPC on 127.0.0.1 or localhost) a signer
# other than the files' client is allowed, for a rehearsal; on any other RPC the script stops.
set -euo pipefail

: "${ACCOUNT:?set ACCOUNT to the name of a cast keystore that holds H1}"
RPC="${RPC:-https://rpc.mevblocker.io}"
SITE="${SITE:-https://web-production-a7c148.up.railway.app}"
FETCH_SITE="${FETCH_SITE:-$SITE}"
REPUTATION=0x8004BAa17C55a88189AE136b182e5fdA19dE9b63
IDENTITY=0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
FILES="$(cd "$(dirname "$0")/../apps/web/public/erc8004" && pwd)"
GIVE="giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)"
READ_ALL="readAllFeedback(uint256,address[],string,string,bool)(address[],uint64[],int128[],uint8[],string[],string[],bool[])"

# keccak256 of a file's exact bytes.
keccak_file() { cast keccak "0x$(od -An -v -tx1 "$1" | tr -d ' \n')"; }
same_address() { [ "$(cast to-check-sum-address "$1")" = "$(cast to-check-sum-address "$2")" ]; }

case "$RPC" in
  http://127.0.0.1* | http://localhost*) REHEARSAL=1 ;;
  *) REHEARSAL=0 ;;
esac

ME=$(cast wallet address --account "$ACCOUNT")
echo "== signing as $ME"
if [ "$(cast nonce "$ME" --block pending --rpc-url "$RPC")" != "$(cast nonce "$ME" --rpc-url "$RPC")" ]; then
  echo "a transaction from this wallet is still waiting to be mined: run this again once it is" >&2
  exit 1
fi
if ! same_address "$(cast call $REPUTATION "getIdentityRegistry()(address)" --rpc-url "$RPC")" $IDENTITY; then
  echo "the Reputation Registry $REPUTATION does not point at the Identity Registry $IDENTITY: stop and look" >&2
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
SENT=0
for ORDER in 1 2; do
  NAME="feedback-order-$ORDER.json"
  FILE="$FILES/$NAME"
  URI="$SITE/erc8004/$NAME"
  AGENT=$(jq -r .agentId "$FILE")
  CLIENT=$(jq -r .clientAddress "$FILE" | cut -d: -f3)
  VALUE=$(jq -r .value "$FILE")
  DECIMALS=$(jq -r .valueDecimals "$FILE")
  TAG1=$(jq -r .tag1 "$FILE")
  TAG2=$(jq -r .tag2 "$FILE")
  ENDPOINT=$(jq -r .endpoint "$FILE")
  echo "== order $ORDER: agent $AGENT, value $VALUE (decimals $DECIMALS), tags $TAG1 / $TAG2"

  if [ "$(jq -r .agentRegistry "$FILE")" != "eip155:1:$(printf '%s' "$IDENTITY" | tr 'A-F' 'a-f')" ]; then
    echo "$NAME names another agent registry: stop and look" >&2
    exit 1
  fi
  if ! same_address "$ME" "$CLIENT"; then
    if [ "$REHEARSAL" = 1 ]; then
      echo "   rehearsal on a local fork: the file names $CLIENT as its client, the signer is $ME"
    else
      echo "the file names $CLIENT as its client, but the keystore $ACCOUNT holds $ME: use the keystore that holds H1" >&2
      exit 1
    fi
  fi

  HAVE=$(cast call $REPUTATION "$READ_ALL" "$AGENT" "[$ME]" "$TAG1" "$TAG2" false --rpc-url "$RPC" --json | jq -r '.[1] | map(tostring) | join(", ")')
  if [ -n "$HAVE" ]; then
    echo "   already reviewed by this wallet with these tags (entry $HAVE): nothing to send"
    continue
  fi

  # The hash goes on chain only if the file at the URI is the one in this repository.
  if ! curl -fsS -o "$TMP/$NAME" "$FETCH_SITE/erc8004/$NAME"; then
    echo "$FETCH_SITE/erc8004/$NAME could not be read: deploy the site first" >&2
    exit 1
  fi
  HASH=$(keccak_file "$FILE")
  if [ "$(keccak_file "$TMP/$NAME")" != "$HASH" ]; then
    echo "$FETCH_SITE/erc8004/$NAME is not byte for byte the file in $FILES: deploy the site first" >&2
    exit 1
  fi
  echo "   feedbackURI  $URI"
  echo "   feedbackHash $HASH (keccak256 of the $(wc -c <"$FILE" | tr -d ' ') bytes it serves)"

  RECEIPT=$(cast send $REPUTATION "$GIVE" "$AGENT" "$VALUE" "$DECIMALS" "$TAG1" "$TAG2" "$ENDPOINT" "$URI" "$HASH" \
    --timeout 600 --account "$ACCOUNT" --rpc-url "$RPC" --json)
  TX=$(echo "$RECEIPT" | jq -r .transactionHash)
  if [ "$(echo "$RECEIPT" | jq -r .status)" != "0x1" ]; then
    echo "transaction $TX failed: stop and look" >&2
    exit 1
  fi
  SENT=$((SENT + 1))
  echo "   tx $TX"
  echo "   the registry's entries from this wallet for agent $AGENT: $(cast call $REPUTATION "getLastIndex(uint256,address)(uint64)" "$AGENT" "$ME" --rpc-url "$RPC")"
done
echo "== done: $SENT review(s) sent"
