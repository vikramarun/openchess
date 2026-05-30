# Machine-vs-Machine Chess Wagering Platform

A chess platform in the spirit of lichess, with a twist: **engines play, and
users wager crypto (USDC on Base) on the outcome.** Because machines play, the
classic cheating problem dissolves — the server is simply the authority on
legality, clock, and result. Players bring their own UCI engine via a client we
ship; money settles non-custodially on-chain.

See [the design plan](~/.claude/plans/i-want-to-make-binary-pelican.md) for the
full architecture and rationale.

## Status

End-to-end and tested: **30 automated tests pass** (16 Rust + 14 Foundry). A
full security audit ([AUDIT.md](AUDIT.md)) was performed and the Critical/High
findings remediated (see *Security hardening* below).

| Component | Crate / dir | Status |
|---|---|---|
| Shared wire protocol | `crates/protocol` | ✅ 3 tests |
| Authoritative game engine (shakmaty) | `crates/game-engine` | ✅ 6 tests |
| BYO engine client (UCI + WS play + Polyglot book) | `crates/byo-client` | ✅ vs Stockfish; 3 book tests |
| Game server (WS hub + rooms + 3 modes + SIWE) | `crates/server` | ✅ live demos; 2 unit tests |
| Non-custodial escrow + oracle | `contracts/ChessEscrow.sol` | ✅ 14 Foundry tests |
| On-chain settlement + SIWE recovery | `crates/ledger` | ✅ Anvil + recovery tests + live demo |
| Persistence (Postgres) + settlement outbox | `crates/persistence` | ✅ round-trip test + live |
| Web app (create + live spectator + wallet + SIWE) | `apps/web` | ✅ verified in-browser |

**Verified end-to-end:**
- Two BYO clients driving Stockfish play a full game over WebSocket with a
  server-enforced clock; result is detected authoritatively. A Next.js spectator
  renders the live board (chessground), clocks, and SAN move list.
- **Wagered games are authenticated**: SIWE sign-in → authenticated Park
  offer/accept where each on-chain seat's **staked address** is the signed-in
  wallet (fixed at escrow open) → escrow opened → engines play → result enqueued
  to a durable, retrying **settlement outbox** → a worker signs a time-bounded
  EIP-712 result and settles on-chain. Verified live (decisive payout and draw
  refund) via `scripts/onchain-demo.sh`. (Launch tokens remain bearer
  capabilities to *play* a seat — they can't redirect winnings; wallet-bound
  single-use tokens are a follow-up.)
- **Modes:** Park/Patzer is complete. Gauntlet is a fixed-tier queue that pairs
  the next two arrivals (continuous "play-until-you-stop" re-queue is **not yet**
  implemented). Tournament generates round-robin **pairings only** — scoring and
  pool prize payout are **not yet** wired.

### Security hardening (post-audit)
- Wager endpoints require a SIWE session; seats derive from the authenticated
  wallet (never the request body); identical seats rejected.
- Contract: `white != black`, fee-recipient can't play, SafeERC20-style
  transfers + deposit delta, `Ownable2Step` + `Pausable`, time-bounded results
  (`deadline`) with a fork-safe domain separator, rake snapshot at open.
- Settlement: transactional finish+enqueue, retry with attempt cap + stale-row
  reaper, idempotent "already settled" handling, fail-closed (no wager without
  on-chain settlement / on escrow-open failure).
- Auth/DoS: full EIP-4361 verification (domain/chainId/address match), single-use
  nonces + TTL, session TTL, evicted lobby/room/token state, restricted CORS,
  input bounds, SHA-256 result commitment.

### Not yet wired (next steps)
- Redis pub/sub + game-node sharding (today: in-process broadcast, single node)
- Glicko-2 ratings; gauntlet auto-requeue loop; tournament scoring + pool prize
  payout (needs a dedicated contract method)
- Result signature (`server_sig`) surfaced to clients; multisig/threshold oracle
- Anti-collusion / wash-trading controls; per-move client signing; wss/TLS in
  deployment; tokens off the WS query string

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
