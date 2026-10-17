#!/usr/bin/env bash
# Run every gate .github/workflows/ci.yml runs, locally, against any checkout —
# and keep going past a failure so one run shows the whole picture (CI stops at
# the first red step, which is how a fmt diff once hid that cargo test and the
# whole web suite had never run on a PR).
#
# Usage:  ci-gates.sh [REPO_ROOT] [LOG_DIR]
#   REPO_ROOT  checkout to test (default: the git toplevel of $PWD)
#   LOG_DIR    where per-gate logs + SUMMARY go (default: a fresh temp dir)
#
# Database: the persistence tests write to Postgres and APPLY THE BRANCH'S
# MIGRATIONS to whatever they are pointed at. So this always creates its own
# throwaway database on the local server and drops it afterwards, and an
# inherited DATABASE_URL is ignored — "it's on localhost" is not "it's safe":
# the developer's `chess` dev DB is on localhost, a branch migration applied
# to it stops main's server from booting, and a `fly proxy` to production is
# on localhost too. (A prod DB got a branch's migration early once already.)
#
# The environment is scrubbed of anything that reaches a real chain or a real
# alert channel: `cargo test` builds sinks from RPC_URL/ESCROW_ADDR/ORACLE_KEY
# when they are set, and posts failure-path alerts to ALERT_WEBHOOK_URL.
#
# Exit status: 0 only if every gate passed.
set -u

ROOT=$(cd "${1:-$(git rev-parse --show-toplevel)}" && pwd)
LOGS=${2:-$(mktemp -d "${TMPDIR:-/tmp}/openchess-gates.XXXXXX")}
mkdir -p "$LOGS"
SUMMARY="$LOGS/SUMMARY"
: >"$SUMMARY"

# --- environment + database -------------------------------------------------
unset RPC_URL ESCROW_ADDR ORACLE_KEY ALERT_WEBHOOK_URL ADMIN_WALLET HOUSE_WALLET
if [ -n "${DATABASE_URL:-}" ]; then
  echo "note: ignoring DATABASE_URL — the gates always use their own scratch database" | tee -a "$SUMMARY"
fi
unset DATABASE_URL
SCRATCH_DB="openchess_gates_$$_$(date +%s)"
if createdb "$SCRATCH_DB" 2>/dev/null; then
  export DATABASE_URL="postgres://localhost/$SCRATCH_DB"
else
  echo "FAIL: no local Postgres (createdb failed) — the persistence tests would silently no-op" | tee -a "$SUMMARY"
  exit 2
fi
cleanup() { [ -n "$SCRATCH_DB" ] && dropdb --if-exists "$SCRATCH_DB" 2>/dev/null; }
trap cleanup EXIT

failed=0
gate() { # gate <name> <dir-relative-to-root> <cmd...>
  local name=$1 dir=$2
  shift 2
  local t0=$SECONDS rc
  (cd "$ROOT/$dir" && "$@") >"$LOGS/$name.log" 2>&1
  rc=$?
  [ $rc -ne 0 ] && failed=1
  printf "%-26s %-12s %4ss\n" "$name" "$([ $rc = 0 ] && echo PASS || echo "FAIL($rc)")" "$((SECONDS - t0))" | tee -a "$SUMMARY"
  return 0
}

echo "repo=$ROOT  head=$(git -C "$ROOT" rev-parse --short HEAD)  $(rustc --version 2>/dev/null | cut -d" " -f1-2)  node=$(node -v 2>/dev/null)  logs=$LOGS" | tee -a "$SUMMARY"

# Same order as ci.yml: contracts first (the ledger ABI is vendored, but forge
# test is the contract's own suite), then the Rust lints, tests, book, web.
gate forge         contracts bash -c 'forge build && forge test -vv'
gate clippy        .         cargo clippy --workspace --all-targets -- -D warnings
gate fmt           .         cargo fmt --check
gate cargo-test    .         cargo test --workspace
gate house-book    .         bash -c 'cargo run -q -p book-gen -- assets/house-book.bin && git diff --exit-code --stat assets/house-book.bin'
gate pnpm-install  apps/web  bash -c 'set -o pipefail; corepack enable >/dev/null 2>&1; pnpm install --frozen-lockfile 2>&1 | tee .install.log; rc=$?; if grep -q "Ignored build scripts" .install.log; then rc=1; fi; rm -f .install.log; exit $rc'

# Every test:* script in package.json, not just the ones ci.yml lists — and say
# which ones CI would skip, because a suite nothing runs is a suite that rots.
WEB_TESTS=$(node -e 'for (const k of Object.keys(require(process.argv[1]).scripts)) if (k.startsWith("test:")) console.log(k)' "$ROOT/apps/web/package.json")
if [ -z "$WEB_TESTS" ]; then
  echo "FAIL: found no web test:* scripts (node missing?) — the web suite did not run" | tee -a "$SUMMARY"
  failed=1
fi
for s in $WEB_TESTS; do
  gate "web-$s" apps/web pnpm -s "$s"
  grep -qE "pnpm $s\$" "$ROOT/.github/workflows/ci.yml" || echo "  note: $s is NOT run by ci.yml" | tee -a "$SUMMARY"
done
gate web-build     apps/web  pnpm build

echo "reminder: pnpm build clobbers the next dev cache — rm -rf apps/web/.next before pnpm dev" | tee -a "$SUMMARY"
echo "logs: $LOGS" | tee -a "$SUMMARY"
exit $failed
