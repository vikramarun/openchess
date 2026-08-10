#!/usr/bin/env bash
# House bot: keep the park populated so a first-time visitor always has an
# opponent within seconds. Runs SEATS autopilots (`chess-client connect --auto`)
# per time control under a single wallet, restarting each on failure with
# backoff.
#
# SEATS is what makes a time control survive being *chosen*. One autopilot plays
# one game at a time, so with SEATS=1 the first visitor to accept the 3+0
# challenge takes the only 3+0 seat and the tile vanishes from the lobby for
# everyone else until that game ends. That reads as "3+0 is broken", not "the
# house is busy". Each idle autopilot costs a poll loop and nothing else (the
# engine is launched per game, not at startup), so the only real cost is CPU
# when several house games run at once. See the [[vm]] sizing note in
# fly.housebot.toml before raising it much.
#
# The bot wallet needs NO funds: its games are casual (no stake). Use a
# fresh throwaway key that holds nothing and never will.
#
# Usage:
#   OPENCHESS_WALLET_KEY=0x... ./scripts/house-bot.sh
#
# Configuration (env):
#   OPENCHESS_WALLET_KEY  required: bot wallet private key (unfunded!)
#   SERVER                default https://openchess.fly.dev
#   ENGINE                default stockfish (must be on PATH or a path)
#   NAME                  default "House Bot"
#   SKILL                 default 20: Stockfish "Skill Level" 0..20. 20 is
#                         full strength (and Stockfish's own default). Below 20
#                         the engine picks a deliberately worse move from the
#                         top few, which reads as random blunders rather than
#                         weaker play; if you ever want a beatable house bot
#                         again, UCI_LimitStrength + UCI_Elo is the honest knob.
#   TCS                   default "60:0 180:0 300:0 600:0" (initial:increment
#                         seconds; matches the lobby's 1+0/3+0/5+0/10+0 tiles)
#   SEATS                 default 2: concurrent house games per time control.
#                         TCS×SEATS offers stand at once, so it must stay under
#                         the server's RL_MAX_OPEN_OFFERS (default 16).
#   MOVE_BUDGET           default 80: plan each game as this many moves; the
#                         per-move search ceiling is initial/MOVE_BUDGET
#   MOVE_OVERHEAD_MS      clock reserved per move for the round trip to the
#                         server. UNSET BY DEFAULT, and it should stay that
#                         way: the client scales it to each time control,
#                         because Stockfish reserves a MULTIPLE of this value
#                         (~52x) and a number tuned for a 10-minute game holds
#                         back a fifth of a bullet clock — which is what made
#                         the bot answer in ~2ms below 13 seconds. Set it only
#                         if you know this host's latency to the server.
#   BOOK                  Polyglot .bin played before the engine; defaults to
#                         the one shipped in the image, else the repo's
#                         assets/house-book.bin. Set BOOK= (empty) to disable.
#   BOOK_MAX_PLY          default 16: leave the book after this many plies
#   CLIENT                default: chess-client from PATH, else the repo's
#                         release build
set -euo pipefail

SERVER="${SERVER:-https://openchess.fly.dev}"
ENGINE="${ENGINE:-stockfish}"
NAME="${NAME:-House Bot}"
SKILL="${SKILL:-20}"
TCS="${TCS:-60:0 180:0 300:0 600:0}"
SEATS="${SEATS:-2}"
MOVE_BUDGET="${MOVE_BUDGET:-80}"
BOOK_MAX_PLY="${BOOK_MAX_PLY:-16}"

# Opening book. `${BOOK+set}` (no colon) distinguishes "not set" from
# "deliberately empty", so BOOK= disables the book instead of silently falling
# back to the default path.
#
# Auto-detection FAILS rather than shrugging when it finds nothing. Playing on
# without a book is the exact regression this shipped to fix (every opening
# move becomes a full search), and it would be invisible in production: the
# bot would look healthy and just quietly burn its clock again. A broken
# Dockerfile COPY or a renamed asset has to be loud. Opting out stays possible,
# it just has to be deliberate: BOOK=.
BOOK_CANDIDATES=(
  /usr/local/share/openchess/house-book.bin
  "$(dirname "$0")/../assets/house-book.bin"
)
if [[ -z "${BOOK+set}" ]]; then
  for candidate in "${BOOK_CANDIDATES[@]}"; do
    [[ -f "$candidate" ]] && { BOOK="$candidate"; break; }
  done
  if [[ -z "${BOOK:-}" ]]; then
    echo "No opening book found. Looked in:" >&2
    printf '  %s\n' "${BOOK_CANDIDATES[@]}" >&2
    echo "Generate it with 'cargo run -p book-gen -- assets/house-book.bin', or set BOOK= to play without one." >&2
    exit 1
  fi
