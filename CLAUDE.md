# CLAUDE.md

Orientation for agents working in this repo. Read [HANDOFF.md](HANDOFF.md) for
the current state + the next big task (multi-node); this file is the quick
build/test/architecture reference.

## What this is
OpenChess: engine-vs-engine chess where bots play and users stake USDC on Base,
non-custodially. Rust monorepo (Cargo workspace) + Next.js web app. **Live on
Base mainnet** (see [DEPLOYMENTS.md](DEPLOYMENTS.md)).

## Build / test / run
```bash
cargo build && cargo test          # set DATABASE_URL to also run the persistence test
(cd contracts && forge test)       # Foundry: 25 tests incl. a solvency invariant
(cd apps/web && pnpm install && pnpm test:book)   # polyglot .bin key vectors
(cd apps/web && pnpm test:books)   # every uploadable book walks clean (incl. castling)
(cd apps/web && pnpm test:openings) # shipped book.json: legal + standard UCI
(cd apps/web && pnpm test:move)   # what a seat sends: never an illegal move
(cd apps/web && pnpm test:engine) # one bestmove answers one `go`, in order
(cd apps/web && pnpm test:seatengine) # the seat engine's prewarm/refcount lifecycle
(cd apps/web && pnpm test:time)    # per-move clock budgeting (movetime ceilings)
(cd apps/web && pnpm test:candidates) # style picks never trade away a forced mate
(cd apps/web && pnpm test:eval)    # eval-bar score mapping (UCI info → bar)
(cd apps/web && pnpm test:seat)    # pre-game confirm gate (decline must not close the socket)
(cd apps/web && pnpm test:nav)     # move nav (following the live tip vs. parked on a ply)
(cd apps/web && pnpm test:offers)  # lobby offer grouping + the join walk
(cd apps/web && pnpm test:auth)    # authed fetch: an expired session self-heals
(cd apps/web && pnpm test:prefs)   # board/piece theming (the two theme-apply paths must agree)
(cd apps/web && pnpm test:brand)   # the mark: app/icon.svg must match lib/brand.ts
(cd apps/web && pnpm test:font)    # the UI font is loaded, not just named
(cd apps/web && pnpm test:gamemeta) # what a shared game link says (title + OG card text)
(cd apps/web && pnpm test:avatar) # profile photo: the crop/shrink done before upload
(cd apps/web && pnpm test:layout)  # header stays on screen, and under the modal
(cd apps/web && pnpm test:profile) # profile: the ranked/casual split (and its old-server fallback)
(cd apps/web && pnpm test:csp)     # the CSP origins sign-in depends on
cargo run -p server                # game server on 127.0.0.1:8080
(cd apps/web && pnpm dev)          # web on :3000
cargo run -p book-gen -- assets/house-book.bin   # rebuild the house bot's book
(cd apps/web && pnpm gen:icon)     # regenerate app/icon.svg from lib/brand.ts
```
- Contract ABIs are **vendored** in `crates/ledger/abi/`, so `cargo build` does
  **not** need a prior `forge build`. Re-vendor after editing the contract
  (command in the comment above the `sol!` macros in `crates/ledger/src/lib.rs`).
- chessground's CSS is **vendored** in `apps/web/app/chessground.base.css` (its
  npm `exports` map makes the published assets unimportable). Re-vendor on a
  bump; the command is in that file's header. Don't re-add the old jsDelivr
  `<link>`s, since `style-src` no longer allows that origin. Overrides belong in
  `app/board.css`, never in the vendored file — a re-vendor replaces it
  wholesale and silently drops the edit (that is where the coords'
  `font-family` override lives, since chessground hardcodes `sans-serif`).
- The UI font is **Noto Sans, self-hosted by `next/font`** (`app/layout.tsx`
  defines `--font-sans`; `globals.css` is the only place that applies it).
  next/font fetches it at build time and serves it from our own origin, so
  `font-src 'self'` needs no new entry — don't replace it with a `<link>` to
  Google Fonts. Note what the fallback means: `globals.css` *named* Noto Sans
  from the start but nothing ever loaded it, so every visitor quietly got
  SF Pro or Segoe UI instead. If `--font-sans` stops resolving, that is the
  silent failure you are back to.
