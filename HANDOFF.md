# OpenChess — Handoff

_Last updated: 2026-07-10._

Engine-vs-engine chess with non-custodial USDC wagers on Base. This doc is the
fast path for the next person (or agent). Start here, then dive into the linked
docs.

- **Product/architecture:** [README.md](README.md), [ARCHITECTURE.md](ARCHITECTURE.md)
- **Deploy/ops + go-live checklist:** [PRODUCTION.md](PRODUCTION.md)
- **Security history:** [AUDIT.md](AUDIT.md) (4 rounds)
- **Live addresses:** [DEPLOYMENTS.md](DEPLOYMENTS.md)
- **Agent orientation (build/test/run/gotchas):** [CLAUDE.md](CLAUDE.md)

---

## Current state (what's live)

- **Contract is LIVE on Base mainnet.** `ChessEscrow` deployed + Basescan-verified
  at `0x7Cc1dD4F12BBfb40fCA6eC2334a27c646FCf923D` (chain 8453), owned by a
  hardware wallet (`0x4392…DF6A`, Ownable2Step accepted), oracle `0xE41A…7B53`
  (funded). See [DEPLOYMENTS.md](DEPLOYMENTS.md).
- **Server** (`chess-server`) runs on Fly at `openchess.fly.dev`; **web** on
  Vercel at `openchess.ai`. `GET /config` → `wager_enabled:true`.
- **Working end-to-end:** the casual lobby (create/join/watch, in-browser
  Stockfish + opening book), Park/Patzer in-browser wagering (deposit → play →
  on-chain settle), Gauntlet (native + browser), Tournament round-robin, player
  profiles, verifiable results, durable settlement outboxes.
- **True BYO multiplayer (bot agents):** `chess-client connect` pairs a
  user-run UCI engine (+ optional Polyglot book) with the user's wallet ONCE —
  it registers over a persistent `/ws/agent` socket (`crates/server/src/agents.rs`,
  auth in the `Hello` frame, never the URL) and the **website is the remote
  control**: starting/joining a lobby game with "🤖 Your bot" makes the server
  push the seat to the agent, which plays it while the browser spectates. Bots
  are always wallet-bound (no anonymous bots). Heavy customizability: the agent
  reports the engine's UCI options; the web `/connect` page renders a settings
  panel whose values are relayed per game (plus CLI `--uci-option`/`--book`).
  Supporting pieces: pairing via single-use **link codes** (`POST /auth/link`
  → `/auth/link/claim`, auto-embedded in the generated command), local SIWE
  signing with `OPENCHESS_WALLET_KEY` (+ `chess-client login` for scripting),
  offer cancellation (`DELETE /park/offers/{id}` + `cancel_key`), sanitized
  name/engine identity on offers/live games and in `GameStart.opponent`, and
  `--auto` for unattended accept-or-post matchmaking (headless bots).
  Reliability invariants (post-review hardening — keep these): seat delivery
  lives in `AppState::start_game` via `SeatDelivery::{Browser, Agent}` (one
  claim/dispatch/rollback path for every mode; a failed dispatch ABORTS the
  game and refunds escrow as a draw); the agent **busy flag is server-owned**
  (`Agents::bind_game`/`game_ended` off `cleanup_task`; client Status frames
  can only mark busy, never idle; `set_busy` is conn-id-guarded); the ws layer
  disconnects players/spectators when a room dies so clients never hang on a
  never-started game. Bot seats are wired to the park lobby only so far —
  gauntlet/tournament web pages still drive the browser engine, but the
  `SeatDelivery` plumbing means adding them is a per-endpoint claim, not a
  re-implementation.
- **Distribution:** prebuilt `chess-client` binaries ship from
  `.github/workflows/release.yml` on `v*` tags (artifact names are
  load-bearing — the web `/connect` page links to
  `releases/latest/download/<name>`). Cut a release with
  `git tag v0.1.0 && git push origin v0.1.0`. `scripts/house-bot.sh` runs one
  casual autopilot per lobby time control under an UNFUNDED wallet so the
  park is never empty — run it 24/7 somewhere cheap.
- **Guardrails for the unaudited launch:** server `MAX_STAKE` capped at **25
  USDC** (`crates/server/src/main.rs`), 1% rake, 24h settle timeout.
- **Tests:** 21 Rust + 25 Foundry (incl. a 128k-call solvency invariant). CI in
  `.github/workflows/ci.yml`.

## ⚠️ The #1 next task: make it multi-node (true HA)

