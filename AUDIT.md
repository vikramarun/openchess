# OpenChess — Security & Correctness Audit

Scope: full repo (Solidity escrow, Rust server/engine/ledger/persistence, Next.js
web). Method: four independent review passes (contract security, Rust
concurrency/money-path, auth/web/API, architecture/trust-model), cross-checked
against the source. This is a **prototype** audit: it documents what must change
before the system handles real money. Severities: Critical = funds can be
stolen/locked or auth bypassed; High = exploitable integrity/availability;
Medium/Low = hardening.

## Overall verdict

Good bones — an IO-free authoritative `game-engine`, a replay-guarded escrow with
sound value-conservation, and a transactional outbox. But it is **a trusted-
operator system in non-custodial clothing**, and the off-chain identity layer is
not connected to the on-chain money layer. **Not production-ready for real money.**

---

## CRITICAL

### C1 — The staked wallet is never bound to the authenticated player; wager endpoints are unauthenticated
The single most important finding (independently flagged by three of four passes).
- `/games`, `/park/offers`, `/park/offers/{id}/accept`, `/queue` take `white_addr`/
  `black_addr`/`stake` from the **request body** with no auth, and feed them straight
  into `open_escrow` → `openGame` (`server/src/main.rs:155-157,245-253`;
  `matchmaking.rs`). Any anonymous caller can lock a **victim's** deposited bankroll
  into a game they never agreed to.
- SIWE exists but is **decorative**: `Auth::wallet_for_token` is read only by
  `/auth/me` (`server/src/auth.rs:28,110`). No gameplay path consults it.
- Launch tokens map `token → (game, color)`, are **never removed**, are passed in
  the **URL query** (`ws.rs:18`, leaks via logs/proxies/Referer), and are not bound
  to the staked wallet. Whoever holds the token plays that seat; the payout goes to
  the seat **address** regardless of who actually moved (`room.rs:393-398`). A second
  connection with the same token silently steals the seat (`room.rs:173-177`).

**Impact:** Unauthorized staking of third-party funds; seat hijack; payout to the
wrong party. **Fix:** require a SIWE session on all wager endpoints; derive seat
addresses from `wallet_for_token`, never the body; require counterparty consent
before `open_escrow`; make launch tokens single-use, bound to the authenticated
wallet, and delivered out of the query string; reject a second attach to an
occupied seat.

### C2 — Settlement reliability: funds can be stranded or DB/chain can diverge
- The outbox worker marks a row `failed` **terminally** on *any* error including
  transient RPC blips, with no retry/backoff (`main.rs:108-145`). A `processing` row
  orphaned by a crash is never re-claimed (claim selects only `pending`).
- An "already settled" revert (after a crash between submit and mark) is
  misclassified as `failed` though funds actually moved.
- `open_escrow`/`create_game` failures are **logged and swallowed** — the game still
  plays and later tries to settle against unlocked stake (`main.rs:240,252`).
- Result-finish then outbox-enqueue are **two non-atomic** DB calls (`room.rs:385,402`).
- Misconfigured chain creds **silently fall back to the log sink**
  (`ledger/src/lib.rs:55`): a "healthy" server accepts wagers and never settles them.

**Impact:** Locked funds never released (until `claimTimeout`); reconciliation reads
wrong status. **Fix:** single transaction for finish+enqueue; classify transient vs
terminal errors and retry with backoff; reaper for stale `processing`; treat
already-settled as success; **fail closed** if escrow-open or chain config fails for
a wagered game.

---

## HIGH

### Contract (`contracts/src/ChessEscrow.sol`)
- **H1 — `openGame` allows `white == black`** (`:151`): no equality check, so
  `locked[X] += stake` twice → `locked > bankroll` → `available()` underflows and
  reverts, freezing the user; on self-win the player loses `rake`. Add
  `require(white != black)` (and mirror in Rust `open_escrow`).
- **H2 — `feeRecipient` as a game participant corrupts conservation** (`:182-189`):
  aliasing the fee slot as winner/loser can over-credit the pool → insolvency.
  Forbid `feeRecipient` from playing.
- **H3 — No `SafeERC20`; USDC blacklist risk** (`:128,137`): raw bool interface; if
  the contract address is blacklisted the whole pool freezes. Use `SafeERC20`;
  credit deposits by measured balance delta; document the token must be standard USDC.