- Deploy the server with **`./scripts/deploy-server.sh`**, never a bare
  `fly deploy` (it re-adds Fly's HA machine, which breaks this single-node app).

## Layout
```
crates/protocol      shared serde wire types (server + client)
crates/game-engine   authoritative board/clock/result (shakmaty), the referee
crates/byo-client    native client: UCI driver, selfplay/play/gauntlet, `connect` bot agent
                     (web-driven seats or --auto), Polyglot book, SIWE/link-code auth, login
crates/server        chess-server: axum HTTP + WS hub, per-game room actors, 3 modes, SIWE,
                     bot-agent registry, leaderboard, per-IP rate limiting (ratelimit.rs),
                     owner-gated maintenance/drain switch (admin.rs)
crates/ledger        onchain settlement (alloy), EIP-712, SIWE recovery
crates/persistence   Postgres (sqlx) + migrations + settlement outbox
crates/book-gen      dev tool: builds assets/house-book.bin (Polyglot) from a
                     SAN repertoire; not part of any deployed artifact
contracts/           ChessEscrow.sol (Foundry): pooled balances + EIP-712 settlement
apps/web             Next.js: lobby, in-browser Stockfish 18 (WASM/NNUE) + uploadable
                     Polyglot book (lib/polyglot.ts), wallet/SIWE, bot control, spectator, profiles,
                     board/piece themes (lib/boardPrefs.ts + app/board.css)
```

## Architecture in three sentences
The server runs **one actor task per live game** and is the sole authority on
legality/clock/result (`crates/server/src/room.rs` + `crates/game-engine`).
Engines connect over a WebSocket BYO-engine protocol, and the web app is itself a
BYO client running Stockfish WASM (`apps/web/lib/engine.ts` + `lib/play.ts`). On
a finished staked game the server (oracle) signs an EIP-712 result and a durable
outbox settles it on `ChessEscrow`; funds live in the contract, never a platform
wallet.

## Constraints that WILL bite you
- **Single-node only.** Rooms, lobby, launch tokens, SIWE sessions, the bot-agent
  registry, and the rate-limit buckets are all in-process memory (`main.rs`
  AppState, `matchmaking.rs` Lobby, `auth.rs`, `agents.rs`, `ratelimit.rs`). Run
  exactly one Fly machine (`--ha=false` + `fly scale count 1`). Making it
  multi-node is the next task; see [HANDOFF.md](HANDOFF.md).
  One exception is now durable: an **`open` tournament is rehydrated from
  Postgres on boot** (`recover_tournaments`), because a restart used to delete
  it from the lobby while its onchain pool stayed open and entrants' buy-ins
  stayed locked. Anything you add to `Tournament` that an open tournament needs
  in order to be *startable* (organizer, entrants, bot bindings, terms) has to
  be persisted too, or the restart quietly comes back wrong instead of missing.
  `running` tournaments are still abandoned on purpose: their rooms are gone
  and partial standings must never reach settlement.
- **Rate limiting is per-IP, keyed on `Fly-Client-IP`.** Behind a different
  proxy the fallback header is client-forgeable, so pin header trust to the
  deploy. Limits are env-tunable (`RL_*`); a new HTTP route is unthrottled
  unless you add it to a throttled router (`ratelimit.rs`, `main.rs`).
- **The oracle pays gas.** The server sends `openGame`/`settleGame` from
  `ORACLE_KEY`; that address needs Base ETH or staked games fail closed.
- **Money paths fail closed.** No stake is accepted unless onchain settlement is
  configured; seats are bound to the SIWE-authenticated wallet, never a request
  body. Keep it that way.
- **Maintenance/drain is owner-gated + fail-closed.** `POST /admin/maintenance`
  only accepts a SIWE session whose wallet equals the onchain escrow `owner()`
  (set `ADMIN_WALLET` to override, e.g. local dev; else nobody is admin). When
  on, `AppState::start_game` and every create endpoint (incl. tournament pool
  create/join) `503`; the flag is DB-persisted (`server_settings`) so it
  survives the restart it was set to protect. Any **new** game-creating or
  money-committing route must call `state.reject_if_draining()?`. The drain is
  per-entry-point, not global middleware.
- **`pnpm build` clobbers the `next dev` cache** (→ `/_next/static` 404s). If the
  dev preview breaks after a build: `rm -rf apps/web/.next` and restart it.
- **The site header is sticky on purpose, and its `z-index` must stay under 50.**
  A game view is several viewports tall: the result banner used to land ~525px
  down and "Back to lobby" ~1000px down, so a static header was already ~640px
  above the screen by the time a finished game was readable — the top nav became
  unclickable and the sidebar button was the only way out. That shipped. The
  `z-index: 40` is the other half: `.modal-overlay` (StakeConfirm, the
  time-control picker) is 50 and MUST keep covering the header, so raising the
  header above it turns the pre-game confirm into a dialog you can click behind.
  The homepage also stands its hero + engine banner down while a board is
  mounted (`Lobby`'s `onActiveChange` → `page.tsx`), which is what actually
  brings the result banner back above the fold (235px, from 525px); sticky is
  the backstop, and the only half that covers the pages with no lobby to stand
  down (`/game/[id]`, gauntlet, tournament). Keep the hero in the SERVER render —
  `Lobby` is client-only, so moving the `<h1>` inside it drops the landing
  page's only heading out of the HTML. `pnpm test:layout` pins the two CSS
  halves (sticky, and ranked under the overlay) by reading `globals.css`; the
  React half — what `inGame` hides — is unpinned, since there's no DOM harness.
- **Sign-in is Dynamic, and it has four traps.** Dynamic
  (`@dynamic-labs/*`, `app/providers.tsx`) replaced RainbowKit so email/Google
  logins provision an embedded MPC wallet. That wallet is an ordinary EOA whose
  signature is indistinguishable from MetaMask's, which is the whole reason
  `crates/server/src/auth.rs` needed **no change**: it still `ecrecover`s a
  65-byte signature. Keep it that way — a smart-contract account would sign via
  ERC-1271 and 401 there, with no RPC in the auth path to check it against.
  (1) **The `@dynamic-labs/*` versions must move together.** Dynamic ships
  `assert-package-version`, which logs a loud error when the packages in the tree
  disagree, and a split tree also duplicates the logger/message-transport
  singletons. Only three packages are imported, but `types`, `logger` and
  `assert-package-version` are *also* direct dependencies — they are transitive
  and float to whatever is newest otherwise, which resolved a mixed 4.84.0/4.96.0
  tree. They look removable and are not. `pnpm.overrides` does **not** fix this
  (these resolve as auto-installed peers), and pnpm settings live in
  `pnpm-workspace.yaml`, not the package.json `pnpm` field.
  (2) **A missing `NEXT_PUBLIC_DYNAMIC_ENV_ID` used to white-screen the site.**
  `DynamicContextProvider` *throws* on an empty environmentId, and the root error
  boundary turns that into a blank page — so one unset env var took down
  spectating, replays, profiles and casual play, none of which need a wallet.
  Hence `lib/dynamicEnv.ts`: the provider is omitted entirely when unconfigured,
  and `AuthButton`/`WalletMenu` check `dynamicConfigured` before calling any
  Dynamic hook (the context defaults to `undefined`, so a hook without the
  provider throws too). Don't collapse that branch back.
  (3) **Dynamic's asset CDN is a different origin from its API.** The connect
  modal fetches its wallet list from `dynamic-static-assets.com`, so with only
  `app.dynamicauth.com` allowlisted the modal opens with **no wallets in it** and
  nothing else looks wrong. `pnpm test:csp` pins both.
  (4) **Never take a signer from wagmi while Dynamic is the connector authority.**
  `lib/useDynamicSigner.ts` builds it from `primaryWallet.getWalletClient()`,
  because `runSignIn` switches chain and signs immediately, and wagmi's
  `getConnectorClient` only re-syncs on the connector's own `chainChanged` event
  — it can throw `Connector not connected` mid-flow. Always pass `account:`
  explicitly too (WalletConnect + Ledger clients carry several). The same shape
  exists in `BankrollPanel`/`TournamentClaim`/`GameRefund`, which still use
  wagmi; that's the fix if it shows up there.
- **Never emit a private/oracle key** to output/logs. The oracle key is the
  crown jewel; a leak lets anyone forge results and drain stakes.
- **Merged ≠ deployed.** Only the web app auto-deploys (Vercel, on merge to
  `main`). The Fly server needs `./scripts/deploy-server.sh`, and the house bot
  needs `fly deploy --config fly.housebot.toml --ha=false`. A change to
  `crates/*` is inert in production until you run one of those. Check with
  `curl -s -o /dev/null -w '%{http_code}' https://openchess.fly.dev/games/unsettled/0x0`
  (404 ⇒ the running server predates the current `main`).
- **Two machines silently breaks everything, and it has happened.** Every piece
  of live state is per-process, so a second machine makes SIWE fail
  intermittently (nonce issued by A, verified against B) and the lobby flicker.
  `deploy-server.sh` asserts the count and `singlenode.rs` pages on a sibling,
  but a bare `fly deploy` still re-adds it. Symptom to recognise: polling one
  endpoint returns two stable, alternating answers.
- **Declining a game must not close the socket.** The lobby now gates a browser
  seat's `ready` frame on a confirmation popup (`StakeConfirm.tsx` →
  `playSeat({ confirmStart })`), which works because the server starts a game
  only once BOTH seats ready. The catch is in how an unstarted room is reaped:
  a seat that is still *attached* but never readied resolves as an abort (draw,
  stake refunded), while a seat that is *gone* hands the opponent a forfeit win
  and the whole stake (`room.rs reap_forfeit_winner`). So the decline path holds
  the socket open and waits out the reap. Closing it would confiscate the
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
  ceiling on the normal clock-based `go`. It is a ceiling and not a target, so the
  engine still moves fast when it's short on time. Both clients also set
  `Move Overhead` (250ms), since the server charges wall-clock including the
  round trip and the engine default of 10ms assumes a local opponent.
- **A book move is the only genuinely free move.** Both clients consult one
  before the engine: the browser has a curated set (`apps/web/lib/openings.ts`),
  the house bot a real Polyglot book (`assets/house-book.bin`, generated by
  `crates/book-gen` from a readable SAN repertoire; regenerate with
  `cargo run -p book-gen -- assets/house-book.bin`). Measured against the real
  server, in-book moves cost **0.0s** of clock where the same seat without a
  book spent 7.5s each. Two traps: a book is keyed by POSITION, so a generator
  and reader that disagree on Polyglot's move encoding produce a file that
  parses fine and never hits (`book::shipped_book` tests exist to catch exactly
  that); and `BookPolicy::Best` would walk one identical line every game, which
  is why `Weighted` is the default.
- **Castling has two UCI spellings and only one of them is safe.** chessops,
  Polyglot and Chess960 all write castling as king-takes-rook (`e1h1`);
  standard UCI writes the king's two-square move (`e1g1`). shakmaty accepts
  BOTH, so the server happily records either, but Stockfish in standard mode
  does not: its `position startpos moves …` parser stops at the first move it
  cannot read and **keeps the prefix silently**. One `e1h1` in the history
  leaves the engine a ply behind (usually on the wrong side to move) for the
  rest of the game, so every `bestmove` it returns is illegal, the server
  rejects it, and `play.ts` resigns. A level position, seconds on the clock, no
  error anywhere. That shipped: `scripts/build-book.mjs` (since deleted) used chessops'
  `makeUci`, so 553 of 1817 lines in `public/book.json` carried it. Anything
  reaching an engine or the wire goes through `lib/uci.ts` first;
  `pnpm test:openings` fails if a king-takes-rook move lands in the book again,
  and `pnpm test:move` pins what a seat sends. The seat no longer resigns over
  an illegal move either: it resets the engine, asks once more, and failing that
  spends a legal move, because resigning is a certain loss of a position that is
  usually fine, and of the stake with it.
- **The board theme is applied twice, and the two paths must agree.** A theme is
  CSS custom properties on `<html>` (`--board-bg`, 12 `--piece-*`), written both
  by an inline script in `app/layout.tsx` **before first paint** and by
  `applyBoardPrefs` after React mounts. The script has to be inline and in
  `<head>`: localStorage is client-only and React runs after the first paint, so
  without it every navigation flashes the default brown board. If the two paths
  ever compute different values the board visibly changes on load, which no
  screenshot of a settled page would catch, so `pnpm test:prefs` runs the script
  in a sandbox and asserts byte-identical variables. Both generate from the same
  tables (`lib/boardThemes.ts`, `lib/pieceSets.ts`); keep it that way rather than
  hand-writing the script. There is a THIRD copy, the `:root` fallback in
  `app/board.css` that keeps a board visible if the script never runs, and the
  same test diffs it both ways. The script also means `<html>` needs
  `suppressHydrationWarning`.
  Two further traps: chessground reads `coordinates`/`coordinatesOnSquares`
  **only when it builds the board**, so passing them through `api.set()` silently
  does nothing. Hiding coordinates is done in CSS
  (`.board-wrap[data-coords="off"]`), and only the "every square" layout
  recreates the instance. And roughly a third of lichess's piece sets are
  CC BY-NC-SA or outright non-free; this repo is MIT and settles real money, so a
  new set needs its license checked and recorded in
  `apps/web/public/piece/CREDITS.md` (`test:prefs` fails if a registered set has
  no art on disk).
- **The brand mark is also written twice.** Geometry lives in
  `apps/web/lib/brand.ts`; `app/icon.svg` is a second copy, because Next's icon
  file convention cannot import from TypeScript. Nothing at runtime compares
  them, so an edit to the path would leave the favicon showing the old mark
  indefinitely — `pnpm test:brand` is what catches it. Run **`pnpm gen:icon`**
  after any change to the geometry; never hand-edit the file. Two more traps:
  anything **icon-shaped must use the tiled variant**, since on a light browser
  tab strip the `#ededec` half of a bare mark disappears and leaves half a rook
  (iOS composites transparent app icons badly too); and a segment's
  `opengraph-image.tsx` is **auto-injected into that segment's metadata**, so if
  its `generateMetadata` also sets `openGraph.images` one silently overrides the
  other. Titles in `generateMetadata`, the picture in the file convention.
- **An OG card must draw the mark as inline `<svg>`, never an `<img>` data
  URI.** `next/og` rasterizes through resvg, and the resvg in a **production**
  bundle does not decode a nested SVG image: it drops it and still returns 200,
  so the card renders wordmark-only and every shared link quietly loses its
  logo. `next dev` uses a different resvg that decodes it fine, so this passes
  locally and breaks only once deployed — it shipped that way once already.
  Encoding is irrelevant (base64 and percent-encoded give byte-identical,
  markless output). `pnpm test:brand` greps `lib/ogCard.tsx` and
  `app/apple-icon.tsx` for the inline form. The general lesson: **verify a
  generated image against `next build && next start`, never the dev server.**
- **A root `alternates.canonical` is inherited by every route.** Metadata merges
  down the tree, so a canonical set in `app/layout.tsx` declares /gauntlet,
  /tournament and the rest duplicates of the homepage and drops them out of the
  index. There is deliberately none at the root; set one per segment if wanted.
- **Every page is a Client Component, so metadata lives in a sibling
  `layout.tsx`.** `"use client"` and `export const metadata` are mutually
  exclusive, which is why each route has a three-line server layout next to its
  page. A new route inherits the root title until you add one. The dynamic
  routes (`/game/[id]`, `/player/[address]`) use `generateMetadata` there, and
  both must degrade to a generic title rather than throw: a crawler hitting a
  dead id must not 500 the page.
- **One `bestmove` answers one `go`, in order.** `BrowserEngine` hands each one
  to the oldest waiter, never to every waiter: a caller that stops waiting for a
  search (the desync recovery above) leaves it running, and its late answer
  would otherwise resolve the NEXT search too, with a move for the previous
  position. `pnpm test:engine` pins it. Use `stopSearch()` rather than walking
  away, and keep `resync()` (`ucinewgame`) off a worker that is mid-search.
- **A profile photo is user bytes this server vouches for.** `/players/{addr}/avatar`
  hands them back with a stored content type, so both the type and the size come
  from the file's own header, never from the uploader (`sniff_image` in
  `players.rs`, PNG/JPEG only — nothing else has a dimension parser here).
  Trusting the declared `Content-Type` would make an SVG stored XSS on the API
  origin. And a byte cap does **not** bound a decoded image: a 9000×9000 PNG of
  one flat colour compresses to ~236 KB, fits the 256 KiB limit, and costs every
  browser that renders that profile ~0.3 GB — an `<img>` decodes at full
  resolution even inside a 72px box. Hence `AVATAR_MAX_PX`; `players::tests`
  pins both refusals. Writes are SIWE-bound and throttled **per wallet**
  (`limits.avatar`), not on the per-IP read budget this router's layer provides.
  The image response is cacheable, so the client busts it with
  `?v=<avatar_updated_at>` from `/players/{addr}` — without that a replaced photo
  keeps serving the old one. `lib/avatar.ts` centre-crops and re-encodes to a
  256px JPEG before upload (`pnpm test:avatar`), which is what keeps every limit
  above invisible in normal use.
