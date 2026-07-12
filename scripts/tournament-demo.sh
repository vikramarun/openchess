#!/bin/bash
# Live E2E staked-tournament money-loop on a local Anvil chain + real Postgres.
#
# This is a thin wrapper around scripts/tournament-e2e.py, which drives the FULL
# round-by-round flow the server actually implements today (the old inline bash
# version predated the round-by-round rebuild + organizer-auth on /start +
# per-entrant token fetch, and no longer works). The Python harness covers both:
#   Test A  settled tournament  — pool distributed on-chain by standings (65/25/10)
#   Test B  abandoned tournament — restart -> claimRefund recovers every buy-in
#
# Prereqs: anvil/forge/cast, psql + a Postgres at $DATABASE_URL with migrations
# applied, and `cargo build`.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec python3 "$ROOT/scripts/tournament-e2e.py" "$@"