- **H4 — Centralized keys, no recovery** (`:106,209`): `owner` can never be
  transferred (no `transferOwnership`), no `pause`, single `oracle` key controls all
  outcomes. Add `Ownable2Step` + `Pausable`; make the oracle a multisig/threshold key.
- **H5 — Signed result has no `deadline`; domain separator pins `chainId` at
  construction** (`:53,111-121`): mempool-captured signatures are valid forever; fork
  replay possible. Add a `deadline` to `GameResult`; recompute the domain separator
  when `block.chainid` changes.

### Server / auth
- **H6 — SIWE verification is too weak** (`auth.rs:63-91`): only checks a `Nonce:`
  line was issued and that the signature recovers *some* address. It ignores domain,
  URI, chainId, expiry, and never checks the recovered address equals the message's
  address line → phishing/cross-app replay; no expiry. Parse and verify the full
  EIP-4361 message.
- **H7 — Room task panics on `self.game.unwrap()`** (`room.rs:217,377`): a panic
  silently bricks a game (no result, no settlement, locked funds). Use graceful
  `let Some(...) else`.
- **H8 — Unbounded in-memory state + no rate limiting**: `tokens`, `rooms`,
  `park`, `tickets`, `tournaments` (`main.rs`/`matchmaking.rs`) and `nonces`,
  `sessions` (`auth.rs`) are never evicted; finished rooms are never removed. Trivial
  memory-exhaustion DoS via unauthenticated `/auth/nonce`, `/games`, `/queue`. Add
  TTL/eviction + rate limiting.
- **H9 — CORS `permissive()` on a money API** (`main.rs:96`): any origin can drive
  all (unauthenticated) endpoints. Restrict to known origins.

---

## MEDIUM

- **M1 — Results are oracle-asserted, not verifiable.** `server_sig` on `GameOver`
  is always `None` and `result_hash` uses a non-cryptographic `DefaultHasher`
  (`room.rs:424,449`). A malicious operator can sign the loser as winner within an
  open game with no on-chain/off-chain proof to the contrary. Use a cryptographic
  commitment over the signed move log; consider an on-chain dispute window.
- **M2 — Financial-integrity cheating is unaddressed.** Two wallets one operator
  controls can wash-trade/launder by dumping a staked game (rake-only cost); no
  Sybil/rating/collusion controls. Reject same-controller seats; add ratings/limits.
- **M3 — No reconnection.** `Resume`/`Heartbeat` are no-ops (`ws.rs:110`); a network
  blip flags you and loses the stake. Implement resume or a disconnect grace.
- **M4 — Input validation / overflow.** `initial_secs * 1_000` can overflow `u64`
  (`main.rs:179`, `matchmaking.rs:47`); no max stake / time-control bounds;
  `U256 → u128` stake narrowing can panic (`main.rs:220`). Validate and bound inputs.
- **M5 — Transport & token handling.** Defaults are `ws://`/`http://` (no TLS); the
  player token rides in the URL query; the session token sits in `localStorage`
  (XSS-exfiltratable). Enforce `wss`/`https`; move tokens off the query; prefer an
  httpOnly cookie or short-lived in-memory token.
- **M6 — Fee can change mid-game** (`ChessEscrow.sol:185`): rake read at settle time;
  snapshot `feeBps` at `openGame`.

---

## LOW / NOTES

- Deterministic colors (poster / earlier-joiner always White) — minor wager fairness.
- `settleGame` vs `claimTimeout` race once timeout elapses lets a loser force a refund.
- `zero-stake` games use `stake != 0` as the existence sentinel (`openGame` `:153`).
- WalletConnect `projectId` ships a `"demo-project-id"` placeholder.
- Spectator `GameStart` hardcodes `your_color: White` (`room.rs:243`).
- Anvil keys in `scripts/onchain-demo.sh` are the well-known public test keys (fine).

---

## Completeness vs README (overclaims to correct)

- **`server` "verified end-to-end"** but the crate has **zero unit tests** (only the
  shell demo). `byo-client` tests cover only the book; `persistence`'s one test
  **no-ops without `DATABASE_URL`**.
- **"Three modes work":** Park works. **Gauntlet auto-requeue is absent** on both
  client and server (single pairing only). **Tournament scoring + prize payout are
  stubbed** (`tourney_start` passes `wager: None`; no standings/payout; the escrow has
  no pooled-prize method). The README's "Not yet wired" section is honest, but the
  summary contradicts it.
- **"non-custodial":** true for *custody*, misleading for *outcome authority* — the
  operator dictates results within an open game.

