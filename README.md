# OpenChess

**Machines play. You back yours.** OpenChess is engine-vs-engine chess where
bots play and people stake USDC on the result, settled on Base by a
non-custodial escrow contract. Because every seat is an engine, the usual
online-chess cheating problem doesn't exist: the server only has to be the
authority on legality, the clock and the result.

Bring your own UCI engine, or let the Stockfish build that runs in your browser
play for you.

- **Live:** <https://openchess.ai>
- **Escrow (`ChessEscrow` v2, Base mainnet):**
  [`0x7a53…4D68`](https://basescan.org/address/0x7a536bef5cd9694acaed7bc5fe65e463db5d4d68),
  source verified on Basescan. See [docs/deployments.md](docs/deployments.md).

> **Status.** Running in production with real USDC, with deliberate limits:
> - The contract has had internal reviews but **no third-party audit**.
> - Results are signed by a single **hot oracle key**.
> - The server is **single-node**.
> - Stakes and tournament buy-ins are capped at **25 USDC** by the server.
>
> [SECURITY.md](SECURITY.md) spells out the trust model and what's still open.

---

## What you can do

- **Play a quick game.** Pick a time control (1+0, 3+0, 5+0 or 10+0) and you're
  paired with the house bot, or another player's engine, in seconds. Free games
  need an account (email, Google or any wallet) because they land in your
  history and move your Elo.
- **Stake a game.** Deposit USDC into the escrow once, then post or accept a
  challenge at a stake. The winner takes the pot minus a 1% rake. The money
  never sits in a platform wallet.
- **Run a gauntlet.** Your engine plays back-to-back games at a fixed stake
  tier, each settled independently.
- **Enter a tournament.** Round-robin events in three kinds: a buy-in prize
  pool, a free event funded by sponsors, or a casual event with no money at all.
  Pools pay out onchain by final standings.
- **Bring your own bot.** In every mode, a seat can be played by the in-browser
  engine or by your own engine running anywhere, connected with `chess-client`
  and driven from the website.
- **Watch and share.** Live games are spectatable, finished games are
  replayable at `/game/<id>`, and every result is signed by the oracle and
  checked in the browser.
- **Profiles.** Usernames, avatars, W/L/D, net USDC, and two Elo ratings,
  ranked (money games) and casual (free games), at `/player/<name>`.
- **Try the engine with no account.** `/play` runs two in-browser engines
  against each other on the live server.

## How it works

```
 browser (Next.js + Stockfish WASM) ─┐                       ┌─ Postgres (games, outboxes)
                                     ├─ WebSocket / REST ─ chess-server ─┤
 chess-client (any UCI engine) ──────┘   (one actor per game)            └─ ChessEscrow on Base (USDC)
```

- **The server is the referee.** `chess-server` (Rust, axum + tokio) runs one
  actor per live game and re-validates every move and clock tick with
  [shakmaty](https://github.com/niklasf/shakmaty). It never trusts a client.
- **Engines run on players' machines, not ours.** The web app is itself a
  bring-your-own-engine client running Stockfish 18 compiled to WASM. The native
  `chess-client` speaks the same WebSocket protocol for any UCI engine. The one
  engine the operator runs is the house bot, which keeps the lobby populated.
- **Money lives in the contract.** Players deposit into `ChessEscrow`. A staked
  game locks both stakes. When it ends, the server, acting as the result oracle,
  signs an EIP-712 result, and a durable outbox submits it onchain and retries
  until it lands. Withdrawals are capped at your unlocked balance. If the oracle
  ever goes silent, timeouts let players reclaim locked funds themselves.

[ARCHITECTURE.md](ARCHITECTURE.md) has the diagrams: the move loop, money
flows, tournament settlement, the data model and the trust model.

## Repository layout

```
crates/server        chess-server: HTTP + WebSocket hub, per-game room actors, matchmaking
                     (challenges, queue, gauntlet, tournaments), SIWE auth, bot-agent registry,
                     usernames/avatars, leaderboard, rate limiting, maintenance mode
crates/game-engine   the authoritative board, clock and result (shakmaty)
crates/protocol      wire types shared by server and clients
crates/byo-client    chess-client: UCI driver, `connect` bot agent, gauntlet, Polyglot books
crates/ledger        onchain settlement (alloy), EIP-712 results, SIWE signature recovery
crates/persistence   Postgres (sqlx), migrations, settlement outboxes
crates/book-gen      dev tool that builds the house bot's opening book
contracts/           ChessEscrow.sol (Foundry): balances, per-game escrow, tournament pools
apps/web             Next.js app: lobby, in-browser engine, wallet sign-in (Dynamic), profiles
scripts/             deploy-server.sh, house-bot.sh, local onchain demos and e2e money tests
```

## Run it locally

You need Rust ≥ 1.91, [Foundry](https://getfoundry.sh) (`forge`, `anvil`,
`cast`), Node + pnpm 10, and optionally Postgres and a `stockfish` binary on
your PATH.

```bash
cargo build && cargo test                  # Rust workspace (set DATABASE_URL to include the DB tests)
(cd contracts && forge test)               # contract tests, incl. a solvency invariant

cargo run -p server                        # terminal 1: game server on 127.0.0.1:8080
(cd apps/web && pnpm install && pnpm dev)  # terminal 2: web app on http://localhost:3000
```

Open <http://localhost:3000/play> to watch two in-browser engines play through
your local server, no account needed. The signed-in parts of the app need a
[Dynamic](https://dynamic.xyz) environment id in `apps/web/.env.local` (see
[`apps/web/.env.example`](apps/web/.env.example)). Staked play also needs a
chain: `scripts/onchain-demo.sh` runs the whole money loop on a local Anvil
chain.

Contract ABIs are vendored in `crates/ledger/abi/`, so `cargo build` doesn't
need a prior `forge build`. [CONTRIBUTING.md](CONTRIBUTING.md) lists every test
suite and the conventions.

### Put your own engine online

```bash
# Pair with your account using the code from https://openchess.ai/connect, then
# start or join games on the website; seats are pushed to this process.
chess-client connect --server https://openchess.fly.dev \
  --engine stockfish --book ./book.bin --uci-option "Threads=4" --code <pairing-code>
```

Prebuilt binaries are on the
[releases page](https://github.com/vikramarun/openchess/releases). Add `--auto`
to queue for games unattended instead of being driven from the web, and run
`chess-client --help` for everything else (self-play, direct play, gauntlet,
headless sign-in).

## Deployment

- **Web:** Vercel, with the root directory set to `apps/web`.
- **Game server:** Fly.io, as a single stateful machine. Deploy with
  `./scripts/deploy-server.sh`, never a bare `fly deploy`.
- **House bot:** a separate Fly app (`fly.housebot.toml`).
- **Contract:** `contracts/script/Deploy.s.sol`.

[docs/operations.md](docs/operations.md) is the runbook: every environment
variable, the testnet path, maintenance mode and self-hosting caveats.

## Documentation

| Doc | What's in it |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System, flow and data diagrams; the trust model |
| [SECURITY.md](SECURITY.md) | Trust model, known limitations, how to report a vulnerability |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Dev setup, test suites, conventions |
| [docs/operations.md](docs/operations.md) | Deploying and running it, every env var, go-live checklist |
| [docs/deployments.md](docs/deployments.md) | Live contract addresses and parameters |
| [docs/tournaments.md](docs/tournaments.md) | How tournaments work: kinds, admission, schedule, payouts, refunds |
| [docs/multi-node.md](docs/multi-node.md) | What it takes to run more than one server |
| [docs/security-reviews.md](docs/security-reviews.md) | History of the internal security reviews and fixes |
| [CLAUDE.md](CLAUDE.md) | Detailed engineering notes for contributors and coding agents |

## License

MIT, see [LICENSE](LICENSE). The web app serves an unmodified GPLv3 build of
Stockfish 18 (WASM), which runs as a separate Web Worker spoken to over UCI; see
[apps/web/public/ENGINE.md](apps/web/public/ENGINE.md) for its provenance. The
native client and house bot talk to a separately installed Stockfish binary.
