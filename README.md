# Machine-vs-Machine Chess Wagering Platform

A chess platform in the spirit of lichess, with a twist: **engines play, and
users wager crypto (USDC on Base) on the outcome.** Because machines play, the
classic cheating problem dissolves — the server is simply the authority on
legality, clock, and result. Players bring their own UCI engine via a client we
ship; money settles non-custodially on-chain.

See [the design plan](~/.claude/plans/i-want-to-make-binary-pelican.md) for the
full architecture and rationale.

## Status

End-to-end and tested: **23 automated tests pass** (15 Rust + 8 Foundry).

| Component | Crate / dir | Status |
|---|---|---|
| Shared wire protocol | `crates/protocol` | ✅ 3 tests |
| Authoritative game engine (shakmaty) | `crates/game-engine` | ✅ 6 tests |
| BYO engine client (UCI + WS play + Polyglot book) | `crates/byo-client` | ✅ vs Stockfish; 3 book tests |
| Game server (WS hub + rooms + 3 modes + SIWE) | `crates/server` | ✅ verified end-to-end |
| Non-custodial escrow + oracle | `contracts/ChessEscrow.sol` | ✅ 8 Foundry tests |
| On-chain settlement + SIWE recovery | `crates/ledger` | ✅ Anvil + recovery tests + live demo |
| Persistence (Postgres) + settlement outbox | `crates/persistence` | ✅ round-trip test + live |
| Web app (create + live spectator + wallet + SIWE) | `apps/web` | ✅ verified in-browser |

**Verified end-to-end:**
- Two BYO clients driving Stockfish play a full game over WebSocket with a
  server-enforced clock; result is detected authoritatively. A Next.js spectator
  renders the live board (chessground), clocks, and SAN move list.
- **Three modes** work: Park/Patzer (offer→accept), Gauntlet (tier queue
  pairing), Tournament (round-robin). All games + full move logs persist to
  Postgres.
- A **wagered** game opens escrow on creation; on finish the result is enqueued
  to a durable **settlement outbox** and a worker signs an EIP-712 result and
  settles it on-chain — verified with a decisive payout (winner +stake−rake).
- **SIWE**: nonce → wallet-signed EIP-4361 → session token; nonce replay rejected.
- A **Polyglot opening book** is consulted client-side before the engine.

### Not yet wired (next steps)
- Redis pub/sub + game-node sharding (today: in-process broadcast, single node)
- Glicko-2 ratings; gauntlet auto-requeue loop; tournament scoring + pool prize
  payout (needs a dedicated contract method)
- Settlement outbox retry/backoff (failed rows are currently terminal)
- Engine profiles + per-move signing in the client (protocol already carries the
  optional `sig` field)

## Prerequisites
- Rust (stable), Foundry (`forge`/`anvil`/`cast`), a UCI engine on PATH
  (`stockfish`), Node/pnpm (web), and Postgres (optional, for persistence).

## Build & test
```bash
# 1. Build contracts FIRST — the `ledger` crate compiles against the Foundry
#    artifacts in contracts/out/ (which are git-ignored).
(cd contracts && forge build && forge test)

# 2. Rust workspace
cargo build
cargo test                      # set DATABASE_URL to also run the persistence test

# 3. Web app
(cd apps/web && pnpm install && pnpm build)
```

## Run the slice

**1. Self-play (no network)** — referee two local engines via the authority:
```bash
cargo run -p byo-client -- selfplay --movetime-ms 50 --initial-secs 30 --max-plies 120
```

**2. Networked game** — server + two clients:
```bash
# terminal 1: server
RUST_LOG=info cargo run -p server

# terminal 2: create a game and grab the tokens
curl -s -X POST http://127.0.0.1:8080/games \
  -H 'content-type: application/json' \
  -d '{"initial_secs":10,"increment_secs":0}'
# -> { "game_id": "...", "white_token": "...", "black_token": "...", ... }

# terminals 3 & 4: connect each engine to its seat
cargo run -p byo-client -- play --game <GAME_ID> --token <WHITE_TOKEN>
cargo run -p byo-client -- play --game <GAME_ID> --token <BLACK_TOKEN>
```
A spectator can connect (read-only, no token) to `ws://127.0.0.1:8080/ws/game/<GAME_ID>`.

**3. Web UI** — create games and watch live in the browser:
```bash
cd apps/web && pnpm install && pnpm dev   # http://localhost:3000
```
Open http://localhost:3000, create a game (copy the two client commands it
prints), launch the two `byo-client play` commands, then click **Watch live**.

**4. On-chain money loop** — the full wagered flow on a local Anvil chain
(deploy → fund → open escrow → play → settle → bankrolls move):
```bash
cargo build && (cd contracts && forge build)
bash scripts/onchain-demo.sh
```
To run the server against a chain yourself, set `RPC_URL`, `ESCROW_ADDR`, and
`ORACLE_KEY`, then create a game with `white_addr` / `black_addr` / `stake`
(USDC base units) in the POST body.

## Layout
```
crates/protocol     shared serde wire types (server + client)
crates/game-engine  authoritative board, clock, result (shakmaty)
crates/byo-client   chess-client: UCI engine driver, selfplay + networked play
crates/server       chess-server: HTTP + WebSocket hub + per-game room actors
contracts/          ChessEscrow.sol (pooled bankroll, EIP-712 signed settlement)
```