**This is why you're getting the handoff.** The server is **single-node only** —
all live state is in one process's memory, so Fly's default 2-machine HA pair
*silently breaks it* (each request hits a different machine: offers vanish,
games don't start, sign-in doesn't stick). Today it's pinned to one machine
(`fly deploy --ha=false` + `fly scale count 1`; use `scripts/deploy-server.sh`).

To run >1 machine, the in-memory state must move to a shared store (Redis) and
game rooms must be sharded. The exact state to migrate:

| State | Where | Notes |
|---|---|---|
| SIWE nonces + sessions | `crates/server/src/auth.rs:35,37` (`Mutex<HashMap>`) | → Redis with TTL. Straightforward. |
| Launch tokens (token→seat) | `crates/server/src/main.rs:55` | → Redis. Straightforward. |
| Park offers, matchmaking queues | `crates/server/src/matchmaking.rs:43,44` | → Redis. Needs atomic pop for pairing. |
| Gauntlet/tournament sessions, standings, `game_to_*` maps | `crates/server/src/matchmaking.rs` (`Lobby`) | → Redis. Standings updated as games finish. |
| **Game rooms** (live board + clocks, actor tasks) | `crates/server/src/main.rs:50` (`rooms`), `room.rs` | **Hardest.** Rooms are tokio actors in memory. |
| `live_games` metadata | `crates/server/src/main.rs:53` | Derivable from a shared room registry. |

**Suggested plan (already sketched in the original plan + PRODUCTION.md):**
1. **Shared store:** add a Redis client (`fred`) to `AppState`; move sessions,
   tokens, and lobby/matchmaking state behind it. This alone makes REST + the
   lobby multi-node-safe.
2. **Room sharding + affinity:** keep each game's room actor on exactly one
   node; a Redis "affinity registry" maps `game_id → node`. Route a player's WS
   (and their moves) to the owning node; use Redis pub/sub so *any* node can
   fan out spectator updates. The `Resume` protocol message already exists for
   reconnects.
3. **Room rehydration:** on node loss, rebuild a room from the persisted move
   log (`moves` table) + clocks (`last_move_at`) so in-flight games survive.
   (This also closes the "game resumption" gap noted in PRODUCTION.md.)
4. Once done, drop `--ha=false` and scale up.

The authoritative game logic (`crates/game-engine`, shakmaty) and the money
layer (`contracts`, `crates/ledger`) do **not** need to change for this — it's
all in `crates/server` + a Redis dependency.

## Other known gaps (lower priority, not blocking)

- **Independent contract audit** — the real gate before scaling real money.
  Two internal reviews + 25 tests are done; a third-party audit is not.
- **Oracle key hardening** — currently a hot key in a Fly secret. Move to
  KMS/HSM + a multisig/threshold oracle (ERC-1271 in the contract) before
  raising `MAX_STAKE`. See [AUDIT.md](AUDIT.md) round-4 notes + PRODUCTION.md.
- **Tournament UI gaps** — Swiss/knockout pairing is advertised but only
  round-robin is implemented; Merkle-claim + `claimRefund` have no browser UI
  (funds are recoverable on-chain, just not in-app for large/abandoned fields).
- **Per-time-control Elo** — one overall Elo today; Bullet/Blitz/Rapid buckets
  would need time-control-keyed rating rows.

## Run / test / deploy (quick)

```bash
cargo build && cargo test          # DATABASE_URL set → also runs persistence test
(cd contracts && forge test)       # 25 Foundry tests
cargo run -p server                # local server on :8080
(cd apps/web && pnpm install && pnpm dev)   # web on :3000

# Deploy the server (ALWAYS use the wrapper — plain `fly deploy` re-adds the HA machine):
./scripts/deploy-server.sh
```

## Gotchas that bit this session (save yourself the time)

- **Fly re-adds a 2nd machine on `fly deploy`.** Always `--ha=false` +
  `fly scale count 1` (the wrapper does both). This is the single biggest trap.
- **`pnpm build` clobbers the `next dev` cache** → `/_next/static/*` 404s, blank
  pages. If the preview goes weird after a build: `rm -rf apps/web/.next` and
  restart the dev server.
- **Contract ABIs are vendored** in `crates/ledger/abi/` so `cargo build` works
  without `forge build`. Re-vendor after a contract change (command in the
  comment above the `sol!` macros in `crates/ledger/src/lib.rs`).
- **The oracle pays gas** — the server sends `openGame`/`settleGame` from
  `ORACLE_KEY`, so that address must hold Base ETH or wagered games fail closed.
- **`alloy 2.0.x` needs rustc ≥ 1.91** (Docker builder pinned to `rust:1.91`).
- **Never put a private/oracle key in a chat/log** — the oracle key is the crown
  jewel; a leak = anyone can forge results and drain locked stakes.