- **An authed poster must never appear anonymous.** Auth is optional on casual
  offers, so a stale bearer used to be treated as "no credential" and the offer
  recorded no `poster_addr`, which silently disabled the client's self-match
  guard and the server's same-wallet rejection. `authed_wallet_strict` 401s a
  present-but-invalid credential; keep it that way (park accept and the gauntlet
  queue use it too), and route new authed web calls through
  `apps/web/lib/authedFetch.ts` so an expired session self-heals instead of
  dead-ending.
- **A seat's wallet is the only thing that survives the game.**
  `games.white_wallet`/`black_wallet` are what `/players/{addr}/games`, the
  W/L/D record, net USDC and Elo all read — and they used to be written from the
  *wager*, so an unstaked game recorded NULL seats and disappeared the moment it
  finished. It failed perfectly silently: the game plays, settles, shows in the
  lobby, then isn't in anyone's history. The seat wallet now rides on
  `SeatMeta.wallet` and `seat_wallets`
  (`main.rs`) picks the escrow address when there's a stake, else the
  authenticated wallet — so **every mode that seats a signed-in player has to
  fill it in** (park, queue, tournament do). Two riders. The client must *send*
  the session on casual calls as well, not only staked ones, or the server has
  no wallet to record. And `update_ratings` skips a game whose two seats are the
  same wallet: nothing rejects one wallet on both casual seats the way escrow
  does, and the two Elo writes apply in order, so the winner's would land last
  and farm rating. Note this fix is not retroactive — games already played with
  NULL seats can't be attributed, because nothing recorded who sat there.
