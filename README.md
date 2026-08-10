# OpenChess

**Machines play. You back yours.** An engine-vs-engine chess platform in the
spirit of lichess, with a twist: **bots play, and users stake USDC on Base**,
settled non-custodially. Because engines play, the classic cheating problem
dissolves, and the server is simply the authority on legality, clock, and
result. Players bring their own UCI engine, or use the Stockfish that runs in
the browser. Money settles onchain, in a contract, never a platform wallet.

**Live:** <https://openchess.ai> · **`ChessEscrow` v2 on Base mainnet:**
[`0x7a53…4D68`](https://basescan.org/address/0x7a536bef5cd9694acaed7bc5fe65e463db5d4d68)
(source verified on Basescan; see [DEPLOYMENTS.md](DEPLOYMENTS.md) for parameters
and the superseded v1).
New here? Start with **[HANDOFF.md](HANDOFF.md)**.

> **Status:** deployed and running, but **single-node** (one Fly machine) and
> **not independently audited**, so stakes are capped at 25 USDC. Making it
> multi-node (true HA) is the next task; see [HANDOFF.md](HANDOFF.md).

---

## What it does

- **Casual lobby (free, fully in-browser).** Pick a time control (1+0 / 3+0 /
  5+0 / 10+0) and play the OpenChess bot right away, open a challenge for another
  player's engine, or **watch live games**. Two Stockfish engines compiled to
  **WASM** play on *your* CPU, with nothing to install and zero server compute. A curated
  opening book (from [official-stockfish/books](https://github.com/official-stockfish/books))
  makes openings instant and varied.
- **Staked modes (USDC on Base, non-custodial).**
  - **Park / Patzer.** Post a game at a stake; someone accepts; the winner takes
    the pot minus rake. Deposit and play **in the browser**.
  - **Gauntlet.** Your engine plays back-to-back games at a fixed tier until you
    stop, each an independent onchain settlement against a locked balance.
  - **Tournament.** Pay one entry into a prize pool. A round-robin runs **one
    round at a time** (circle method) and the pool is distributed onchain by
    final standings, either directly or as a Merkle-root claim for large fields.
  - **Bring your own bot.** In every mode a seat can be played by the in-browser
    engine or by a connected `chess-client` agent, driven from the web.
- **Player profiles.** Per-address stats (games, W/L/D, win rate, net USDC, Elo)
  and game history, chess.com-style, at `/player/<username-or-address>`.
- **Verifiable results.** The oracle signs each result, and the web app recovers
  the signer against the published `/oracle` address and shows a "✓ Verified" badge.

## How it works (one paragraph)

Rust monorepo (Cargo workspace). The **game server** (axum + tokio) runs one
actor task per live game and is the sole authority on move legality
([shakmaty](https://github.com/niklasf/shakmaty)), the clock, and the result.
Engines connect over WebSocket through a **bring-your-own-engine** protocol. The
web app is itself a BYO client driving Stockfish WASM (`apps/web/lib/engine.ts`
+ `lib/play.ts`), and power users can point the native client at any UCI engine.
On a finished staked game the server (acting as the result **oracle**) signs an
EIP-712 result and settles it on the non-custodial **`ChessEscrow`** contract via
a durable transactional outbox. Funds live in the contract; the chain enforces
`bankroll − lockedExposure` withdrawal limits, address-bound payouts, replay
guards, and settlement timeouts. See **[ARCHITECTURE.md](ARCHITECTURE.md)** for
system / flow / data diagrams.

## Repo layout

```
crates/protocol      shared serde wire types (server + client)
crates/game-engine   authoritative board, clock, result (shakmaty)
crates/byo-client    chess-client: UCI driver, selfplay/play/gauntlet, `connect` bot agent,
                     Polyglot book, SIWE/link-code auth
crates/server        chess-server: HTTP + WS hub + per-game room actors, 3 modes, SIWE
crates/ledger        onchain settlement (alloy), EIP-712 results, SIWE recovery
crates/persistence   Postgres (sqlx) + migrations + settlement outbox
crates/book-gen      dev tool: builds assets/house-book.bin from a SAN repertoire
contracts/           ChessEscrow.sol (Foundry): pooled balances + EIP-712 settlement
apps/web             Next.js UI: lobby, in-browser WASM engine, wallet/SIWE, spectator, profiles
scripts/             deploy-server.sh (the ONLY way to deploy the server), house-bot.sh,
                     onchain-demo.sh (1v1), tournament-demo.sh + tournament-e2e.py
                     (settled + abandoned tournament money-loop, real Postgres)
Dockerfile, fly.toml server deploy;  .github/workflows/ci.yml  CI
```

## Status

CI (`.github/workflows/ci.yml`) runs the full test surface on every push:
the Rust workspace (`cargo test`, ~200 tests), 34 Foundry tests (including a
128k-call solvency invariant), all 29 web suites (`pnpm test:*`), clippy/fmt,
and the web build, against a real Postgres. Four audit rounds
([AUDIT.md](AUDIT.md)) with the Critical/High findings remediated.

| Component | Dir | Status |
|---|---|---|
| Shared wire protocol | `crates/protocol` | ✅ unit tests |
| Authoritative game engine (shakmaty) | `crates/game-engine` | ✅ unit tests |
| BYO engine client (UCI + WS play + Polyglot book) | `crates/byo-client` | ✅ vs Stockfish + book tests |
| Game server (WS hub + rooms + 3 modes + SIWE + lobby + rate limiting) | `crates/server` | ✅ live + unit tests |
| Non-custodial escrow + oracle (games + tournament pools + sponsorship) | `contracts/src/ChessEscrow.sol` | ✅ 34 Foundry tests |
| Onchain settlement + SIWE recovery | `crates/ledger` | ✅ Anvil + recovery tests |
| Persistence (Postgres) + settlement outbox | `crates/persistence` | ✅ round-trip + live |
| Web app (lobby, in-browser WASM engine, spectator, profiles, leaderboard) | `apps/web` | ✅ verified in-browser + 29 test suites |

**This is not a turnkey production deployment.** Several items are ops/legal
decisions only the operator can make: an **independent contract audit**, the
**oracle key in a KMS/HSM behind a multisig+timelock**, single-node infra, and a
**legal/regulatory review** for real-money gaming. See
**[PRODUCTION.md](PRODUCTION.md)** for the full go-live checklist and the honest
list of known limitations (single-node only; no anti-collusion controls yet).

## Run it locally

**Prerequisites:** Rust (stable, ≥ 1.91, required by `alloy`), Foundry
(`forge`/`anvil`/`cast`), Node + pnpm, a UCI engine on PATH (`stockfish`), and
Postgres (optional, for persistence).

```bash
# Rust workspace. Contract ABIs are vendored (crates/ledger/abi), so this
# builds without a prior `forge build`.
cargo build
cargo test                 # set DATABASE_URL to also run the persistence test

# Contracts
(cd contracts && forge test)

# Web app + server (casual play needs only the server running)
cargo run -p server                        # terminal 1  → 127.0.0.1:8080
cd apps/web && pnpm install && pnpm dev     # terminal 2  → http://localhost:3000
```

Open <http://localhost:3000> → **Test Engine** (`/play`) runs two in-browser
engines against the live server with no setup and **no account** — it is the one
surface that needs neither. Playing anyone else does need one: the homepage's
Play card, `/lobby` (create / join / watch), `/gauntlet` and `/tournament` are
behind a sign-in gate on the client and a session check on the server, because
each seats a real player in a game that lands in a history and moves an Elo.
Shared game links (`/game/<id>`) and profiles (`/player/<username-or-address>`)
stay public.

The in-browser bot is personalizable with **no download** (Profile → Advanced →
"Your browser bot"): an **opening repertoire** — four slots (White, and Black vs
1.e4 / 1.d4 / anything else) filled from built-in Polyglot books and defaulting
to all of them — and a thinking style. Books are parsed and probed in the
browser via `apps/web/lib/polyglot.ts`, whose Zobrist keys match the native
client's byte-for-byte (`pnpm -C apps/web test:book` checks against the spec
vectors). Bringing your *own* `.bin` is the downloadable `chess-client`'s job
(`--book`), along with full-strength engines, GPU nets and 24/7 bots.

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

# Full onchain money loop (Park/Patzer) on a local Anvil chain
cargo build && (cd contracts && forge build) && bash scripts/onchain-demo.sh

# Gauntlet: back-to-back games at a tier. Needs a signed-in wallet even when
# free (its games land in your record): set OPENCHESS_WALLET_KEY, or pass
# --auth-token from `chess-client login`.
chess-client gauntlet --count 5 --initial-secs 8 --increment-secs 0
#   staked: add --stake <usdc-base-units>

# Connect: put YOUR engine (+ optional Polyglot book) online as a bot bound
# to your wallet, then drive it from the website: start/join lobby games there
# and the seat is pushed to this process (the playchess/lichess-bot model).
# The web /connect page generates this command with a single-use pairing code.
# Prebuilt binaries (no Rust needed): https://github.com/vikramarun/openchess/releases
# (published by .github/workflows/release.yml; see its header for cutting one)
chess-client connect --server https://openchess.fly.dev \
  --engine stockfish --book ./book.bin --name "TalBot 9000" \
  --uci-option "Threads=4" --code <pairing-code-from-web>
#   auth alternatives to --code: --auth-token <session>, or
#   OPENCHESS_WALLET_KEY=... (headless; the client signs SIWE locally,
#   `chess-client login` prints a session token for scripting)
#   unattended matchmaking instead of web-driven: add --auto
#     [--stake <usdc-base-units> --initial-secs N --increment-secs N --games N]

# Tournament, live E2E: settled pool distributed by standings (65/25/10) AND
# an abandoned tournament recovered via onchain claimRefund (real Postgres).
bash scripts/tournament-demo.sh   # wraps scripts/tournament-e2e.py

# House bot: keep the park populated so visitors always have an opponent.
# SEATS (default 2) casual autopilots per lobby time control under one
# (UNFUNDED) wallet, at full strength — there is no skill knob on purpose.
OPENCHESS_WALLET_KEY=0x... ./scripts/house-bot.sh
# ...or run it 24/7 as its own Fly app (stockfish + chess-client in one image):
#   fly apps create openchess-housebot --org personal
#   fly secrets set --stage -a openchess-housebot OPENCHESS_WALLET_KEY=0x... # UNFUNDED
#   fly deploy --config fly.housebot.toml --ha=false && fly scale count 1 -a openchess-housebot
# (--stage is required on the first secret: the app has no machines to push it
#  to yet. See the header of fly.housebot.toml.)
```

Staked games go through the authenticated Park/Gauntlet/Tournament flows, each
seat bound to the SIWE-signed-in wallet. The server needs `RPC_URL` /
`ESCROW_ADDR` / `ORACLE_KEY` (+ `SIWE_DOMAIN` / `SIWE_CHAIN_ID`) set; see the
demo scripts and [PRODUCTION.md](PRODUCTION.md) for the exact env.

## Deploy

- **Web** → **Vercel**, Root Directory `apps/web` (env: `NEXT_PUBLIC_SERVER_HTTP`,
  `NEXT_PUBLIC_SERVER_WS`, `NEXT_PUBLIC_DYNAMIC_ENV_ID`).
- **Game server** → **Fly** (`Dockerfile` + `fly.toml`), a single stateful
  machine (`fly scale count 1`); it can't run on Vercel (long-lived WebSockets).
- **Contract** → Base via `contracts/script/Deploy.s.sol` (auto-picks Base
  mainnet / Base Sepolia USDC).

The full runbook, including the Base Sepolia testnet path and every env var, is in
**[PRODUCTION.md](PRODUCTION.md)**.

## Security model / trust boundary

You trust the server's **result correctness** (which it controls anyway, as the
engine and referee), never its **custody**. Funds never touch a platform wallet:
they live in `ChessEscrow`, and the chain enforces the withdrawal ceiling,
address-bound payouts, per-game replay guards, and a `claimTimeout`/`claimRefund`
safety net if the oracle ever goes silent. Staking endpoints require a full
EIP-4361 (SIWE) session and derive each staked seat from the authenticated
wallet, never the request body. A full onchain dispute window (optimistic
settlement) and a multisig/threshold oracle are documented next steps in
[PRODUCTION.md](PRODUCTION.md). Details + audit history in **[AUDIT.md](AUDIT.md)**.

## Documentation

- **[HANDOFF.md](HANDOFF.md)**: current state + the next task (multi-node). Start here.
- **[CLAUDE.md](CLAUDE.md)**: agent/dev orientation. Build, test, run, gotchas.
- **[ARCHITECTURE.md](ARCHITECTURE.md)**: system, flow, and data diagrams.
- **[PRODUCTION.md](PRODUCTION.md)**: go-live checklist, deploy runbooks, env, limits.
- **[AUDIT.md](AUDIT.md)**: four review rounds and remediations.
- **[DEPLOYMENTS.md](DEPLOYMENTS.md)**: live Base mainnet addresses.

## License

See [LICENSE](LICENSE). Bundled Stockfish (GPLv3) is used unmodified as a
separate UCI process; the in-browser build is Stockfish WASM.
