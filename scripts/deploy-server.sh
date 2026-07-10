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

echo "→ /config sanity:"
curl -sS -m 15 https://openchess.fly.dev/config || true
echo
echo "Done. If 'fly machines list' shows more than one machine, destroy the extra:"
echo "  fly machine destroy <id> --force"