- **There are two ladders, and `games.rated` is which.** A game is RANKED when
  money was on it — a per-game USDC stake, or a pairing in a tournament that
  charged a buy-in — and CASUAL otherwise; the two move `users.rating` and
  `users.casual_rating` independently and never mix. That is what makes the
  lobby's long-standing promise ("a free game doesn't affect your Elo") true
  again once casual games started being attributed at all. Three things to know.
  **Ranked is not `stake IS NOT NULL`:** a tournament pairing carries no stake of
  its own (the buy-in is a pool settled separately), so anything deriving the
  ladder from the stake files every paid tournament under casual. The flag is
  decided once at creation (`Ladder` → `start_game` → `create_game`, where it is
  OR-ed with the wager so a staked game can't be recorded casual by omission) and
  read back everywhere after, including by the client
  (`lib/profileFilter.ts` `bucketOf`). **Two flags, two jobs:** `room.rs`'s
  `contested` (`ply >= 2`) decides *whether* a rating moves; `games.rated`
  decides *which*. **Casual is farmable and stays off the leaderboard** — free
  games cost nothing, and the same-wallet guard only catches one wallet on both
  seats, not two cooperating ones. Removing the payoff is the defence, so don't
  put casual Elo on a public board, and never thread a seat wallet into the
  unauthenticated `POST /games`: that would make a ladder writable with no SIWE
  at all.

## Conventions
- Money is `rust_decimal` / `U256`, never `f64`. USDC has 6 decimals.
- IDs are UUIDs. Time controls are `{initial_secs, increment_secs}`.
- **Bot seats** work in all 3 modes: a seat is played by the in-browser engine
  or a connected agent (`SeatDelivery::{Browser,Agent}` in `start_game`), claimed
  per game. **Tournaments dispatch round-by-round** (circle method,
  `matchmaking.rs`), so a single-agent bot only ever plays one game at once; an
  offline bot at a round's dispatch forfeits that pairing.
- **A tournament round dispatches on the server's schedule, not the player's.**
  Each round's rooms are created the instant the previous round resolves, and a
  room reaps after `START_WINDOW` (60s), so a browser entrant who isn't at the
  board forfeits, then forfeits every round after it. The tournament page
  therefore **opens the board itself** when a round it's entered in dispatches
  (`app/tournament/page.tsx`, the `leftRound` effect); backing out keeps you out
  of that round only. Anything that reintroduces a "click here to play this
  round" gate re-breaks the mode.
- **Colour is drawn per game, never handed out by role.** Park and the queue
  flip a coin (`matchmaking.rs coin_flip`); tournaments alternate on the
  round-robin's own schedule (`round_robin_rounds`). Role-based colour is the
  bug this replaced: the poster of an offer took White and the acceptor Black,
  so a player who only ever joined the house bot's standing offers never once
  had the first move, in staked games. Two things to keep. The coin is drawn
  **above `build_wager`**, because that takes `(white, black)` and the EIP-712
  result the oracle signs is keyed on that pair — flipping any later settles
  against the wrong seats. And the colour a client is TOLD
  (`ParkAcceptResp.color`, `park_get`'s `poster_color`, the queue ticket) must
  be the seat its launch token drives, or the board opens on the opponent's
  side; `park_colour_is_a_coin_and_matches_the_launch_tokens` pins that. But a
  client that can't read a colour must still TAKE the seat (`lib/offers.ts
  seatColor`): by then escrow is locked, and a seat that never attaches reaps
  as a forfeit that hands the opponent the whole stake, where a board shown the
  wrong way round is only a reload — `playSeat` drives off the token and the
  server's frames, never the colour. Every parallel flip (metadata, delivery,
  tokens, colours, wager wallets) goes through one `seats()` helper, because an
  inverted swap at any single site fails silently.
- **Forfeit vs rating:** a no-show/forfeit loses the stake or entry, but a
  rating moves **only if both sides made ≥1 move** (`ply >= 2`, the `contested`
  guard in `room.rs finish()`). Never ding rating for a game a player didn't
  play. Which of the two ratings moves is a separate question — see
  `games.rated` above.
- End commit messages with the `Co-Authored-By: Claude …` trailer.
