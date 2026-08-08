#!/usr/bin/env bash
# House bot: keep the park populated so a first-time visitor always has an
# opponent within seconds. Runs one autopilot (`chess-client connect --auto`)
# per time control under a single wallet, restarting each on failure with
# backoff.
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
#   MOVE_BUDGET           default 80 — plan each game as this many moves; the
#                         per-move search ceiling is initial/MOVE_BUDGET
#   MOVE_OVERHEAD_MS      default 250 — clock reserved per move for the round
#                         trip to the server
#   CLIENT                default: chess-client from PATH, else the repo's
#                         release build
set -euo pipefail

SERVER="${SERVER:-https://openchess.fly.dev}"
ENGINE="${ENGINE:-stockfish}"
NAME="${NAME:-House Bot}"
SKILL="${SKILL:-8}"
TCS="${TCS:-60:0 180:0 300:0 600:0}"
MOVE_BUDGET="${MOVE_BUDGET:-80}"
MOVE_OVERHEAD_MS="${MOVE_OVERHEAD_MS:-250}"

if [[ -z "${OPENCHESS_WALLET_KEY:-}" ]]; then
  echo "OPENCHESS_WALLET_KEY is required (a fresh, UNFUNDED key)." >&2
  exit 1
fi

# Resolve the client binary: explicit CLIENT, then PATH, then the repo build.
if [[ -z "${CLIENT:-}" ]]; then
  if command -v chess-client >/dev/null 2>&1; then
    CLIENT="chess-client"
  elif [[ -x "$(dirname "$0")/../target/release/chess-client" ]]; then
    CLIENT="$(dirname "$0")/../target/release/chess-client"
  else
    echo "chess-client not found — download a release binary or 'cargo build --release -p byo-client'." >&2
    exit 1
  fi
fi

command -v "$ENGINE" >/dev/null 2>&1 || [[ -x "$ENGINE" ]] || {
  echo "engine '$ENGINE' not found — e.g. 'brew install stockfish' / 'apt install stockfish'." >&2
  exit 1
}

# Validate time controls up front: a malformed token would otherwise silently
# run a TC no lobby tile matches (e.g. "300" would parse as 300+300).
for tc in $TCS; do
  if [[ "$tc" != *:* || ! "${tc%%:*}" =~ ^[0-9]+$ || ! "${tc##*:}" =~ ^[0-9]+$ ]]; then
    echo "bad TCS entry '$tc' — expected initial:increment seconds, e.g. 180:0" >&2
    exit 1
  fi
done

if [[ ! "$MOVE_BUDGET" =~ ^[0-9]+$ ]] || ((MOVE_BUDGET == 0)); then
  echo "MOVE_BUDGET must be a positive integer (moves to plan each game for)." >&2
  exit 1
fi

echo "house bot: $NAME (skill $SKILL) on $SERVER — time controls: $TCS"

# One autopilot per time control. Same wallet across instances is fine: the
# server records poster_addr for authed offers and autopilots skip their own
# wallet's offers, and different time controls never match each other anyway.
run_tc() {
  local initial="$1" increment="$2" delay=10
  # Ceiling on a single search. Left to itself, Stockfish's sudden-death
  # allocation spends ~62s on move 1 of a 10+0 game (and ~5s on move 1 of 3+0),
  # then plays the rest in a hurry — the house bot looked frozen in the opening
  # and flagged in the endgame. Nothing is lost by capping it here: at Skill
  # Level 8 the engine locks its move in at depth 9 and every deeper iteration
  # is discarded, and the cap still leaves it reaching depth ~20.
  local max_move_ms=$(( initial * 1000 / MOVE_BUDGET ))
  ((max_move_ms < 300)) && max_move_ms=300
  while true; do
    # The client's own output already names the game/opponent; the autopilot
    # retries transient errors internally, so an exit here is unusual.
    "$CLIENT" connect --auto \
      --server "$SERVER" \
      --engine "$ENGINE" \
      --name "$NAME" \
      --uci-option "Skill Level=$SKILL" \
      --max-move-ms "$max_move_ms" \
      --move-overhead-ms "$MOVE_OVERHEAD_MS" \
      --initial-secs "$initial" --increment-secs "$increment" || true
    echo "[${initial}+${increment}] autopilot exited; restarting in ${delay}s"
    sleep "$delay"
    delay=$((delay * 2))
    ((delay > 300)) && delay=300
  done
}

# On stop, kill each loop subshell AND its chess-client child — killing only
# the subshells orphans the clients (verified: they re-parent to init). The
# clients handle SIGTERM by withdrawing their posted challenge. (`kill 0`
# would be simpler but nukes the caller when the script shares its process
# group, e.g. under nohup.)
pids=()
trap '
  trap - INT TERM
  for p in "${pids[@]}"; do
    pkill -TERM -P "$p" 2>/dev/null || true
    kill "$p" 2>/dev/null || true
  done
' INT TERM

for tc in $TCS; do
  run_tc "${tc%%:*}" "${tc##*:}" &
  pids+=($!)
done

wait