fi

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
    echo "chess-client not found. Download a release binary, or run 'cargo build --release -p byo-client'." >&2
    exit 1
  fi
fi

command -v "$ENGINE" >/dev/null 2>&1 || [[ -x "$ENGINE" ]] || {
  echo "engine '$ENGINE' not found. Try 'brew install stockfish' or 'apt install stockfish'." >&2
  exit 1
}

# Validate time controls up front: a malformed token would otherwise silently
# run a TC no lobby tile matches (e.g. "300" would parse as 300+300).
for tc in $TCS; do
  if [[ "$tc" != *:* || ! "${tc%%:*}" =~ ^[0-9]+$ || ! "${tc##*:}" =~ ^[0-9]+$ ]]; then
    echo "bad TCS entry '$tc'. Expected initial:increment seconds, e.g. 180:0" >&2
    exit 1
  fi
done

if [[ ! "$MOVE_BUDGET" =~ ^[0-9]+$ ]] || ((MOVE_BUDGET == 0)); then
  echo "MOVE_BUDGET must be a positive integer (moves to plan each game for)." >&2
  exit 1
fi

if [[ ! "$SEATS" =~ ^[0-9]+$ ]] || ((SEATS == 0)); then
  echo "SEATS must be a positive integer (concurrent house games per time control)." >&2
  exit 1
fi

if [[ -n "${BOOK:-}" && ! -f "$BOOK" ]]; then
  echo "BOOK '$BOOK' not found. Generate it with 'cargo run -p book-gen -- assets/house-book.bin', or set BOOK= to play without one." >&2
  exit 1
fi

echo "house bot: $NAME (skill $SKILL) on $SERVER; time controls: $TCS (${SEATS} seat(s) each)"
echo "book: ${BOOK:-none (every opening move is a full search)}"

# SEATS autopilots per time control. Same wallet across instances is fine — and
# that is exactly why seats can be stacked: the server records poster_addr for
# authed offers and `compatible()` skips an offer from our own wallet, so two
# house autopilots on the same time control post two independent challenges and
# never pair with each other. Different time controls never match anyway.
run_tc() {
  local initial="$1" increment="$2" seat="$3" delay=10
  # Ceiling on a single search. Sudden-death allocation lets one unstable root
  # eat several times the target, and the start position is the most unstable
  # root there is (d4/e4/c4/Nf3 keep trading places), so move 1 is the worst
  # case: at full strength Stockfish spends 22s of a 10+0 clock and 11s of a
  # 3+0 clock on it, then plays the rest in a hurry. That is the whole
  # complaint — frozen in the opening, flagging in the endgame.
  #
  # The cap costs very little: 7.5s still reaches depth 27 at 10+0 (vs 33
  # uncapped) and picks the same move; 2.25s reaches depth 24 at 3+0. But the
  # cap only bounds the symptom — BOOK is the actual cure, since an in-book
  # move costs no time AND no depth.
  local max_move_ms=$(( initial * 1000 / MOVE_BUDGET ))
  ((max_move_ms < 300)) && max_move_ms=300
  # Empty BOOK means "no book"; --book with an empty value would be an error.
  local book_args=()
  [[ -n "${BOOK:-}" ]] && book_args=(--book "$BOOK" --book-max-ply "$BOOK_MAX_PLY")
  # Pass the reserve ONLY when it was pinned. Passing a value unconditionally
  # is what this used to do, and it defeated the per-time-control scaling the
  # client now does for itself — a flat 250ms is a fifth of the 1+0 clock.
  local overhead_args=()
  [[ -n "${MOVE_OVERHEAD_MS:-}" ]] && overhead_args=(--move-overhead-ms "$MOVE_OVERHEAD_MS")
  # Expanded below as ${book_args[@]+"${book_args[@]}"}: bash 3.2 (still the
  # /bin/bash on macOS) treats "${empty[@]}" as an unset variable under `set -u`
  # and aborts. Only the BOOK= opt-out path hits it — i.e. the path least likely
  # to be exercised before someone relies on it.
  while true; do
    # The client's own output already names the game/opponent; the autopilot
    # retries transient errors internally, so an exit here is unusual.
    "$CLIENT" connect --auto \
      --server "$SERVER" \
      --engine "$ENGINE" \
      --name "$NAME" \
      --uci-option "Skill Level=$SKILL" \
      --max-move-ms "$max_move_ms" \
      ${overhead_args[@]+"${overhead_args[@]}"} \
      ${book_args[@]+"${book_args[@]}"} \
      --initial-secs "$initial" --increment-secs "$increment" || true
    echo "[${initial}+${increment} #${seat}] autopilot exited; restarting in ${delay}s"
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
  for ((seat = 1; seat <= SEATS; seat++)); do
    run_tc "${tc%%:*}" "${tc##*:}" "$seat" &
    pids+=($!)
  done
done

wait
