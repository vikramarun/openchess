#!/bin/bash
# Live Base Sepolia verification of the tournament CLAIM + REFUND money paths.
#
# Runs the env-gated, #[ignore]d integration test `tournament_claim_and_refund_live`
# (crates/ledger/src/lib.rs) against a real chain. It exercises the exact
# production code — merkle_root / merkle_proof / tournament_leaf + OnchainSettlement
# — so it proves:
#   * a Rust-built Merkle proof verifies against the deployed Solidity _verifyProof
#     (claimTournament credits the winner's bankroll), on real block timing + gas
#   * a double-claim is rejected (AlreadyClaimed)
#   * an entrant reclaims their buy-in after the settle window (claimRefund)
#   * game_id_to_bytes32(tid) == the web app's tidToBytes32(tid) (printed to compare)
#
# It DEPLOYS throwaway MockUSDC + escrows each run (so it's repeatable and the
# refund window is short enough to wait out) — it does NOT touch the live mainnet
# deployment. What it does NOT cover: the browser button itself (needs a wallet +
# running server); see the manual step printed at the end.
#
# Usage:
#   LEDGER_TEST_RPC=https://sepolia.base.org \
#   LEDGER_TEST_KEY=0x<funded testnet private key> \
#   [LEDGER_TEST_TIMEOUT=30] \
#   scripts/test-sepolia-tournament.sh
#
# The key must hold a little Base Sepolia ETH for gas (2 deploys + ~10 txs;
# ~0.02 ETH is plenty). Faucet: https://docs.base.org/docs/tools/network-faucets
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

: "${LEDGER_TEST_RPC:?set LEDGER_TEST_RPC to a Base Sepolia RPC URL (e.g. https://sepolia.base.org)}"
: "${LEDGER_TEST_KEY:?set LEDGER_TEST_KEY to a funded Base Sepolia private key (0x...)}"
LEDGER_TEST_TIMEOUT="${LEDGER_TEST_TIMEOUT:-30}"

echo "== Base Sepolia tournament claim/refund test =="
echo "   rpc            = $LEDGER_TEST_RPC"
echo "   refund window  = ${LEDGER_TEST_TIMEOUT}s"

# Best-effort gas sanity check (skipped if foundry's `cast` isn't installed).
if command -v cast >/dev/null 2>&1; then
  ADDR="$(cast wallet address --private-key "$LEDGER_TEST_KEY" 2>/dev/null || true)"
  if [ -n "$ADDR" ]; then
    BAL="$(cast balance "$ADDR" --rpc-url "$LEDGER_TEST_RPC" 2>/dev/null || echo 0)"
    echo "   signer         = $ADDR"
    echo "   balance (wei)  = $BAL"
    if [ "$BAL" = "0" ]; then
      echo "!! signer has 0 ETH on this RPC — fund it from a Base Sepolia faucet first." >&2
      exit 1
    fi
  fi
else
  echo "   (install foundry's \`cast\` for a pre-flight balance check)"
fi

echo "== running (deploys throwaway contracts; refund step waits out the window) =="
cd "$ROOT"
LEDGER_TEST_RPC="$LEDGER_TEST_RPC" \
LEDGER_TEST_KEY="$LEDGER_TEST_KEY" \
LEDGER_TEST_TIMEOUT="$LEDGER_TEST_TIMEOUT" \
  cargo test -p ledger tournament_claim_and_refund_live \
    -- --ignored --nocapture --exact tests::tournament_claim_and_refund_live

cat <<'EOF'

== on-chain paths verified. Optional manual web check ==
The automated test covers the contract + Merkle/settlement layer. To also
click the actual buttons in the web app against a fresh escrow:
  1. Note the escrow_pay address the test printed above.
  2. Run the server pointed at it (a settled root tournament whose UUID matches
     the printed tid), e.g.:
       RPC_URL=$LEDGER_TEST_RPC ESCROW_ADDR=<escrow_pay> ORACLE_KEY=$LEDGER_TEST_KEY \
       SIWE_CHAIN_ID=84532 cargo run -p server
  3. In apps/web (pnpm dev), open /tournament with the winner wallet connected —
     the "Claim <amount> USDC" button should appear and complete; for an
     abandoned tournament the "Claim refund" button appears past the timeout.
EOF
echo "DONE"
