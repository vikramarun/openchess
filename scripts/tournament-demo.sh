#!/bin/bash
# End-to-end staked TOURNAMENT on a local Anvil chain:
# SIWE sign-in -> create buy-in tournament (opens pool on-chain) -> 3 players
# join (each buy-in locked via enterTournament) -> round-robin games -> server
# aggregates standings -> on completion the pool is distributed on-chain via
# settleTournament by final standings.
set -e
ROOT=/Users/vikramarun/chess
RPC=http://127.0.0.1:8545
H=http://127.0.0.1:8080
CLIENT=$ROOT/target/debug/chess-client
SERVER=$ROOT/target/debug/chess-server
jget() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }

K0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
A1=0x70997970C51812dc3A010C7d01b50e0d17dc79C8; K1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
A0=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
# players
A2=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC; K2=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
A3=0x90F79bf6EB2c4f870365E785982E1f101E93b906; K3=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
A4=0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65; K4=0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a

cleanup() { kill $ANVIL_PID $SERVER_PID 2>/dev/null || true; }
trap cleanup EXIT

echo "== anvil + deploy =="
anvil >/tmp/anvil.log 2>&1 & ANVIL_PID=$!
sleep 2
cd "$ROOT/contracts"
USDC=$(forge create test/ChessEscrow.t.sol:MockUSDC --rpc-url $RPC --private-key $K0 --broadcast --json | jget "['deployedTo']")
ESCROW=$(forge create src/ChessEscrow.sol:ChessEscrow --rpc-url $RPC --private-key $K0 --broadcast --json \
  --constructor-args $USDC $A1 $A0 0 3600 | jget "['deployedTo']")
echo "ESCROW=$ESCROW (0% rake)"

fund() { cast send $USDC "mint(address,uint256)" $2 10000000 --rpc-url $RPC --private-key $1 >/dev/null
         cast send $USDC "approve(address,uint256)" $ESCROW 10000000 --rpc-url $RPC --private-key $1 >/dev/null
         cast send $ESCROW "deposit(uint256)" 10000000 --rpc-url $RPC --private-key $1 >/dev/null; }
fund $K2 $A2; fund $K3 $A3; fund $K4 $A4

bank() { cast call $ESCROW "bankroll(address)(uint256)" $1 --rpc-url $RPC | awk '{print $1}'; }
echo "bankrolls before: p1=$(bank $A2) p2=$(bank $A3) p3=$(bank $A4)"

echo "== start server =="
DATABASE_URL="postgres://vikramarun@localhost/chess" SIWE_DOMAIN=chess.local SIWE_CHAIN_ID=8453 \
  RPC_URL=$RPC ESCROW_ADDR=$ESCROW ORACLE_KEY=$K1 RUST_LOG=info "$SERVER" >/tmp/server.log 2>&1 & SERVER_PID=$!
sleep 2

siwe() { # key addr -> token
  local N M S
  N=$(curl -s --retry 15 --retry-connrefused $H/auth/nonce | jget "['nonce']")
  M=$(printf 'chess.local wants you to sign in with your Ethereum account:\n%s\n\nSign in.\n\nURI: http://chess.local\nVersion: 1\nChain ID: 8453\nNonce: %s\nIssued At: 2026-05-30T00:00:00Z' "$2" "$N")
  S=$(cast wallet sign --private-key "$1" "$M")
  python3 - "$M" "$S" <<'PY'
import sys,json,urllib.request
d=json.dumps({"message":sys.argv[1],"signature":sys.argv[2]}).encode()
r=urllib.request.Request("http://127.0.0.1:8080/auth/verify",data=d,headers={"content-type":"application/json"})
print(json.load(urllib.request.urlopen(r))["token"])
PY
}
S2=$(siwe $K2 $A2); S3=$(siwe $K3 $A3); S4=$(siwe $K4 $A4)
echo "signed in 3 players"

echo "== create 1 USDC buy-in tournament (opens pool on-chain) =="
TID=$(curl -s -X POST $H/tournaments -H 'content-type: application/json' \
  -d '{"name":"Anvil Open","buy_in":"1000000","initial_secs":5,"increment_secs":0}' | jget "['tournament_id']")
echo "tournament=$TID"

echo "== 3 players join (each buy-in locked on-chain) =="
JOINH='content-type: application/json'
curl -s -X POST $H/tournaments/$TID/join -H "$JOINH" -H "authorization: Bearer $S2" -d '{}'; echo
curl -s -X POST $H/tournaments/$TID/join -H "$JOINH" -H "authorization: Bearer $S3" -d '{}'; echo
curl -s -X POST $H/tournaments/$TID/join -H "$JOINH" -H "authorization: Bearer $S4" -d '{}'; echo
echo "bankrolls after join (1 USDC locked each): p1=$(bank $A2) p2=$(bank $A3) p3=$(bank $A4)"

echo "== start round-robin + play all games =="
curl -s -X POST $H/tournaments/$TID/start | python3 -c '
import sys,json
for g in json.load(sys.stdin): print(g["game_id"], g["white_token"], g["black_token"])
' > /tmp/tgames.txt
PIDS=()
while read -r GID WT BT; do
  "$CLIENT" play --game "$GID" --token "$WT" >/tmp/tw_$GID.out 2>&1 & PIDS+=($!)
  "$CLIENT" play --game "$GID" --token "$BT" >/tmp/tb_$GID.out 2>&1 & PIDS+=($!)
done < /tmp/tgames.txt   # redirect (not pipe) so PIDs are real children
wait "${PIDS[@]}" 2>/dev/null || true
sleep 4  # allow scoring + on-chain distribution

echo "== final standings + settlement =="
curl -s $H/tournaments/$TID | python3 -c "import sys,json;d=json.load(sys.stdin);print('status:',d['status'])"
echo "bankrolls after settle: p1=$(bank $A2) p2=$(bank $A3) p3=$(bank $A4)"
echo "sum (should be 30 USDC = conserved): $(python3 -c "print($(bank $A2)+$(bank $A3)+$(bank $A4))")"
grep -iE "tournament" /tmp/server.log | tail -4
echo DONE
