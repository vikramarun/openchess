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
(cd apps/web && pnpm test:payouts) # a tournament's prize split adds up to the pool
(cd apps/web && pnpm test:tourney) # buy-in vs free vs casual (a "0" buy-in is truthy)
(cd apps/web && pnpm test:sponsor) # sponsoring a pool, and getting it back if the event dies
(cd apps/web && pnpm test:auth)    # authed fetch: an expired session self-heals
(cd apps/web && pnpm test:prefs)   # board/piece theming (the two theme-apply paths must agree)
(cd apps/web && pnpm test:brand)   # the mark: app/icon.svg must match lib/brand.ts
(cd apps/web && pnpm test:font)    # the UI font is loaded, not just named
(cd apps/web && pnpm test:gamemeta) # what a shared game link says (title + OG card text)
(cd apps/web && pnpm test:avatar) # profile photo: the crop/shrink done before upload
(cd apps/web && pnpm test:layout)  # header/tab bar stay put; coords stay on the board; no orphaned class
(cd apps/web && pnpm test:tabs)    # mobile tab bar: which tab a route lights up
(cd apps/web && pnpm test:demo)    # the homepage reel: still mates, still engine-free
(cd apps/web && pnpm test:profile) # profile: the ranked/casual split (and its old-server fallback)
(cd apps/web && pnpm test:username) # a username's shape, and what a player is called
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
apps/web             Next.js: landing demo reel (lib/demoReel.ts) + quick play at /, browse at
                     /lobby, in-browser Stockfish 18 (WASM/NNUE) + uploadable
                     Polyglot book (lib/polyglot.ts), wallet/SIWE, bot control, spectator, profiles,
                     board/piece themes (lib/boardPrefs.ts + app/board.css),
                     mobile tab bar (components/TabBar.tsx)
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
  The homepage also stands its hero + demo reel + engine banner down while a
  board is mounted (`Lobby`'s `onActiveChange` → `page.tsx`), which is what
  actually brings the result banner back above the fold (235px, from 525px);
  sticky is the backstop, and the only half that covers the pages with no lobby
  to stand down (`/game/[id]`, gauntlet, tournament). Keep the hero in the
  SERVER render — `Lobby` is client-only, so moving the `<h1>` inside it drops
  the landing page's only heading out of the HTML. `pnpm test:layout` pins the
  two CSS halves (sticky, and ranked under the overlay) by reading `globals.css`;
  the React half — what `inGame` hides — is pinned instead by `pnpm test:demo`,
  which greps `page.tsx` for `<HomeDemo>` inside the `!inGame` branch.
- **Below 720px the bottom tab bar is the ONLY navigation.** The header's `.nav`
  is `display: none` there and `components/TabBar.tsx` carries the five
  destinations (it replaced a masked horizontal scroller whose last link sat
  77px off the right edge at 375px). Three things it must keep. `.tabbar`'s
  `z-index: 30` sits **under** the header's 40 — `.site-header` is sticky *with*
  a z-index, so it is a stacking context and `.wallet-pop` (z-index 50) is
  scoped inside it, meaning a bar above the header would paint over the bankroll
  popover's Deposit button on a phone — and under `.modal-overlay`'s 50, or the
  pre-game stake confirm gets five tappable links across its bottom edge. A
  `position: fixed` bar takes no space in the flow, so `<body>` carries a
  matching `padding-bottom` off the same `--tabbar-h` token, else the footer's
  last line sits under it. And `activeTab()` must keep matching prefixes with a
  trailing slash: `"/player/0xabc".startsWith("/play")` is true, so a bare
  prefix lights "Engine" on every profile. `pnpm test:layout` pins the CSS,
  `pnpm test:tabs` the routing.
- **The landing page is a scripted demo, and it must never touch the engine.**
  `/` opens on a coin flip and a canned 33-ply game that ends in mate
  (`lib/demoReel.ts` → `components/HomeDemo.tsx`). Every frame is derived by
  replaying SAN with chessops at module init, and the eval bar is fed canned
  numbers — so a real `<Chessboard>`/`<EvalBar>` render with **zero wasm**. Reach
  for `lib/engine`, `useEval` or `engineContext` from there and every cold mobile
  visit silently pays a 7 MB download; `pnpm test:demo` greps for exactly that.
  The reel stops three ways (unmounted by `inGame`, hidden tab, scrolled out of
  view), and `.demo-payout` is rendered from the first paint at
  `visibility: hidden` so it reserves its own height — it appears ~28s in, and
  CLS accumulates over a page's whole lifetime, so a min-height guess that
  under-reserves at some viewport would shift the page long after it looked
  settled. The browse surfaces it displaced (open challenges, live now,
  leaderboard, mode cards) live at **`/lobby`**, which renders the same
  `<Lobby view="browse">` — one component owns the live-game session for both
  routes, because both can open a board and splitting that would duplicate the
  money path.
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
  `pnpm-workspace.yaml`, not the package.json `pnpm` field. The SDK also drags
  in two packages with **build scripts** (`sharp`, `bigint-buffer`), both
  declined in `allowBuilds` — a dependency that is neither allowed nor refused
  fails the install outright on pnpm 11 and only warns on pnpm 10, so add every
  new one there. That version split is why `packageManager` is pinned:
  CI's `corepack enable` had no version and drifted onto 11 while local stayed
  on 10, which made the failure invisible locally and fatal in CI, on an install
  that never reached a test. The pin stays on the **10.x** line on purpose —
  pnpm 11 imports `node:sqlite` and so needs Node 24, which neither CI (no
  `setup-node`) nor Vercel pins, so requiring it would trade one unpinned
  toolchain for another with the deploy in the blast radius. The strictness that
  costs us is asserted directly in `ci.yml` instead, by grepping the install log
  — which is only reliable *because* the version is pinned.
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
  `Move Overhead`, since the server charges wall-clock including the round trip
  and the engine default of 10ms assumes a local opponent.
- **`Move Overhead` is multiplied by ~52, so it must NOT be a constant.**
  Stockfish's sudden-death manager takes `Move Overhead × (2 + movestogo)` off
  the clock *before* it allocates anything, and with no `movestogo` it assumes
  50. The flat 250ms this used to ship therefore withheld **13 seconds** — 2% of
  a 10+0 clock and 22% of a 1+0 one — and below that the engine had nothing left
  to allocate and answered in **~2ms**. A bullet seat fell off a cliff a rapid
  seat never reached, and every game close at 15 seconds was thrown away.
  Measured on the same search at 15s left: 100ms of thinking at a 250ms reserve,
  517ms at 100ms. It is now scaled per game from the clock in `GameStart`
  (`timePolicy.ts moveOverheadMs`, `net.rs move_overhead_for`, both `initial/1000`
  clamped to 50–250, which pins the withheld share near 5.2% at any time
  control). Three riders. It is **not a user setting** — too low and the seat
  flags on latency, which reads as a loss rather than a bad preference, so it is
  deliberately absent from the bot panel. `house-bot.sh` must **not** pass
  `--move-overhead-ms` unless an operator pins it, or it overrides the scaling
  (that is what `overhead_args` is for). And the browser engine is **prewarmed
  before the time control is known**, so the seat re-sets the option on
  `game_start` and `your_turn` waits on that — the socket invokes both handlers
  concurrently, and without the barrier the first search of the game runs with
  no reserve set at all. `pnpm test:move` pins the ordering, and it only has
  teeth because the stub stalls; a harness that awaits each frame in turn cannot
  see the race.
- **A `movetime` alongside `wtime`/`btime` is a CEILING, never a floor.**
  Verified: `go wtime 10000 btime 10000 movetime 1000` still spends 2ms. So
  `--max-move-ms` works, but nothing of that shape can lift an engine off the
  collapse above — raising a floor means *replacing* the command with a bare
  `go movetime N` (which is exact: 500 → 501ms). That is the delegation-takeover
  work, and it is why `engine`/`pace` collapse while `fixed`/`fraction` don't.
- **A flag is a draw when the OPPONENT cannot mate** (FIDE 6.9), which is
  `has_insufficient_material(flagged.opposite())` — not `is_insufficient_material()`,
  which shakmaty defines as *neither* side being able to mate. Asking the latter
  awarded the game to a lone king whenever the flagging side still had material:
  flag with a queen against a bare king and the bare king took the point, and in
  a staked game the whole stake. Only reachable at low time, so it hid.
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
  recreates the instance.
  A third: **the vendored base CSS positions the a-h/1-8 labels in fixed
  pixels** (`coords.ranks { top: -20px }`, `coords.files { left: 24px }`) —
  lichess overrides those in its own stylesheet and we vendored only the base,
  so every label was offset by an amount that meant nothing at our board sizes
  (on the 380px settings preview the file letters straddled the boundary with
  the file to their left, `h` hung off the board, and the row sat 4px BELOW the
  last rank). `board.css` re-anchors both strips to the board in percentages and
  sizes the text in `cqw` — which is why `.cg-wrap` carries
  `container-type: inline-size`: without a query container a `cqw` falls back to
  the VIEWPORT and the labels render ~3x too big. `pnpm test:layout` pins both
  halves. And roughly a third of lichess's piece sets are
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
- **Almost every page is a Client Component, so metadata lives in a sibling
  `layout.tsx`.** `"use client"` and `export const metadata` are mutually
  exclusive, which is why each route has a three-line server layout next to its
  page. The two exceptions are `/terms` and `/privacy`, which are static prose
  with no client state: they are Server Components and export their own
  metadata, so don't "fix" them by adding a layout. A new route inherits the
  root title until you add one. The dynamic
  routes (`/game/[id]`, `/player/[ident]`) use `generateMetadata` there, and
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
- **Every localStorage key lives in `apps/web/lib/storage.ts`.** Four keys
  predate the `openchess.*` convention (`chess_token`, `chess_addr`,
  `bot_uci_options`, `browser_bot_config`); `readMigrated` adopts a legacy
  value on first read and deletes the old name. Do NOT drop that fallback until
  well past the point where returning visitors could still hold the old pair —
  removing it silently signs out every signed-in user, which is precisely the
  failure `authedFetch` exists to prevent (`pnpm test:auth` pins both the
  adoption and that a current value beats a stale legacy leftover). A test
  harness stubbing `window` must put `localStorage` on it, not only on
  `globalThis`: storage.ts reads `window.localStorage` to stay SSR-safe.
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

- **A seat's display name is the server's to decide, never the client's.** A
  wallet claims one **username** (`users.username`, unique on
  `lower(username)`); `start_game`'s `seat_info` (`main.rs`) resolves each seat
  to that handle, else its short address, and **never reads `SeatMeta.name` for
  a seat that has a wallet**. That single rule is the whole impersonation
  defence: while the browser declared its own label, any signed-in player could
  type somebody else's handle and the board would print it. Only a seat with NO
  wallet carries a chosen label, and it is `~`-decorated (`username::guest_label`)
  — `~` is outside `[A-Za-z0-9_]`, so a guest string is *incapable* of equalling
  a username. `park_create` snapshots `poster_name` from the poster's wallet for
  the same reason. Anything that reintroduces a client-supplied name on a
  wallet-bound seat re-opens this; `a_seat_shows_its_wallets_username_not_the_string_the_client_sent`
  is what fails. The rules live in TWO places by necessity — `crates/server/src/username.rs`
  enforces, `apps/web/lib/username.ts` mirrors for instant feedback, and the
  reserved lists are hand-synced (divergence fails soft, in the safe direction).
  Each side also keeps TWO gates that must not be merged: a SHAPE check for
  routing (`is_username_shape` / `isUsernameShape`) and the full check for
  writes. A reserved word has to stay **routable** while being unclaimable —
  merging them 404s a live profile the server still serves by address, which is
  exactly what happened to the house bot's own page.
  Four traps. **`users` could hold two rows per wallet** until migration 0018 —
  `upsert_user` bound the address raw (checksummed, via `seat_wallets`) while
  `set_avatar` lowercased it; reads folded through `lower(wallet)` with
  `fetch_optional` so it silently picked one, which a rating survives and a
  username does not. `users_wallet_lower_uidx` now makes a mixed-case insert fail
  loudly; keep `upsert_user`'s `.to_lowercase()`. **A username may not start with
  `0x`** and must never be reported as an address: `/players/{ident}` resolves
  BOTH, so an addressish name is unresolvable ambiguity and a lookalike squat.
  **`_` is both a legal username character and LIKE's wildcard** — the search
  prefix goes through `username::like_prefix` + `ESCAPE '\'`, and its btree needs
  `text_pattern_ops` or the typeahead seq-scans `users` per keystroke. And **the
  cooldown is a 403, not a 429**: this router already answers 429 from two
  different rate limits, and telling a throttled user "you can change again in 7
  days" is both wrong and unrecoverable-sounding.
- **The house bot is identified by WALLET, not by its name.** The lobby's
  play-now button finds its standing free offer via `house_wallet` on
  `GET /config` (from the `HOUSE_WALLET` env var). It used to match the literal
  string `"House Bot"` — impossible now that an offer's label is a resolved
  username, since that string has a space in it. **Set `HOUSE_WALLET` on Fly
  before deploying**, or the button silently degrades to its `/play` demo.
  That var also grants the bot its handle: `ensure_house_username` claims
  `HOUSE_USERNAME` (default `HouseBot`) for it at boot, because `housebot` is
  RESERVED to everyone else and so the bot cannot claim it through the API — the
  server has to hand it over. Idempotent, and cosmetic enough that every failure
  is a log line rather than a refused boot.

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
