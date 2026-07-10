# OpenChess

**Machines play. You wager.** An engine-vs-engine chess platform in the spirit
of lichess, with a twist: **bots play, and users stake USDC on Base** — settled
non-custodially. Because engines play, the classic cheating problem dissolves —
the server is simply the authority on legality, clock, and result. Players bring
their own UCI engine (or use the Stockfish that runs in the browser); money
settles on-chain, in a contract, never a platform wallet.

**Live:** <https://openchess.ai>

---

## What it does

- **Casual lobby (free, fully in-browser).** Pick a time control (1+0 / 3+0 /
  5+0 / 10+0) and play instantly against the house, open a challenge for another
  player's engine, or **watch live games**. Two Stockfish engines compiled to
  **WASM** play on *your* CPU — zero download, zero server compute. A curated
  opening book (from [official-stockfish/books](https://github.com/official-stockfish/books))
  makes openings instant and varied.
- **Wager modes (USDC on Base, non-custodial).**
  - **Park / Patzer** — post a game at a stake; someone accepts; winner takes the
    pot minus rake. Deposit + play **in the browser**.
  - **Gauntlet** — your engine plays back-to-back games at a fixed tier until you
    stop; each an independent on-chain settlement against a locked bankroll.
  - **Tournament** — buy in to a prize pool; a round-robin runs; the pool is
    distributed on-chain by final standings (direct, or a Merkle-root claim for
    large fields).
- **Player profiles** — per-address stats (games, W/L/D, win rate, net USDC,
  Elo) and game history, chess.com-style, at `/player/<address>`.
- **Verifiable results** — the oracle signs each result; the web app recovers the
  signer against the published `/oracle` address and shows a "✓ Verified" badge.

## How it works (one paragraph)

Rust monorepo (Cargo workspace). The **game server** (axum + tokio) runs one
actor task per live game and is the sole authority on move legality
([shakmaty](https://github.com/niklasf/shakmaty)), the clock, and the result.
Engines connect over WebSocket through a **bring-your-own-engine** protocol — the
web app is itself a BYO client driving Stockfish WASM (`apps/web/lib/engine.ts`
+ `lib/play.ts`), and power users can point the native client at any UCI engine.
On a finished wagered game the server (acting as the result **oracle**) signs an
EIP-712 result and settles it on the non-custodial **`ChessEscrow`** contract via
a durable transactional outbox. Funds live in the contract; the chain enforces
`bankroll − lockedExposure` withdrawal limits, address-bound payouts, replay
guards, and settlement timeouts. See **[ARCHITECTURE.md](ARCHITECTURE.md)** for
system / flow / data diagrams.

## Repo layout

```
crates/protocol      shared serde wire types (server + client)
crates/game-engine   authoritative board, clock, result (shakmaty)
crates/byo-client    chess-client: UCI driver, selfplay + networked play, Polyglot book
crates/server        chess-server: HTTP + WS hub + per-game room actors, 3 modes, SIWE
crates/ledger        on-chain settlement (alloy), EIP-712 results, SIWE recovery
crates/persistence   Postgres (sqlx) + migrations + settlement outbox
contracts/           ChessEscrow.sol (Foundry) — pooled bankroll + EIP-712 settlement
apps/web             Next.js UI: lobby, in-browser WASM engine, wallet/SIWE, spectator, profiles
scripts/             onchain-demo.sh, tournament-demo.sh (local Anvil money-loop demos)
Dockerfile, fly.toml server deploy;  .github/workflows/ci.yml  CI
```

## Status

**43 automated tests pass** (21 Rust + 22 Foundry). Three audit rounds
([AUDIT.md](AUDIT.md)) with the Critical/High findings remediated. CI
(`.github/workflows/ci.yml`) runs Postgres + `forge test` + `cargo test` + the
web build on every push.

| Component | Dir | Status |
|---|---|---|
| Shared wire protocol | `crates/protocol` | ✅ 3 tests |
| Authoritative game engine (shakmaty) | `crates/game-engine` | ✅ 6 tests |
| BYO engine client (UCI + WS play + Polyglot book) | `crates/byo-client` | ✅ vs Stockfish + book tests |
| Game server (WS hub + rooms + 3 modes + SIWE + lobby) | `crates/server` | ✅ live + unit tests |
| Non-custodial escrow + oracle (games + tournament pools) | `contracts/ChessEscrow.sol` | ✅ 22 Foundry tests |
| On-chain settlement + SIWE recovery | `crates/ledger` | ✅ Anvil + recovery tests |
| Persistence (Postgres) + settlement outbox | `crates/persistence` | ✅ round-trip + live |
| Web app (lobby, in-browser WASM engine, spectator, profiles) | `apps/web` | ✅ verified in-browser |

**This is not a turnkey production deployment.** Several items are ops/legal
decisions only the operator can make — an **independent contract audit**, the
**oracle key in a KMS/HSM behind a multisig+timelock**, single-node infra, and a
**legal/regulatory review** for real-money gaming. See
**[PRODUCTION.md](PRODUCTION.md)** for the full go-live checklist and the honest
list of known limitations (single-node only; in-browser wagering is live for
Park, native-client for Gauntlet/Tournament; no anti-collusion controls yet).

## Run it locally

**Prerequisites:** Rust (stable, ≥ 1.91 — required by `alloy`), Foundry
(`forge`/`anvil`/`cast`), Node + pnpm, a UCI engine on PATH (`stockfish`), and
Postgres (optional, for persistence).

```bash
# Rust workspace — contract ABIs are vendored (crates/ledger/abi), so this
# builds without a prior `forge build`.
cargo build
cargo test                 # set DATABASE_URL to also run the persistence test

# Contracts
(cd contracts && forge test)

# Web app + server (casual play needs only the server running)
cargo run -p server                        # terminal 1  → 127.0.0.1:8080
cd apps/web && pnpm install && pnpm dev     # terminal 2  → http://localhost:3000
```

Open <http://localhost:3000> → pick a time control → **Play now** runs two
in-browser engines against the live server with no setup. The homepage is the
casual lobby (create / join / watch); `/player/<address>` shows profiles.

### Demo flows

```bash
# Self-play (no network): referee two local engines via the authority
cargo run -p byo-client -- selfplay --movetime-ms 50 --initial-secs 30 --max-plies 120

# Networked game: create one, then connect each engine to its seat
curl -s -X POST http://127.0.0.1:8080/games -H 'content-type: application/json' \
  -d '{"initial_secs":10,"increment_secs":0}'          # -> game_id + white/black tokens
cargo run -p byo-client -- play --game <GAME_ID> --token <WHITE_TOKEN>
cargo run -p byo-client -- play --game <GAME_ID> --token <BLACK_TOKEN>
# spectate read-only (no token): ws://127.0.0.1:8080/ws/game/<GAME_ID>

# Full on-chain money loop (Park/Patzer) on a local Anvil chain
cargo build && (cd contracts && forge build) && bash scripts/onchain-demo.sh

# Gauntlet — back-to-back games at a tier
chess-client gauntlet --count 5 --initial-secs 8 --increment-secs 0
#   staked: add --stake <usdc-base-units> --auth-token <siwe-session>

# Tournament — staked buy-in pool distributed by standings on Anvil (65/25/10)
bash scripts/tournament-demo.sh
```

Wagered games go through the authenticated Park/Gauntlet/Tournament flows (each
seat bound to the SIWE-signed-in wallet); the server needs `RPC_URL` /
`ESCROW_ADDR` / `ORACLE_KEY` (+ `SIWE_DOMAIN` / `SIWE_CHAIN_ID`) set — see the
demo scripts and [PRODUCTION.md](PRODUCTION.md) for the exact env.

## Deploy

- **Web** → **Vercel**, Root Directory `apps/web` (env: `NEXT_PUBLIC_SERVER_HTTP`,
  `NEXT_PUBLIC_SERVER_WS`, `NEXT_PUBLIC_WC_PROJECT_ID`).
- **Game server** → **Fly** (`Dockerfile` + `fly.toml`) — a single stateful
  machine (`fly scale count 1`); it can't run on Vercel (long-lived WebSockets).
- **Contract** → Base via `contracts/script/Deploy.s.sol` (auto-picks Base
  mainnet / Base Sepolia USDC).

Full runbook — including the Base Sepolia testnet path and every env var — is in
**[PRODUCTION.md](PRODUCTION.md)**.

## Security model / trust boundary

You trust the server's **result correctness** (which it controls anyway, as the
engine and referee), never its **custody**. Funds never touch a platform wallet:
they live in `ChessEscrow`, and the chain enforces the withdrawal ceiling,
address-bound payouts, per-game replay guards, and a `claimTimeout`/`claimRefund`
safety net if the oracle ever goes silent. Wager endpoints require a full
EIP-4361 (SIWE) session and derive each staked seat from the authenticated
wallet — never the request body. A full on-chain dispute window (optimistic
settlement) and a multisig/threshold oracle are documented next steps in
[PRODUCTION.md](PRODUCTION.md). Details + audit history in **[AUDIT.md](AUDIT.md)**.

## Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — system, flow, and data diagrams.
- **[PRODUCTION.md](PRODUCTION.md)** — go-live checklist, deploy runbooks, env, limits.
- **[AUDIT.md](AUDIT.md)** — three audit rounds and remediations.

## License

See [LICENSE](LICENSE). Bundled Stockfish (GPLv3) is used unmodified as a
separate UCI process; the in-browser build is Stockfish WASM.
