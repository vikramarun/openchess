---
name: test-openchess
description: Test an OpenChess branch or PR before merge — CI's exact gates run locally (continuing past failures), a live money-path E2E on a throwaway Anvil chain (staked games, forfeits, tournaments, crash recovery, the shutdown drain), an ABI-compatibility check against the escrow that is actually deployed, a browser smoke test, and the adversarial review checklist that has caught this repo's worst bugs. Use when asked to test, verify, or sign off a branch/PR, or before merging anything touching crates/server, crates/ledger, crates/persistence, contracts/ or money paths.
---

# Testing OpenChess

Real USDC settles through this code, so "the tests pass" is not the bar. The
bar is: CI's gates are green **as CI runs them**, the money paths work end to
end on a real chain, the server still talks to the contract that is actually
deployed, and the change has been reviewed for what it *breaks*, not just for
what it fixes. Report findings with **P0/P1/P2** severities.

Scripts live in `.claude/skills/test-openchess/scripts/`. Each takes the
checkout to test as an argument, so you can run them from `main` against a PR
worktree whose branch doesn't contain this skill.

## 0. Isolate the branch

```bash
git worktree add .claude/worktrees/pr-<N> <branch>     # or: gh pr checkout <N> inside a fresh worktree
```

Never point anything here at production: not the Fly DB, not Base mainnet,
not the `chess` dev database. The scripts ALWAYS create and drop their own
scratch databases and ignore `DATABASE_URL` — "localhost" is not "safe": the
`chess` dev DB and a `fly proxy` tunnel to prod are both localhost, and the
tests apply the branch's migrations to whatever they touch. (A PR's migrations
once ran against prod early and crash-looped the next deploy.) They also scrub
`RPC_URL`/`ESCROW_ADDR`/`ORACLE_KEY`/`ALERT_WEBHOOK_URL` from the environment,
since `cargo test` builds a real onchain sink from them when set.

## 1. CI gates — `scripts/ci-gates.sh <worktree> [log-dir]`

Runs forge, clippy, `cargo fmt --check`, `cargo test --workspace` (with a
scratch Postgres so the persistence tests really run), the house-book diff, the
frozen pnpm install, **every** `test:*` script in `apps/web/package.json`
(flagging any `ci.yml` doesn't run), and `pnpm build`. About 4–6 minutes.

- **Check the PR's actual CI too** (`gh pr checks <N>`, `gh run view <id>
  --log-failed`). CI stops at the first red step, so a `fmt` failure means
  `cargo test`, the book check and the entire web suite **never ran in CI** —
  a PR description's "all tests pass" is then a local claim only.
- **CI uses the NEWEST stable Rust** (`dtolnay/rust-toolchain@stable`); a new
  clippy lint can turn `main` red overnight with no code change (1.99 did).
  If your stable is older, run the gates on the latest too:
  `rustup toolchain install <ver> --profile minimal -c clippy -c rustfmt`, then
  `RUSTUP_TOOLCHAIN=<ver> scripts/ci-gates.sh …`. The summary prints the rustc
  it used.
- Known local-only failure: `test:avatar` crashes inside tsx's loader on Node
  ≥ 26 ("URL is not a constructor"). Before blaming a branch for a web test,
  run the same test on `main`.
- `pnpm build` clobbers the `next dev` cache: `rm -rf apps/web/.next` before
  starting a dev server in that checkout.

## 2. ABI compatibility — `scripts/abi-compat.sh <worktree> [live-ref]`

Required whenever `contracts/` or `crates/ledger/abi/` changes. Deploys the
**live** escrow's bytecode (from `live-ref`, default `origin/main`) and drives
the branch's `OnchainSettlement` against it: games, tournaments settled both
directly and by Merkle root, and the reads behind them. An operation it
doesn't list isn't covered — add new ledger operations to the script. The contract is
redeployed far less often than the server, so the server must work against the
old bytecode until it is.

Pick `live-ref` from the chain, not from memory:
`scripts/verify-deployed.py <escrow-address> --ref <ref>` compares the deployed
runtime code with that ref's vendored artifact, masking immutables. It exits 0
when they match, and lists ABI functions the deployment lacks. The address
production uses is `escrow` in `GET https://openchess.fly.dev/config` (or the
`ESCROW_ADDR` Fly secret). DEPLOYMENTS.md has also listed a superseded v1 and a
mistaken deployment of v1 bytecode, so check it every time.

Why it exists: adding a field to the `Tournament` struct made every
`tournaments()` read fail to decode against the live escrow ("buffer overrun"),
which surfaced as `None`/`false` — tournament creation failed, pools could not
be read for payout, settled pools looked unsettled — while the PR said "deploy
order does not matter" and its probe test used MockUSDC as the stand-in for the
old contract. **A stand-in contract proves nothing about decoding.**

Also check the clients that don't go through the ledger crate:
- `apps/web/lib/escrow.ts`, `components/TournamentClaim.tsx`,
  `components/SponsorPool.tsx`, `lib/sponsorships.ts` hand-write ABI fragments
  and deadline math (`openedAt + settleTimeout`). A struct or clock change in
  the contract needs them updated in the same release.
- `scripts/onchain-demo.sh` and `scripts/tournament-e2e.py` deploy the escrow
  with explicit constructor args.

