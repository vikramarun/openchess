#!/usr/bin/env bash
# House bot: keep the park populated so a first-time visitor always has an
# opponent within seconds. Runs one autopilot (`chess-client connect --auto`)
# per time control under a single wallet, restarting each on failure.
#
# The house wallet needs NO funds — house games are casual (no stake). Use a
# fresh throwaway key that holds nothing and never will.
#
# Usage:
#   OPENCHESS_WALLET_KEY=0x... ./scripts/house-bot.sh
#
# Configuration (env):
#   OPENCHESS_WALLET_KEY  required — house wallet private key (unfunded!)
#   SERVER                default https://openchess.fly.dev
#   ENGINE                default stockfish (must be on PATH or a path)
#   NAME                  default "House Bot"
#   SKILL                 default 8 — Stockfish "Skill Level" 0..20; keep it
#                         beatable so newcomers' bots get wins sometimes
#   TCS                   default "60:0 180:0 300:0 600:0" (initial:increment
#                         seconds; matches the lobby's 1+0/3+0/5+0/10+0 tiles)
#   CLIENT                default: chess-client from PATH, else the repo's
#                         release build
set -euo pipefail

SERVER="${SERVER:-https://openchess.fly.dev}"
ENGINE="${ENGINE:-stockfish}"
NAME="${NAME:-House Bot}"
SKILL="${SKILL:-8}"
TCS="${TCS:-60:0 180:0 300:0 600:0}"

if [[ -z "${OPENCHESS_WALLET_KEY:-}" ]]; then
  echo "OPENCHESS_WALLET_KEY is required (a fresh, UNFUNDED key)." >&2
  exit 1
fi

# Resolve the client binary: PATH, then the repo's release build.
if [[ -n "${CLIENT:-}" ]]; then
  :
elif command -v chess-client >/dev/null 2>&1; then
  CLIENT="chess-client"
elif [[ -x "$(dirname "$0")/../target/release/chess-client" ]]; then
  CLIENT="$(dirname "$0")/../target/release/chess-client"
else
  echo "chess-client not found — install a release binary or 'cargo build --release -p byo-client'." >&2
  exit 1
fi

command -v "$ENGINE" >/dev/null 2>&1 || [[ -x "$ENGINE" ]] || {
  echo "engine '$ENGINE' not found — e.g. 'brew install stockfish' / 'apt install stockfish'." >&2
  exit 1
}

echo "house bot: $NAME (skill $SKILL) on $SERVER — time controls: $TCS"

# One autopilot per time control. Same wallet across instances is fine:
# autopilots never accept their own wallet's offers, and different time
# controls never match each other anyway.
run_tc() {
  local initial="$1" increment="$2"
  while true; do
    "$CLIENT" connect --auto \
      --server "$SERVER" \
      --engine "$ENGINE" \
      --name "$NAME" \
      --uci-option "Skill Level=$SKILL" \
      --initial-secs "$initial" --increment-secs "$increment" \
      2>&1 | sed "s/^/[${initial}+${increment}] /" || true
    echo "[${initial}+${increment}] autopilot exited; restarting in 10s"
    sleep 10
  done
}

pids=()
for tc in $TCS; do
  initial="${tc%%:*}"
  increment="${tc##*:}"
  run_tc "$initial" "$increment" &
  pids+=($!)
done

trap 'kill "${pids[@]}" 2>/dev/null' INT TERM
wait
