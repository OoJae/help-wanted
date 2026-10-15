#!/usr/bin/env bash
# Launch C, first day, step 2 (launches/c-company/docs/LAUNCH.md): creates the documented rule
# "WHEN launch A's hires feed reports at least 100 hires, THEN hire a research report", funds it
# with one fire's cost (0.61 IMD) and fires it, which opens an order on the hire desk.
#
#   ACCOUNT=bot bash scripts/first-rule.sh
#
# ACCOUNT names a cast keystore (`cast wallet import NAME --interactive`); cast asks for its
# password at each of the three transactions. This script never sees a key.
set -euo pipefail

: "${ACCOUNT:?set ACCOUNT to the name of a cast keystore}"
RPC="${RPC:-https://ethereum-rpc.publicnode.com}"
IMD=0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7
QUESTIONS=0xEECE4628ceb091C13393fc64056Be8b8501fD3F6
RULES=0xcbF0dddF07C00a78E2E7561a6F47C275B8c05D7E
DESK=0x730CB6C845d896e33283d3A4Ed8967F8BAA778d2
HIRES=0xfde22d9c1b97b7ce9763dff388a66366f9012d4ba7c57c3239377a75532bee4d
DEPOSIT=610000000000000000
TEXT="Write a one-page plain-language report on who paid the IdentityMD swarm's job fee in the last 7,000 Ethereum blocks before this job started, from IMD Transfer events to the fee payee 0x4e0fA57Bde726079356537E2F34d671E9F41ADbc only, with every figure sourced to a transaction."
SPEC=$(cast from-utf8 "$TEXT")
ME=$(cast wallet address --account "$ACCOUNT")

echo "== signing as $ME"
echo "== the hires feed (value, fromBlock, toBlock, round, updatedAt):"
cast call $QUESTIONS "latest(bytes32)(uint256,uint64,uint64,uint64,uint64)" $HIRES --rpc-url "$RPC"
BAL=$(cast call $IMD "balanceOf(address)(uint256)" "$ME" --rpc-url "$RPC" | cut -d' ' -f1)
if [ "$(echo "$BAL < $DEPOSIT" | bc)" = 1 ]; then
  echo "the wallet holds $BAL IMD wei, less than the deposit $DEPOSIT" >&2
  exit 1
fi

echo "== 1 of 3: approve Rules for the deposit (0.61 IMD)"
cast send $IMD "approve(address,uint256)" $RULES $DEPOSIT --account "$ACCOUNT" --rpc-url "$RPC" >/dev/null

echo "== 2 of 3: create the rule"
cast send $RULES "createRule(((uint8,uint8,uint32,address,uint256,bytes32,bytes),uint8,(bytes32,uint96,uint96,uint32,uint32,uint96,address,address,uint8,uint32),(address,uint96),uint96,uint32,uint32),bytes,uint96)" \
  "((2,1,2592000,0xeece4628ceb091c13393fc64056be8b8501fd3f6,100,$HIRES,0x),1,($(cast keccak skill:research-report),560000000000000000,600000000000000000,86400,604800,250000000000000000,0x0000000000000000000000000000000000000000,0x0000000000000000000000000000000000000000,2,259200),(0x0000000000000000000000000000000000000000,0),10000000000000000,0,1)" \
  "$SPEC" $DEPOSIT --account "$ACCOUNT" --rpc-url "$RPC" >/dev/null
RULE=$(cast call $RULES "ruleCount()(uint256)" --rpc-url "$RPC" | cut -d' ' -f1)
CREATOR=$(cast call $RULES "getRule(uint256)((address,uint96,uint8,bool,uint32,uint32,uint96,uint32,uint40,uint64,bytes32,(uint8,uint8,uint32,address,uint256,bytes32,bytes),(bytes32,uint96,uint96,uint32,uint32,uint96,address,address,uint8,uint32),(address,uint96)))" "$RULE" --rpc-url "$RPC" | sed -E 's/^\(([^,]+),.*/\1/')
echo "   rule $RULE, created by $CREATOR"
if [ "$(cast to-check-sum-address "$CREATOR")" != "$(cast to-check-sum-address "$ME")" ]; then
  echo "rule $RULE is not this wallet's: somebody created a rule in between. Stop and look." >&2
  exit 1
fi
echo "   would it fire (holds, value, round): $(cast call $RULES "check(uint256)(bool,uint256,uint64)" "$RULE" --rpc-url "$RPC" | tr '\n' ' ')"

echo "== 3 of 3: fire the rule (opens the order on the hire desk)"
cast send $RULES "fire(uint256,bytes)" "$RULE" "$SPEC" --gas-limit 700000 --account "$ACCOUNT" --rpc-url "$RPC" >/dev/null
ORDER=$(cast call $DESK "orderCount()(uint256)" --rpc-url "$RPC" | cut -d' ' -f1)
echo "   order $ORDER on the desk; rule, escrow, change: $(cast call $RULES "orderOf(uint256)(uint256,uint96,uint96)" "$ORDER" --rpc-url "$RPC" | tr '\n' ' ')"
echo "== done: rule $RULE fired and opened order $ORDER"