## Engineering hygiene

No CI; no LICENSE file (despite `license.workspace`); no graceful shutdown; no
metrics; `ledger` has a compile-time dependency on the git-ignored `contracts/out/`
(clean checkout won't `cargo build` before `forge build` — vendor the ABI or use a
`build.rs`); outbox failures terminal; zero tests in the `server` crate (where C1
lives).

---

## Prioritized remediation roadmap

1. **C1** — bind seats to authenticated wallets; gate wager endpoints on SIWE;
   single-use wallet-bound tokens off the query string. *(blocks everything)*
2. **C2 / H7** — transactional + retrying outbox; fail-closed on escrow/config; no
   panics in the room task.
3. **Contract H1–H5** — `white != black`, exclude fee addr, `SafeERC20`,
   `Ownable2Step`+`Pausable`+multisig oracle, `deadline` in `GameResult`.
4. **H6 / H8 / H9** — full EIP-4361 verification; TTL/eviction + rate limiting;
   lock down CORS.
5. **M1** — verifiable results (sign the move-log commitment; dispute window).
6. **M2–M6** — anti-collusion, reconnection, input bounds, TLS/token handling.
7. **Hygiene** — CI (Postgres service + `forge build` before `cargo`), LICENSE,
   graceful shutdown, metrics, `server`/`byo-client` test coverage; correct README.

Production-ready today: `game-engine`, `ChessEscrow` conservation/refund logic,
outbox schema. Prototype-only: seat↔wallet↔stake binding, gauntlet loop, tournament
money, reconnection, result verifiability, and server-layer hardening.

---

## Remediation status (post-fix)

The Critical/High findings and most Mediums were addressed; remaining items are
deployment/ops or explicit product follow-ups.

| Finding | Status | Notes |
|---|---|---|
| C1 seat↔wallet binding | Fixed | Wager endpoints require SIWE; seats = authed wallet; `/games` casual-only; identical seats rejected; seat-occupancy guard blocks concurrent hijack. |
| C2 settlement reliability | Fixed | Transactional finish+enqueue; retry w/ attempt cap; stale-row reaper; idempotent already-settled; fail-closed on escrow/config. |
| H1 white==black | Fixed | Contract + Rust guards. |
| H2 feeRecipient as player | Fixed | Rejected in `openGame`. |
| H3 SafeERC20 | Fixed | `_callOptionalReturn` + deposit balance-delta. |
| H4 ownership/pause/oracle key | Partly | `Ownable2Step` + `Pausable` added; multisig/threshold oracle is an ops choice (deploy oracle as a multisig). |
| H5 deadline / domain separator | Fixed | `deadline` in `GameResult`; separator recomputed on chainId change. |
| H6 SIWE verification | Fixed | Domain + chainId + address-match + single-use TTL nonce. |
| H7 room panics | Fixed | `unwrap()`s removed; graceful guards. |
| H8 unbounded state / rate limit | Fixed (mem) / deferred (rate limit) | Room/token/offer/ticket/nonce/session eviction + TTL sweep. Edge rate-limiting left to deployment. |
| H9 CORS | Fixed | Restricted to `WEB_ORIGIN` (default `localhost:3000`). |
| M1 result verifiability | Partly | `result_hash` now SHA-256 over the move log. `server_sig` to clients + on-chain dispute window TODO. |
| M2 collusion/wash-trading | Deferred | Same-wallet seats rejected; rating/Sybil controls are product follow-ups. |
| M3 reconnection | Fixed | `Detach` on drop + resend-state on re-attach (clock still runs during disconnect, by design). |
| M4 input bounds | Fixed | Time-control + stake bounds; overflow-safe. |
| M5 transport/token | Partly | Launch tokens remain **bearer capabilities** (not wallet-bound), but the seat's *funds* are fixed to the authenticated wallet at escrow open — a leaked token cannot redirect winnings, only throw the game. Concurrent hijack is blocked by the seat-occupancy guard, and the staked-offer's white token is only returned to the authenticated poster. Wallet-bound/single-use tokens, token-off-query, and wss/TLS remain deployment/product follow-ups. |
| M6 fee mid-game | Fixed | `feeBps` snapshotted at `openGame`. |
| Hygiene (LICENSE/CI/shutdown/tests) | Fixed | MIT LICENSE, GitHub Actions CI (Postgres + forge-before-cargo), graceful shutdown, server unit tests, README corrected. |
