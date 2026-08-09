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

# Make sure that machine is actually RUNNING.
#
# fly.toml sets auto_start_machines = false (with min_machines_running = 1),
# which means nothing — not the proxy, not a request — will start a machine that
# ends a rollout stopped. A deploy has already left this app down that way: the
# rolling restart finished, the machine settled into `stopped`, and the proxy
# served "no known healthy instances" to real traffic until someone noticed.
# Fly can still hold a lease for a few seconds after the deploy returns, so retry.
# `-q` pads the id with surrounding spaces, so trim it: a quoted "$id" that
# still carries them makes every `fly machine start` below fail silently.
id=$(fly machines list -q | awk 'NF{print $1; exit}')
echo "→ ensuring machine ${id} is started"
started=""
for _ in $(seq 1 12); do
  state=$(fly machines list --json 2>/dev/null | grep -o '"state": *"[a-z]*"' | head -1 | sed 's/.*"\([a-z]*\)"$/\1/' || true)
  if [ "$state" = "started" ]; then
    started=1
    break
  fi
  fly machine start "$id" >/dev/null 2>&1 || true
  sleep 5
done
if [ -z "$started" ]; then
  echo "  (machine still not 'started' — the health gate below is the real test)"
fi

# Gate on the app actually answering. This used to be `curl … || true`, which
# meant a completely dead app still exited 0 — the script printed a timeout and
# declared success. A deploy that leaves the service down is a failed deploy, and
# it has to say so, or the next person finds out from users.
echo "→ waiting for https://openchess.fly.dev/health"
ok=""
for _ in $(seq 1 30); do
  if [ "$(curl -s -o /dev/null -m 10 -w '%{http_code}' https://openchess.fly.dev/health)" = "200" ]; then
    ok=1
    break
  fi
  sleep 5
done
if [ -z "$ok" ]; then
  echo >&2
  echo "FAIL: deploy finished but the server is not serving /health." >&2
  echo "The app is DOWN. Investigate before walking away:" >&2
  echo "  fly logs" >&2
  echo "  fly machines list" >&2
  echo "  fly machine start ${id}" >&2
  exit 1
fi
echo "✓ /health is answering"

# /ready is the stronger check: it fails closed when wagering is configured but
# the database is unreachable, which is exactly the state a bad migration leaves.
echo "→ /ready:"
# `|| true` so a CONNECTION failure (curl exit 7, not an HTTP status) doesn't
# trip `set -e` here and kill the script before it can say what went wrong. The
# empty string that leaves behind is not "200", so it still fails — loudly.
ready=$(curl -s -o /dev/null -m 15 -w '%{http_code}' https://openchess.fly.dev/ready || true)
if [ "$ready" != "200" ]; then
  echo >&2
  echo "FAIL: /ready returned ${ready} — the server is up but not fit to serve." >&2
  echo "Usually a database/migration problem. Check: fly logs" >&2
  exit 1
fi
echo "✓ ready"

echo "→ /config sanity:"
curl -sS -m 15 https://openchess.fly.dev/config
echo
