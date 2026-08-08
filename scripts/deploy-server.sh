#!/usr/bin/env bash
# Deploy the OpenChess game server to Fly — CORRECTLY.
#
# This server is single-node stateful (live games, lobby, rooms, launch tokens,
# and SIWE sessions live in one process's memory). Fly defaults to a 2-machine
# HA pair, which silently breaks it. This wrapper always deploys without HA,
# pins the count to one, and shows the machine list so you can eyeball it.
#
# Usage:  ./scripts/deploy-server.sh   (run from repo root; extra args pass to fly deploy)
set -euo pipefail

echo "→ fly deploy --ha=false"
fly deploy --ha=false "$@"

echo "→ fly scale count 1"
fly scale count 1

echo "→ machines (MUST be exactly one):"
fly machines list

# Assert it — don't just print it and hope. This list was already printed here,
# and a second machine still ran unnoticed in production long enough to break
# sign-in and the lobby. A warning only works if somebody reads it.
#
# Why one machine: every piece of live state — lobby, rooms, launch tokens,
# SIWE nonces and sessions, rate-limit buckets — lives in ONE process's memory.
# With two, Fly's proxy alternates between them, so a nonce issued by machine A
# fails to verify on B (intermittent 401s that look like a client bug) and
# offers appear and vanish depending on which machine answered. Fly re-adds the
# HA machine on any bare `fly deploy`, so this can return whenever someone
# skips this wrapper — which is exactly how it happened.
#
# Counts every machine, including stopped ones: a stopped machine is one
# `fly machine start` away from splitting the state again.
count=$(fly machines list -q | grep -c '[^[:space:]]' || true)
if [ "$count" -ne 1 ]; then
  echo >&2
  echo "FAIL: expected exactly 1 machine, found ${count}." >&2
  echo "This server cannot run multi-node. Destroy the extras before it serves traffic:" >&2
  echo "  fly machines list" >&2
  echo "  fly machine destroy <id> --force" >&2
  exit 1
fi
echo "✓ exactly one machine"

echo "→ /config sanity:"
curl -sS -m 15 https://openchess.fly.dev/config || true
echo
