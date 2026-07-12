# CLAUDE.md

Orientation for agents working in this repo. Read [HANDOFF.md](HANDOFF.md) for
the current state + the next big task (multi-node); this file is the quick
build/test/architecture reference.

## What this is
OpenChess — engine-vs-engine chess where bots play and users wager USDC on Base,
non-custodially. Rust monorepo (Cargo workspace) + Next.js web app. **Live on
Base mainnet** (see [DEPLOYMENTS.md](DEPLOYMENTS.md)).

## Build / test / run
```bash
cargo build && cargo test          # set DATABASE_URL to also run the persistence test
(cd contracts && forge test)       # Foundry — 25 tests incl. a solvency invariant
(cd apps/web && pnpm install && pnpm test:book)   # polyglot .bin key vectors
cargo run -p server                # game server on 127.0.0.1:8080
(cd apps/web && pnpm dev)          # web on :3000
```
- Contract ABIs are **vendored** in `crates/ledger/abi/`, so `cargo build` does
  **not** need a prior `forge build`. Re-vendor after editing the contract
  (command in the comment above the `sol!` macros in `crates/ledger/src/lib.rs`).
- Deploy the server with **`./scripts/deploy-server.sh`** — never a bare
  `fly deploy` (it re-adds Fly's HA machine, which breaks this single-node app).

## Layout
```
crates/protocol      shared serde wire types (server + client)
crates/game-engine   authoritative board/clock/result (shakmaty) — the referee
crates/byo-client    native client: UCI driver, selfplay/play/gauntlet, `connect` bot agent
                     (web-driven seats or --auto), Polyglot book, SIWE/link-code auth, login
crates/server        chess-server: axum HTTP + WS hub, per-game room actors, 3 modes, SIWE,
                     bot-agent registry, leaderboard, per-IP rate limiting (ratelimit.rs),
                     owner-gated maintenance/drain switch (admin.rs)
crates/ledger        on-chain settlement (alloy), EIP-712, SIWE recovery
crates/persistence   Postgres (sqlx) + migrations + settlement outbox
contracts/           ChessEscrow.sol (Foundry) — pooled bankroll + EIP-712 settlement
apps/web             Next.js: lobby, in-browser Stockfish 18 (WASM/NNUE) + uploadable
                     Polyglot book (lib/polyglot.ts), wallet/SIWE, bot control, spectator, profiles
```

## Architecture in three sentences
The server runs **one actor task per live game** and is the sole authority on
legality/clock/result (`crates/server/src/room.rs` + `crates/game-engine`).
Engines connect over a WebSocket BYO-engine protocol — the web app is itself a
BYO client running Stockfish WASM (`apps/web/lib/engine.ts` + `lib/play.ts`). On
a finished wagered game the server (oracle) signs an EIP-712 result and a durable
outbox settles it on `ChessEscrow`; funds live in the contract, never a platform
wallet.

## Constraints that WILL bite you
- **Single-node only.** Rooms, lobby, launch tokens, SIWE sessions, the bot-agent
  registry, and the rate-limit buckets are all in-process memory (`main.rs`
  AppState, `matchmaking.rs` Lobby, `auth.rs`, `agents.rs`, `ratelimit.rs`). Run
  exactly one Fly machine (`--ha=false` + `fly scale count 1`). Making it
  multi-node is the next task — see [HANDOFF.md](HANDOFF.md).
- **Rate limiting is per-IP, keyed on `Fly-Client-IP`.** Behind a different
  proxy the fallback header is client-forgeable, so pin header trust to the
  deploy. Limits are env-tunable (`RL_*`); a new HTTP route is unthrottled
  unless you add it to a throttled router (`ratelimit.rs`, `main.rs`).
- **The oracle pays gas.** The server sends `openGame`/`settleGame` from
  `ORACLE_KEY`; that address needs Base ETH or wagered games fail closed.
- **Money paths fail closed.** No wager is accepted unless on-chain settlement is
  configured; seats are bound to the SIWE-authenticated wallet, never a request
  body. Keep it that way.
- **Maintenance/drain is owner-gated + fail-closed.** `POST /admin/maintenance`
  only accepts a SIWE session whose wallet equals the on-chain escrow `owner()`
  (set `ADMIN_WALLET` to override, e.g. local dev — else nobody is admin). When
  on, `AppState::start_game` and every create endpoint (incl. tournament pool
  create/join) `503`; the flag is DB-persisted (`server_settings`) so it
  survives the restart it was set to protect. Any **new** game-creating or
  money-committing route must call `state.reject_if_draining()?` — the drain is
  per-entry-point, not global middleware.
- **`pnpm build` clobbers the `next dev` cache** (→ `/_next/static` 404s). If the
  dev preview breaks after a build: `rm -rf apps/web/.next` and restart it.
- **Never emit a private/oracle key** to output/logs. The oracle key is the
  crown jewel; a leak lets anyone forge results and drain stakes.

## Conventions
- Money is `rust_decimal` / `U256` — never `f64`. USDC has 6 decimals.
- IDs are UUIDs. Time controls are `{initial_secs, increment_secs}`.
- **Bot seats** work in all 3 modes: a seat is played by the in-browser engine
  or a connected agent (`SeatDelivery::{Browser,Agent}` in `start_game`), claimed
  per game. **Tournaments dispatch round-by-round** (circle method,
  `matchmaking.rs`), so a single-agent bot only ever plays one game at once; an
  offline bot at a round's dispatch forfeits that pairing.
- **Forfeit vs rating:** a no-show/forfeit loses the stake or buy-in, but a game
  is **rated (Elo) only if both sides made ≥1 move** (`ply >= 2`, guarded in
  `room.rs finish()`) — never ding rating for a game a player didn't play.
- End commit messages with the `Co-Authored-By: Claude …` trailer.
