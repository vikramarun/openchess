#!/bin/bash
# End-to-end on-chain money loop on a local Anvil chain:
#   anvil -> deploy MockUSDC + ChessEscrow -> fund two players ->
#   server opens escrow on a staked game -> two engines play ->
#   server signs the result and settles on-chain -> show bankrolls move.
set -e
ROOT=/Users/vikramarun/chess
RPC=http://127.0.0.1:8545
CLIENT=$ROOT/target/debug/chess-client
SERVER=$ROOT/target/debug/chess-server

# Deterministic Anvil accounts.
K0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80  # deployer/fee
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
echo "== deploying MockUSDC =="
USDC=$(forge create test/ChessEscrow.t.sol:MockUSDC --rpc-url $RPC --private-key $K0 --broadcast --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["deployedTo"])')
echo "USDC=$USDC"
echo "== deploying ChessEscrow (oracle=$A1, fee=1%) =="
ESCROW=$(forge create src/ChessEscrow.sol:ChessEscrow --rpc-url $RPC --private-key $K0 --broadcast --json \
  --constructor-args $USDC $A1 $A0 100 3600 | python3 -c 'import sys,json;print(json.load(sys.stdin)["deployedTo"])')
echo "ESCROW=$ESCROW"

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

echo "== starting server (on-chain settlement via durable outbox) =="
DATABASE_URL="postgres://vikramarun@localhost/chess" \
  RPC_URL=$RPC ESCROW_ADDR=$ESCROW ORACLE_KEY=$K1 RUST_LOG=info "$SERVER" >/tmp/server.log 2>&1 & SERVER_PID=$!
sleep 2

echo "== creating staked game (1 USDC stake, 3s sudden death) =="
RESP=$(curl -s --retry 15 --retry-connrefused -X POST http://127.0.0.1:8080/games -H 'content-type: application/json' \
  -d "{\"initial_secs\":3,\"increment_secs\":0,\"white_addr\":\"$A2\",\"black_addr\":\"$A3\",\"stake\":\"1000000\"}")
GID=$(echo "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["game_id"])')
WT=$(echo "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["white_token"])')
BT=$(echo "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["black_token"])')
echo "game=$GID"
bankrolls "after open (stakes locked)"

echo "== two engines play =="
"$CLIENT" play --game "$GID" --token "$WT" >/tmp/w.out 2>&1 & WP=$!
"$CLIENT" play --game "$GID" --token "$BT" >/tmp/b.out 2>&1 & BP=$!
wait $WP || true
wait $BP || true
sleep 2  # let settlement tx mine

grep -i "Game over" /tmp/w.out | head -1
sleep 2  # allow the outbox worker to drain
bankrolls "after settlement"
echo "== outbox + settlement status (Postgres) =="
psql -d chess -t -c "SELECT status FROM settlement_outbox WHERE game_id='$GID';"
psql -d chess -t -c "SELECT settlement_status FROM games WHERE id='$GID';"
echo "== settlement log =="
grep -iE "outbox|settle" /tmp/server.log | tail -4
echo "DONE"
