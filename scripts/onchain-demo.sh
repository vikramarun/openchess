#!/bin/bash
# End-to-end on-chain money loop on a local Anvil chain, exercising the SECURED
# flow: SIWE sign-in -> authenticated Park offer/accept (seats bound to the
# signed-in wallets) -> escrow opened -> two engines play -> result enqueued to
# the durable settlement outbox -> worker signs an EIP-712 result and settles
# on-chain -> bankrolls move.
set -e
ROOT=/Users/vikramarun/chess
RPC=http://127.0.0.1:8545
H=http://127.0.0.1:8080
CLIENT=$ROOT/target/debug/chess-client
SERVER=$ROOT/target/debug/chess-server
jget() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }

# Deterministic Anvil accounts.
K0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # deployer/fee
A1=0x70997970C51812dc3A010C7d01b50e0d17dc79C8; K1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d  # oracle
A2=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC; K2=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a  # white
A3=0x90F79bf6EB2c4f870365E785982E1f101E93b906; K3=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6  # black
A0=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

cleanup() { kill $ANVIL_PID $SERVER_PID 2>/dev/null || true; }
trap cleanup EXIT

echo "== starting anvil =="
anvil >/tmp/anvil.log 2>&1 & ANVIL_PID=$!
sleep 2

cd "$ROOT/contracts"
echo "== deploying MockUSDC + ChessEscrow (oracle=$A1, fee=1%) =="
USDC=$(forge create test/ChessEscrow.t.sol:MockUSDC --rpc-url $RPC --private-key $K0 --broadcast --json | jget "['deployedTo']")
ESCROW=$(forge create src/ChessEscrow.sol:ChessEscrow --rpc-url $RPC --private-key $K0 --broadcast --json \
  --constructor-args $USDC $A1 $A0 100 3600 | jget "['deployedTo']")
echo "USDC=$USDC ESCROW=$ESCROW"

fund() { # key addr
  cast send $USDC "mint(address,uint256)" $2 10000000 --rpc-url $RPC --private-key $1 >/dev/null
  cast send $USDC "approve(address,uint256)" $ESCROW 10000000 --rpc-url $RPC --private-key $1 >/dev/null
  cast send $ESCROW "deposit(uint256)" 10000000 --rpc-url $RPC --private-key $1 >/dev/null
}
echo "== funding + depositing 10 USDC each for white & black =="
fund $K2 $A2
fund $K3 $A3

bankrolls() { # label
  W=$(cast call $ESCROW "bankroll(address)(uint256)" $A2 --rpc-url $RPC | awk '{print $1}')
  B=$(cast call $ESCROW "bankroll(address)(uint256)" $A3 --rpc-url $RPC | awk '{print $1}')
  echo "[$1] white.bankroll=$W  black.bankroll=$B (USDC base units, 6dp)"
}
bankrolls "before game"

echo "== starting server (SIWE + on-chain settlement via durable outbox) =="
DATABASE_URL="postgres://vikramarun@localhost/chess" SIWE_DOMAIN=chess.local SIWE_CHAIN_ID=8453 \
  RPC_URL=$RPC ESCROW_ADDR=$ESCROW ORACLE_KEY=$K1 RUST_LOG=info "$SERVER" >/tmp/server.log 2>&1 & SERVER_PID=$!
sleep 2

# SIWE sign-in for a wallet; echoes the session token.
siwe_login() { # key addr
  local NONCE MSG SIG
  NONCE=$(curl -s --retry 15 --retry-connrefused $H/auth/nonce | jget "['nonce']")
  MSG=$(printf 'chess.local wants you to sign in with your Ethereum account:\n%s\n\nSign in to Chess Wager.\n\nURI: http://chess.local\nVersion: 1\nChain ID: 8453\nNonce: %s\nIssued At: 2026-05-30T00:00:00Z' "$2" "$NONCE")
  SIG=$(cast wallet sign --private-key "$1" "$MSG")
  python3 - "$MSG" "$SIG" <<'PY'
import sys,json,urllib.request
msg,sig=sys.argv[1],sys.argv[2]
data=json.dumps({"message":msg,"signature":sig}).encode()
req=urllib.request.Request("http://127.0.0.1:8080/auth/verify",data=data,headers={"content-type":"application/json"})
print(json.load(urllib.request.urlopen(req))["token"])
PY
}

echo "== SIWE sign-in for white & black =="
WSESS=$(siwe_login $K2 $A2); echo "white session=${WSESS:0:12}..."
BSESS=$(siwe_login $K3 $A3); echo "black session=${BSESS:0:12}..."

echo "== white posts a 1 USDC Park offer (authenticated) =="
OID=$(curl -s -X POST $H/park/offers -H "authorization: Bearer $WSESS" -H 'content-type: application/json' \
  -d '{"stake":"1000000","initial_secs":3,"increment_secs":0}' | jget "['offer_id']")
echo "offer=$OID"
echo "== black accepts (authenticated) — seats bound to the two signed-in wallets =="
ACC=$(curl -s -X POST $H/park/offers/$OID/accept -H "authorization: Bearer $BSESS" -H 'content-type: application/json' -d '{}')
GID=$(echo "$ACC" | jget "['game_id']"); BT=$(echo "$ACC" | jget "['token']")
WT=$(curl -s $H/park/offers/$OID | jget "['token']")
echo "game=$GID"
bankrolls "after open (stakes locked)"

echo "== two engines play =="
"$CLIENT" play --game "$GID" --token "$WT" >/tmp/w.out 2>&1 & WP=$!
"$CLIENT" play --game "$GID" --token "$BT" >/tmp/b.out 2>&1 & BP=$!
wait $WP || true
wait $BP || true
sleep 3  # let the outbox worker drain

grep -i "Game over" /tmp/w.out | head -1
bankrolls "after settlement"
echo "== outbox + settlement status (Postgres) =="
psql -d chess -t -c "SELECT status FROM settlement_outbox WHERE game_id='$GID';"
psql -d chess -t -c "SELECT settlement_status FROM games WHERE id='$GID';"
echo "== settlement log =="
grep -iE "outbox|settle|opened escrow" /tmp/server.log | tail -4
echo "DONE"
