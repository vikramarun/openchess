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
(cd apps/web && pnpm test:eval)    # eval-bar score mapping (UCI info → bar)
(cd apps/web && pnpm test:seat)    # pre-game confirm gate (decline must not close the socket)
cargo run -p server                # game server on 127.0.0.1:8080
(cd apps/web && pnpm dev)          # web on :3000
cargo run -p book-gen -- assets/house-book.bin   # rebuild the house bot's book
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
crates/book-gen      dev tool: builds assets/house-book.bin (Polyglot) from a
                     SAN repertoire — not part of any deployed artifact
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
  One exception is now durable: an **`open` tournament is rehydrated from
  Postgres on boot** (`recover_tournaments`), because a restart used to delete
  it from the lobby while its on-chain pool stayed open and entrants' buy-ins
  stayed locked. Anything you add to `Tournament` that an open tournament needs
  in order to be *startable* (organizer, entrants, bot bindings, terms) has to
  be persisted too, or the restart quietly comes back wrong instead of missing.
  `running` tournaments are still abandoned on purpose — their rooms are gone
  and partial standings must never reach settlement.
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
- **Merged ≠ deployed.** Only the web app auto-deploys (Vercel, on merge to
  `main`). The Fly server needs `./scripts/deploy-server.sh`, and the house bot
  needs `fly deploy --config fly.housebot.toml --ha=false`. A change to
  `crates/*` is inert in production until you run one of those — check with
  `curl -s -o /dev/null -w '%{http_code}' https://openchess.fly.dev/games/unsettled/0x0`
  (404 ⇒ the running server predates the current `main`).
- **Two machines silently breaks everything, and it has happened.** Every piece
  of live state is per-process, so a second machine makes SIWE fail
  intermittently (nonce issued by A, verified against B) and the lobby flicker.
  `deploy-server.sh` asserts the count and `singlenode.rs` pages on a sibling —
  but a bare `fly deploy` still re-adds it. Symptom to recognise: polling one
  endpoint returns two stable, alternating answers.
- **Declining a game must not close the socket.** The lobby now gates a browser
  seat's `ready` frame on a confirmation popup (`StakeConfirm.tsx` →
  `playSeat({ confirmStart })`), which works because the server starts a game
  only once BOTH seats ready. The catch is in how an unstarted room is reaped:
  a seat that is still *attached* but never readied resolves as an abort (draw,
  stake refunded), while a seat that is *gone* hands the opponent a forfeit win
  and the whole stake (`room.rs reap_forfeit_winner`). So the decline path holds
  the socket open and waits out the reap — closing it would confiscate the
  stake of the player who chose not to play. `pnpm test:seat` pins this; a
  `ws.close()` added to that path fails it and nothing else.
  The prompt's countdown comes from `Welcome.start_deadline_ms` (server-side
  `room::START_WINDOW`), never a client constant: the window starts at room
  creation, so a client that spent 30s downloading the engine has already
  burned half of it and a local countdown would promise time that is gone.
- **A UCI engine will spend a fifth of a rapid clock on move 1.** Sudden-death
  time management lets one unstable root eat several times the target, and the
  start position is the most unstable root there is: measured against the real
  server, Stockfish 17 spent 20.5s on move 1 of a 10+0 game, then hurried the
  rest and flagged. Long-running bots pass `--max-move-ms` (`house-bot.sh`
  derives it as `initial/MOVE_BUDGET`), which rides along as a `movetime`
  ceiling on the normal clock-based `go` — a ceiling, not a target, so the
  engine still moves fast when it's short on time. Both clients also set
  `Move Overhead` (250ms), since the server charges wall-clock including the
  round trip and the engine default of 10ms assumes a local opponent.
- **A book move is the only genuinely free move.** Both clients consult one
  before the engine: the browser has a curated set (`apps/web/lib/openings.ts`),
  the house bot a real Polyglot book (`assets/house-book.bin`, generated by
  `crates/book-gen` from a readable SAN repertoire — regenerate with
  `cargo run -p book-gen -- assets/house-book.bin`). Measured against the real
  server, in-book moves cost **0.0s** of clock where the same seat without a
  book spent 7.5s each. Two traps: a book is keyed by POSITION, so a generator
  and reader that disagree on Polyglot's move encoding produce a file that
  parses fine and never hits (`book::shipped_book` tests exist to catch exactly
  that); and `BookPolicy::Best` would walk one identical line every game, which
  is why `Weighted` is the default.
- **An authed poster must never appear anonymous.** Auth is optional on casual
  offers, so a stale bearer used to be treated as "no credential" and the offer
  recorded no `poster_addr` — which silently disabled the client's self-match
  guard and the server's same-wallet rejection. `authed_wallet_strict` 401s a
  present-but-invalid credential; keep it that way, and route new authed web
  calls through `apps/web/lib/authedFetch.ts` so an expired session self-heals
  instead of dead-ending.

## Conventions
- Money is `rust_decimal` / `U256` — never `f64`. USDC has 6 decimals.
- IDs are UUIDs. Time controls are `{initial_secs, increment_secs}`.
- **Bot seats** work in all 3 modes: a seat is played by the in-browser engine
  or a connected agent (`SeatDelivery::{Browser,Agent}` in `start_game`), claimed
  per game. **Tournaments dispatch round-by-round** (circle method,
  `matchmaking.rs`), so a single-agent bot only ever plays one game at once; an
  offline bot at a round's dispatch forfeits that pairing.
- **A tournament round dispatches on the server's schedule, not the player's.**
  Each round's rooms are created the instant the previous round resolves, and a
  room reaps after `START_WINDOW` (60s) — so a browser entrant who isn't at the
  board forfeits, then forfeits every round after it. The tournament page
  therefore **opens the board itself** when a round it's entered in dispatches
  (`app/tournament/page.tsx`, the `leftRound` effect); backing out keeps you out
  of that round only. Anything that reintroduces a "click here to play this
  round" gate re-breaks the mode.
- **Forfeit vs rating:** a no-show/forfeit loses the stake or buy-in, but a game
  is **rated (Elo) only if both sides made ≥1 move** (`ply >= 2`, guarded in
  `room.rs finish()`) — never ding rating for a game a player didn't play.
- End commit messages with the `Co-Authored-By: Claude …` trailer.