## 3. Live money paths — `scripts/e2e-money.py --repo <worktree>`

Fresh Anvil (port 18545), escrow compiled from the worktree (constructor args
and the `tournaments()` layout are read from the compiled ABI), scratch DB,
real `chess-server` (port 18080) and `chess-client` + Stockfish. About 6–8 minutes.
`--only a,b` picks tests.

| test | proves |
|---|---|
| `staked-settle` | a staked park game settles through the outbox; funds conserved, nothing left locked |
| `staked-forfeit` | a no-show is reaped after 60s and the present player is paid the pot (a DECISIVE payout) |
| `tourney-settle` | a 3-entrant buy-in round-robin distributes its pool onchain |
| `tourney-abandon` | SIGKILL mid-event → reboot marks it abandoned → entrants `claimRefund` |
| `drain-staked` | SIGINT (a Fly deploy) mid staked game → refund enqueued durably → paid on next boot, inside `kill_timeout` |
| `drain-tourney` | SIGINT during a tournament's final round must NOT complete/settle the event on the drain's aborted draw |

`drain-tourney` is a **race** — whether the drained outcome reaches the
tournament before exit depends on how many other rooms the drain is ending — so
it runs several trials at increasing load (`--drain-loads`). One clean trial
proves nothing.

Every test proves its scenario actually happened, because the failure mode of a
money test is passing on nothing: `staked-settle` fails on a forfeit or an
abort (both also "settle and conserve funds", and a broken acceptor produces
exactly that), and checks the payout matches the board; `drain-tourney` checks
the event was running and its game was drained. The run refuses to start if its
ports are taken (a stale run would answer for it), cleans up on SIGTERM/SIGHUP,
and must not be run with `python -O` (it is all asserts).

Reading results: bankroll is total deposits; a *game* stake is tracked in
`locked`, so check `available()` for game locks. A tournament *entry* moves
funds out of `bankroll`.

## 4. Browser smoke (web, `ws.rs` or `room.rs` changes)

The preview tool launches from the **main** checkout's `.claude/launch.json`,
not the worktree — it will happily test `main`. Add temporary configs that
point at the worktree, and revert them afterwards:

```json
{"name":"server-pr","runtimeExecutable":"cargo","runtimeArgs":["run","--manifest-path","<worktree>/Cargo.toml","-p","server"],"port":8080},
{"name":"web-pr","runtimeExecutable":"pnpm","runtimeArgs":["-C","<worktree>/apps/web","dev"],"port":3000}
```

Confirm in `preview_logs` that it compiled from the worktree path. Then open
`/play` (public, no sign-in), pick **1+0**, and let two in-browser engines
finish a game. Bullet has the highest frame rate, so it exercises inbound rate
limits and non-blocking sends. Afterwards, grep the server log for `dropping a
frame`, `not draining`, `rejected`.

## 5. Review — adversarially, and review the fixes too

Run `/code-review <N>` at high effort or above, then work this checklist. Every
item has caught a real bug here:

- **Review the fix as hard as the code.** For each claimed fix: what does it
  break? A fix that registers state early (routing, a record) must also
  unregister it on every failure path after that point. An abort that evicts a
  room but leaves `t.games`/`game_to_tournament` populated stalls a round
  forever.
- **Does every client satisfy the new contract?** Web hardcoded ABIs, the
  native client (`chess-client`), the house bot (`scripts/house-bot.sh`),
  the repo's own scripts, and DEPLOYMENTS.md's instructions.
- **Error → default is a decision.** Every `.ok()`, `.is_ok()`,
  `unwrap_or(..)`, `Err(_) => false` on an RPC read: does a transient error
  become a confident wrong answer, and is it cached for the process lifetime?
- **What consumes `results_tx`?** Any new way to end a game (shutdown drain,
  abort, reap) also feeds tournament standings and gauntlet stats through
  `record_outcome`. Ask whether that outcome should be *scored*.
- **Is the guard on the input or on the trust?** And does the server still
  accept new work while it is shutting down or draining?
- **A regression test must fail with its fix reverted.** Prove it by running it
  on `main`, e.g. in a detached worktree (`git worktree add --detach <dir> main`).
  Note `main` may lack dev-deps the branch added, such as tokio `test-util`.
- **Asymmetric fixes.** If park got a guard, check whether queue, gauntlet and
  tournament need the same one.

Reproduce each finding with a throwaway test (a scratch `#[tokio::test]`
appended to the module, or an integration test under `crates/*/tests/`), save
it as a patch in your scratchpad, then restore the worktree (`git checkout --
<file>`). Never commit scratch tests to the PR.

## 6. Clean up

Stop previews, revert any `launch.json` edits, remove scratch worktrees and
databases (`dropdb`), and leave the PR worktree clean (`git status`).

## Multi-agent version

`.claude/workflows/test-openchess-pr.js` runs this as a workflow: one runtime
agent (steps 1–3), four review lenses (money/onchain, concurrency/lifecycle,
client-contract, fix-regression), and one verifier per lens that reproduces
each finding with a test. It uses about 9 agents. Ask for it explicitly, e.g.
"run the test-openchess-pr workflow on PR 64".
