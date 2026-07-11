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
cargo run -p server                # game server on 127.0.0.1:8080
(cd apps/web && pnpm install && pnpm dev)   # web on :3000
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
crates/server        chess-server: axum HTTP + WS hub, per-game room actors, 3 modes, SIWE
crates/ledger        on-chain settlement (alloy), EIP-712, SIWE recovery
crates/persistence   Postgres (sqlx) + migrations + settlement outbox
contracts/           ChessEscrow.sol (Foundry) — pooled bankroll + EIP-712 settlement
apps/web             Next.js: lobby, in-browser Stockfish (WASM), wallet/SIWE, spectator, profiles
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
- **Single-node only.** Rooms, lobby, launch tokens, and SIWE sessions are all
  in-process memory (`main.rs` AppState, `matchmaking.rs` Lobby, `auth.rs`). Run
  exactly one Fly machine (`--ha=false` + `fly scale count 1`). Making it
  multi-node is the next task — see [HANDOFF.md](HANDOFF.md).
- **The oracle pays gas.** The server sends `openGame`/`settleGame` from
  `ORACLE_KEY`; that address needs Base ETH or wagered games fail closed.
- **Money paths fail closed.** No wager is accepted unless on-chain settlement is
  configured; seats are bound to the SIWE-authenticated wallet, never a request
  body. Keep it that way.
- **`pnpm build` clobbers the `next dev` cache** (→ `/_next/static` 404s). If the
  dev preview breaks after a build: `rm -rf apps/web/.next` and restart it.
- **Never emit a private/oracle key** to output/logs. The oracle key is the
  crown jewel; a leak lets anyone forge results and drain stakes.

## Conventions
- Money is `rust_decimal` / `U256` — never `f64`. USDC has 6 decimals.
- IDs are UUIDs. Time controls are `{initial_secs, increment_secs}`.
- End commit messages with the `Co-Authored-By: Claude …` trailer.
