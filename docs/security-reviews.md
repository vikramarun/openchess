# Security review history

A record of every security review of OpenChess and what came of it.

**These are internal reviews, not an audit.** Each round was a structured review
of the source, done largely with AI coding agents, across the contract, the Rust
server and money path, auth, and the web app. Each finding was fixed and
regression-tested, and the fixes themselves were reviewed. Nobody outside the
project has audited the contract or the server. Treat this as engineering
history, not assurance.

## Where things stand

The open items, in rough order of risk:

- **No third-party audit** of `ChessEscrow`. The server's 25 USDC stake cap is
  the guardrail standing in for one.
- **The oracle is a single hot key**, and it is trusted for every result. A
  tournament payout is not even constrained to the event's entrants onchain;
  the contract only enforces payouts ≤ pool. There is no dispute window.
- **The owner is a single hardware wallet,** and `setOracle` has no timelock.
- **Session tokens live in `localStorage`.** Any XSS could steal one, and a
  session can commit its wallet's escrow balance to staked games (up to the cap
  per game). It should become an httpOnly cookie.
- **Launch tokens ride in the WebSocket URL's query string.** They're bearer
  capabilities, so keep them on TLS and out of logs. A leaked one can only throw
  a game: payouts go to the seat's wallet, which is fixed when the escrow opens.
- **Collusion between two wallets one person controls** isn't prevented. Casual
  Elo is kept off the leaderboard to limit what it buys.
- **The tournament settle deadline is guarded by the server, not the
  contract** (v2 has one clock starting at creation). A two-clock contract that
  enforces it onchain was written and reverted undeployed; see
  [deployments.md](deployments.md).

Kinds of bugs found and fixed over the rounds below:
- Unauthenticated staking, seat hijacks, and impersonation through
  client-supplied names.
- Settlement that could strand funds, including a reverted transaction being
  treated as success.
- Races between timers and in-flight money operations.
- A clock that couldn't flag a player sitting at zero.
- Restarts that settled tournaments on unfinished games.
- A former owner keeping admin rights.

| Round | Date | Scope |
|---|---|---|
| 1 | 2026-05-29 | Prototype review: contract, server, auth, architecture |
| 2 | 2026-05-30 | Game modes and Merkle tournament settlement |
| 3 | 2026-05-30 | Pre-deploy: contract, backend operations, frontend |
| 4 | 2026-07-09 | Contract invariant testing, full-surface security |
| 5 | 2026-08-08 | Incidents from the first real deploy |
| 6 | 2026-08-09 | Launch review of the tournament and identity work |
| 7 | 2026-08-19 | Pre-launch security review (six findings) |
| 8 | 2026-10-17 | Reviews of round 7's fixes, plus accept/join hardening |

File and line references in each round point at the code as it was then.

---

# Round 1: prototype review

Scope: the whole repo (Solidity escrow, Rust server, engine, ledger and
persistence, Next.js web). Four review passes: contract security, Rust
concurrency and money path, auth/web/API, and architecture/trust model.
Severities: Critical = funds can be stolen or locked, or auth bypassed; High =
exploitable integrity or availability; Medium/Low = hardening.

**Verdict at the time.** Good bones: an IO-free authoritative `game-engine`, a
replay-guarded escrow with sound value conservation, and a transactional
outbox. But it was a trusted-operator system dressed as non-custodial, and the
off-chain identity layer wasn't connected to the onchain money layer. Not ready
for real money.

## CRITICAL

### C1: The staked wallet is never bound to the authenticated player; staking endpoints are unauthenticated
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
wrong party. **Fix:** require a SIWE session on all staking endpoints; derive seat
addresses from `wallet_for_token`, never the body; require counterparty consent
before `open_escrow`; make launch tokens single-use, bound to the authenticated
wallet, and delivered out of the query string; reject a second attach to an
occupied seat.

### C2: Settlement reliability: funds can be stranded or DB/chain can diverge
- The outbox worker marks a row `failed` **terminally** on *any* error including
  transient RPC blips, with no retry/backoff (`main.rs:108-145`). A `processing` row
  orphaned by a crash is never re-claimed (claim selects only `pending`).
- An "already settled" revert (after a crash between submit and mark) is
  misclassified as `failed` though funds actually moved.
- `open_escrow`/`create_game` failures are **logged and swallowed**, so the game still
  plays and later tries to settle against unlocked stake (`main.rs:240,252`).
- Result-finish then outbox-enqueue are **two non-atomic** DB calls (`room.rs:385,402`).
- Misconfigured chain creds **silently fall back to the log sink**
  (`ledger/src/lib.rs:55`): a "healthy" server accepts stakes and never settles them.

**Impact:** Locked funds never released (until `claimTimeout`); reconciliation reads
wrong status. **Fix:** single transaction for finish+enqueue; classify transient vs
terminal errors and retry with backoff; reaper for stale `processing`; treat
already-settled as success; **fail closed** if escrow-open or chain config fails for
a staked game.

---

## HIGH

### Contract (`contracts/src/ChessEscrow.sol`)
- **H1: `openGame` allows `white == black`** (`:151`): no equality check, so
  `locked[X] += stake` twice → `locked > bankroll` → `available()` underflows and
  reverts, freezing the user; on self-win the player loses `rake`. Add
  `require(white != black)` (and mirror in Rust `open_escrow`).
- **H2: `feeRecipient` as a game participant corrupts conservation** (`:182-189`):
  aliasing the fee slot as winner/loser can over-credit the pool → insolvency.
  Forbid `feeRecipient` from playing.
- **H3: No `SafeERC20`; USDC blacklist risk** (`:128,137`): raw bool interface; if
  the contract address is blacklisted the whole pool freezes. Use `SafeERC20`;
  credit deposits by measured balance delta; document the token must be standard USDC.
- **H4: Centralized keys, no recovery** (`:106,209`): `owner` can never be
  transferred (no `transferOwnership`), no `pause`, single `oracle` key controls all
  outcomes. Add `Ownable2Step` + `Pausable`; make the oracle a multisig/threshold key.
- **H5: Signed result has no `deadline`; domain separator pins `chainId` at
  construction** (`:53,111-121`): mempool-captured signatures are valid forever; fork
  replay possible. Add a `deadline` to `GameResult`; recompute the domain separator
  when `block.chainid` changes.

### Server / auth
- **H6: SIWE verification is too weak** (`auth.rs:63-91`): only checks a `Nonce:`
  line was issued and that the signature recovers *some* address. It ignores domain,
  URI, chainId, expiry, and never checks the recovered address equals the message's
  address line → phishing/cross-app replay; no expiry. Parse and verify the full
  EIP-4361 message.
- **H7: Room task panics on `self.game.unwrap()`** (`room.rs:217,377`): a panic
  silently bricks a game (no result, no settlement, locked funds). Use graceful
  `let Some(...) else`.
- **H8: Unbounded in-memory state + no rate limiting**: `tokens`, `rooms`,
  `park`, `tickets`, `tournaments` (`main.rs`/`matchmaking.rs`) and `nonces`,
  `sessions` (`auth.rs`) are never evicted; finished rooms are never removed. Trivial
  memory-exhaustion DoS via unauthenticated `/auth/nonce`, `/games`, `/queue`. Add
  TTL/eviction + rate limiting.
- **H9: CORS `permissive()` on a money API** (`main.rs:96`): any origin can drive
  all (unauthenticated) endpoints. Restrict to known origins.

---

## MEDIUM

- **M1: Results are oracle-asserted, not verifiable.** `server_sig` on `GameOver`
  is always `None` and `result_hash` uses a non-cryptographic `DefaultHasher`
  (`room.rs:424,449`). A malicious operator can sign the loser as winner within an
  open game with no onchain/off-chain proof to the contrary. Use a cryptographic
  commitment over the signed move log; consider an onchain dispute window.
- **M2: Financial-integrity cheating is unaddressed.** Two wallets one operator
  controls can wash-trade/launder by dumping a staked game (rake-only cost); no
  Sybil/rating/collusion controls. Reject same-controller seats; add ratings/limits.
- **M3: No reconnection.** `Resume`/`Heartbeat` are no-ops (`ws.rs:110`); a network
  blip flags you and loses the stake. Implement resume or a disconnect grace.
- **M4: Input validation / overflow.** `initial_secs * 1_000` can overflow `u64`
  (`main.rs:179`, `matchmaking.rs:47`); no max stake / time-control bounds;
  `U256 → u128` stake narrowing can panic (`main.rs:220`). Validate and bound inputs.
- **M5: Transport & token handling.** Defaults are `ws://`/`http://` (no TLS); the
  player token rides in the URL query; the session token sits in `localStorage`
  (XSS-exfiltratable). Enforce `wss`/`https`; move tokens off the query; prefer an
  httpOnly cookie or short-lived in-memory token.
- **M6: Fee can change mid-game** (`ChessEscrow.sol:185`): rake read at settle time;
  snapshot `feeBps` at `openGame`.

---

## LOW / NOTES

- Deterministic colors (poster / earlier-joiner always White): a minor fairness issue.
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
- **"non-custodial":** true for *custody*, misleading for *outcome authority*, since the
  operator dictates results within an open game.

## Engineering hygiene

No CI; no LICENSE file (despite `license.workspace`); no graceful shutdown; no
metrics; `ledger` has a compile-time dependency on the git-ignored `contracts/out/`
(clean checkout won't `cargo build` before `forge build`; vendor the ABI or use a
`build.rs`); outbox failures terminal; zero tests in the `server` crate (where C1
lives).

---

## Prioritized remediation roadmap

1. **C1**: bind seats to authenticated wallets; gate staking endpoints on SIWE;
   single-use wallet-bound tokens off the query string. *(blocks everything)*
2. **C2 / H7**: transactional + retrying outbox; fail-closed on escrow/config; no
   panics in the room task.
3. **Contract H1–H5**: `white != black`, exclude fee addr, `SafeERC20`,
   `Ownable2Step`+`Pausable`+multisig oracle, `deadline` in `GameResult`.
4. **H6 / H8 / H9**: full EIP-4361 verification; TTL/eviction + rate limiting;
   lock down CORS.
5. **M1**: verifiable results (sign the move-log commitment; dispute window).
6. **M2–M6**: anti-collusion, reconnection, input bounds, TLS/token handling.
7. **Hygiene**: CI (Postgres service + `forge build` before `cargo`), LICENSE,
   graceful shutdown, metrics, `server`/`byo-client` test coverage; correct README.

Solid at the time: `game-engine`, `ChessEscrow` conservation and refund
logic, the outbox schema. Prototype-only: seat↔wallet↔stake binding, gauntlet loop, tournament
money, reconnection, result verifiability, and server-layer hardening.

---

## Round 1 remediation

The Critical/High findings and most Mediums were addressed; remaining items are
deployment/ops or explicit product follow-ups.

| Finding | Status | Notes |
|---|---|---|
| C1 seat↔wallet binding | Fixed | Staking endpoints require SIWE; seats = authed wallet; `/games` casual-only; identical seats rejected; seat-occupancy guard blocks concurrent hijack. |
| C2 settlement reliability | Fixed | Transactional finish+enqueue; retry w/ attempt cap; stale-row reaper; idempotent already-settled; fail-closed on escrow/config. |
| H1 white==black | Fixed | Contract + Rust guards. |
| H2 feeRecipient as player | Fixed | Rejected in `openGame`. |
| H3 SafeERC20 | Fixed | `_callOptionalReturn` + deposit balance-delta. |
| H4 ownership/pause/oracle key | Partly | `Ownable2Step` + `Pausable` added; multisig/threshold oracle is an ops choice (deploy oracle as a multisig). |
| H5 deadline / domain separator | Fixed | `deadline` in `GameResult`; separator recomputed on chainId change. |
| H6 SIWE verification | Fixed | Domain + chainId + address-match + single-use TTL nonce. |
| H7 room panics | Fixed | `unwrap()`s removed; graceful guards. |
| H8 unbounded state / rate limit | Fixed | Room/token/offer/ticket/nonce/session eviction + TTL sweep. *Later:* per-IP rate limiting and global caps landed in-app (`ratelimit.rs`), plus a per-socket inbound frame budget; edge rate limiting is still an operator item. |
| H9 CORS | Fixed | Restricted to `WEB_ORIGIN` (default `localhost:3000`). |
| M1 result verifiability | Partly | `result_hash` is SHA-256 over the move log, and (later) the oracle signs it and clients verify against `/oracle`. An onchain dispute window is still open. |
| M2 collusion/wash-trading | Partly | Same-wallet seats rejected. *Later:* separate ranked and casual Elo (casual off the leaderboard), a same-wallet Elo guard, and cheap pooled tournaments must be invite/approval. Two cooperating wallets remain open. |
| M3 reconnection | Fixed | `Detach` on drop + resend-state on re-attach (clock still runs during disconnect, by design). |
| M4 input bounds | Fixed | Time-control + stake bounds; overflow-safe. |
| M5 transport/token | Partly | Launch tokens remain **bearer capabilities** (not wallet-bound), but the seat's *funds* are fixed to the authenticated wallet at escrow open, so a leaked token cannot redirect the payout, only throw the game. Concurrent hijack is blocked by the seat-occupancy guard, and the staked-offer's white token is only returned to the authenticated poster. Wallet-bound/single-use tokens, token-off-query, and wss/TLS remain deployment/product follow-ups. |
| M6 fee mid-game | Fixed | `feeBps` snapshotted at `openGame`. |
| Hygiene (LICENSE/CI/shutdown/tests) | Fixed | MIT LICENSE, GitHub Actions CI (Postgres + forge-before-cargo), graceful shutdown, server unit tests, README corrected. |

---

# Round 2: game modes and Merkle settlement

A second multi-agent review (contracts + frontend + backend) was run after the
two game modes and the Merkle-claim tournament settlement landed. No
critical/drain bug; the genuine findings were fixed:

| Finding | Sev | Status | Fix |
|---|---|---|---|
| Root-mode tournament could strand the pool remainder (leaves summing < pool) | Med | Fixed | `settleTournamentRoot` now takes a signed `totalPayout`; rake taken at settle; claims bounded by it → no unclaimable residual. |
| Tournament settlement not durable (transient RPC strands the pool) | High | Fixed | New `tournament_outbox` table + `tournament_settlement_worker` (retry + reaper + idempotent `is_tournament_settled`), mirroring per-game settlement. Verified live. |
| Unbounded entrants → quadratic-game DoS; pool overflow | High | Fixed | `MAX_TOURNAMENT_PLAYERS` cap in join; `checked_mul` in payout math. |
| Gauntlet stats poisoning via crafted `session_id` | Med | Fixed | A staked session can only be attributed games by its owner wallet. |
| `game_to_*` routing maps leak on abandoned games | Med | Fixed | Pruned against live rooms in the sweep task. |
| Anonymous buy-in tournament create burns oracle gas | Low | Fixed | Buy-in create now requires a SIWE session. |
| SIWE hardcoded Chain ID 8453 (breaks Base Sepolia / real domains); errors swallowed | High (FE) | Fixed | Chain id from the connected chain; sign-in errors surfaced in the UI. |
| WalletConnect projectId placeholder fails silently | Med (FE) | Fixed | Warns loudly in-browser when unset (injected wallets still work). |
| Spectator move-apply could throw and kill the WS loop | Low (FE) | Fixed | Legality-guarded apply + try/catch; plus WS reconnect with backoff. |
| Session token in localStorage; no money UI yet | Med (FE) | **Open** | Accepted while the token gated nothing onchain. Staking has since shipped, so a stolen session can now commit its wallet's balance to games; listed as open at the top of this doc. |

Confirmed correct by the review: pooled-at-entry solvency, settle-vs-refund
mutual exclusion, cross-tournament pool isolation, Merkle leaf double-hash
(second-preimage safe), no locks held across `.await`, payout ≤ pool, and
fail-closed on the money endpoints. Test count after round 2: **42** (20 Rust +
22 Foundry).

---

# Round 3: pre-deploy review + production readiness

A third full review (contract pre-deploy, backend ops-readiness, frontend + WASM
engine) found **no remaining fund-loss bug**. Code-fixable items were fixed; the
rest are operator/infra actions tracked in [operations.md](operations.md).

**Fixed in code:**
- Contract: `FeeUpdated` event + `oldOracle` in `OracleUpdated` (indexer
  reconciliation); explicit no-`settleTimeout`-setter guard comment; production
  `script/Deploy.s.sol` (canonical Base USDC, env-driven, verifiable).
- Backend: non-poisoning locks (`parking_lot`) so one panicked handler can't down
  an endpoint; supervised settlement/sweep workers (auto-restart); `REQUIRE_ONCHAIN`
  fail-fast boot profile; `/ready` (DB) distinct from `/health`; `TraceLayer`;
  SIGTERM-aware graceful shutdown; WS message/frame size caps + UCI-length cap.
- Frontend: WASM engine load-failure handling (`worker.onerror` rejects ready);
  resilient play client (resign instead of silent stall on engine failure /
  `move_rejected`; *later* an illegal engine move is retried and then replaced by
any legal move rather than resigned); SRI on CDN stylesheets (*later* moot: the
CSS is vendored and the CDN origin removed from the CSP); client-only wagmi config (kills the
  `indexedDB` prerender warning); honest "beta" labeling of the staked modes.

**Flagged to the operator (see [operations.md](operations.md)):** third-party contract audit;
deploy+verify with chosen params; HSM/KMS oracle key + multisig/timelock owner;
single-node-only (Redis/sharding needed for >1 replica); managed Postgres +
one-shot migrations; TLS + edge rate-limiting; settlement/outbox alerting;
legal/AML/licensing review; tournament-restart durability caveat; verifiable
results (`server_sig` + dispute window) as the remaining trust-model TODO.

See [ARCHITECTURE.md](../ARCHITECTURE.md) for system/flow/data diagrams.

---

## Round 3 follow-ups: verifiable results and tournament durability

The two trust-model/durability caveats from round 3 are now addressed and
live-verified:

- **Client-verifiable results.** The oracle EIP-191-signs each game's
  `result_hash`; `GameOver` carries `server_sig` and the server publishes the
  signer at `GET /oracle`. The web app recovers the signer (viem) and shows a
  "✓ Verified, signed by oracle 0x…" badge. Ledger test
  `signs_and_recovers_result_commitment` proves the round-trip. (A full onchain
  *dispute window* / optimistic fraud-proof remains future work.)
- **Tournament restart durability.** Tournaments and pairings are persisted
  (`tournaments`, `tournament_games`). *As first built*, a restart re-derived
  standings and settled completed tournaments by result. *That was later
  removed:* every `running` tournament is now abandoned on boot (entrants refund
  via `claimRefund`), a completed one settles only through the durable
  tournament outbox, and `open` tournaments are rehydrated in full so their
  onchain pools stay startable.

---

# Round 4: contract invariants and full-surface security

Two separate review passes: a Foundry deep-test pass on the escrow
and a full-surface security review of the money/auth code.

**Contract:** added a handler-driven **solvency invariant** (escrow USDC balance
always equals the sum of tracked bankrolls; `locked ≤ bankroll`), which held
across 128k random calls; plus a **conservation fuzz** test and a
**signature-malleability** (upper-half-`s`) test. 25 Foundry tests total.

**Security review: one High finding, now fixed; the rest verified sound.**

- **[Fixed] Tournament seat tokens leaked to unauthenticated callers (High).**
  `GET /tournaments/{id}` and `POST /tournaments/{id}/start` returned every
  game's `white_token`/`black_token`. A launch token is the sole authorization
  for a WebSocket seat, so anyone could connect to any entrant's game and throw
  it, steering standings and thus the onchain pool payout to other entrants.
  (The same class of bug was already guarded for 1v1 in `park_get`.) **Fix:**
  tokens are `#[serde(skip)]` in the public view; each entrant fetches only its
  own seat token via the authenticated `GET /tournaments/{id}/my-games` (keyed on
  the wallet; casual entrants were display names at the time and are wallets now).
  `tourney_start` is now organizer-gated for buy-in tournaments. Verified: the
  public view exposes only `game_id`/`white`/`black`; `/my-games` returns only
  the caller's token.
- **Verified sound (no findings):** seat→SIWE-wallet binding across all modes;
  SIWE nonce/session handling; contract access control (oracle-only opens,
  signature-gated settles, Ownable2Step); EIP-712 verification (low-`s`,
  `deadline`, `settled` replay guard, no digest collision with `sign_result`);
  accounting/solvency; Merkle-claim double-spend guards; fail-closed settlement
  worker; parameterized SQL (no injection).

Remaining (tracked, not security-blocking): Swiss/knockout tournament pairing
(only round-robin is implemented, though the UI advertises both). The
Merkle-claim and refund browser UIs have since shipped;
`apps/web/components/TournamentClaim.tsx` calls both `claimTournament` and
`claimRefund`, surfaced next to the bankroll by `ClaimWinnings.tsx`.


---

# Round 5: incidents from the first real deploy

Not an audit, but findings from putting the thing in front of users. Every one was
already documented somewhere, already had a mitigation, and happened anyway,
because nothing enforced them. That pattern is the actual finding.

| Finding | Sev | Status | Fix |
|---|---|---|---|
| Server ran as a two-machine HA pair | High (availability/auth) | Fixed | All live state is per-process, so the proxy alternating between machines meant a SIWE nonce issued by A failed to verify on B. That produced intermittent sign-in 401s indistinguishable from a client bug, and park offers appeared/vanished per refresh. `deploy-server.sh` now asserts the machine count; `singlenode.rs` independently watches `<app>.internal` and pages. |
| Server ran with no `DATABASE_URL` while `wager_enabled` | High (durability) | Fixed | No persistence and no settlement-outbox workers (they only spawn when a DB exists), so stakes settled "best-effort inline" with no retry, and one transient RPC failure would strand a stake until `claimTimeout`. `/ready` now fails on money-live-without-DB, and `REQUIRE_ONCHAIN=1` refuses the boot. |
| `/ready` reported healthy with no database | Med | Fixed | It pinged the DB only `if let Some(db)`, so a DB-less node was indistinguishable from a healthy one. This is *why* the finding above went unnoticed. |
| A stale bearer silently became anonymous | Med | Fixed | Auth is optional on casual offers, so an expired session posted an offer with no `poster_addr`. That broke the client's self-match guard (which keys on that field) and the server's same-wallet rejection (which needs both addresses), so the house bot repeatedly played itself. `authed_wallet_strict` now 401s a present-but-invalid credential; a genuinely anonymous caller is still allowed. |
| Expired session dead-ended the web UI | Med (UX) | Fixed | The 401 above surfaced as an unrecoverable error until a manual sign-out, landing on every returning user the day after a deploy, since sessions are in-memory with a 24h TTL. `authedFetch` drops the rejected token so the UI re-renders signed-out. |
| Published `v0.1.0` shipped a client that matched its own challenge | Med | Fixed | `compatible()` decided "not mine" from `poster_addr`, which is null on casual offers, so the check failed open. Now keyed on the offer id we posted. Re-tagged and republished. |

Nothing here touched fund safety: the money paths failed closed throughout, and
no stake was lost or mis-settled. The damage was availability, wasted debugging,
and a first-visitor experience that didn't work.

---

# Round 6: launch review (2026-08-09)

A review of the tournament, identity and sponsorship work (PRs #49-#58) before
launch, fixed in PR #60.

| Finding | Sev | Fix |
|---|---|---|
| Casual tournaments keyed entrants on a typed display name, so a joiner could enter as anyone, including another player, and the standings printed it | P0 | Every entrant is now the session's wallet; display names come from the wallet's username |
| Open free-entry (sponsored) events could be filled by one person's wallets to drain the sponsorship | P1 | A pooled event with an entry fee under 1 USDC must use invite or approval admission |
| Wallet writes could be sent on the wrong chain and hang waiting for a Base receipt | P1 | Every write pins the chain and fails cleanly on a mismatch |
| Free-entry events settled by Merkle root could leave winners unable to claim | P1 | Claims are authorized by the proof, not by an onchain entry |

# Round 7: pre-launch security review (2026-08-19)

Six findings, all fixed (commits `c229393`, `e3d146b`; merged in PR #64).

| ID | Finding | Fix |
|---|---|---|
| H-01 | Alloy resolves a receipt as `Ok` even when the transaction reverted, so every write path treated reverts as success. Effects: an entrant who never paid joined the field, a game ran as staked with nothing locked, and a reverted settlement was recorded as settled | All writes go through `OnchainSettlement::confirm`, which fails on a revert. Each write then re-reads its postcondition from the chain, and both outboxes re-read the chain before marking anything settled |
| H-02 | The lobby's TTL sweep deleted rows by age alone, so it could delete an offer mid-accept. The poster's seat was lost, and the room then handed the acceptor the win and the pot | The sweep branches on state: rows mid-match survive on a lease longer than the room's start window, and matched rows survive while their game is live |
| M-01 | Tournament games were playable before their outcome routing existed, and one slow bot agent could stall a whole round | Routing and the tournament's own record are registered before any seat is delivered; agent dispatch is time-bounded and aborts with a refund |
| M-02 | A tournament could keep filling, or keep playing, after its settle window had closed, so it paid nobody | The server sizes joins and starts against the live onchain deadline. The contract half (a second clock) was reverted undeployed, so this is mitigated, not fixed at the root |
| M-03 | A player who stopped reading their socket filled its queue and froze the room actor, along with the clock, the opponent and settlement | Delivery to a client never blocks an actor (`try_send`); inbound frames are budgeted per socket |
| M-04 | The escrow owner was cached at boot, so a former owner kept admin rights after an ownership transfer | The owner is re-read from the chain on every privileged call, failing closed |

Fixed alongside these:

- **Signed clocks.** The server clock is now signed. An overrun is carried as a
  debt instead of being floored at zero, which had let a side at 0 ms keep
  playing inside the lag allowance.
- **Flag rule.** A flag is a draw only when the *opponent* can't mate (FIDE
  6.9). Previously it was a draw whenever *neither side* could mate, so a
  player who flagged with a queen against a bare king lost the game.

# Round 8: reviews of the fixes (2026-10-17)

Two review passes over round 7's fixes found bugs the fixes themselves had
introduced, and a hardening pass on accepts and joins followed (PRs #64, #66).

- **The shutdown drain paid out a tournament on unfinished games.** It ended
  games as aborted draws and reported them as results, so a deploy during a
  final round completed the event and paid its pool. Drained games are now
  unreported and unrated, and the event is abandoned so entrants refund.
- **Starts could race the drain.** A start already waiting on `openGame` when
  shutdown began was missed and stranded its stake. A handshake now makes the
  drain wait for starts in flight and alert on any it times out on.
- **One stale read rolled back a write that had landed.** A load-balanced RPC
  can answer from a node a block behind the receipt. Postcondition reads now
  retry until they hold, and entry is idempotent, so a retry can't revert
  forever.
- **A finished game's result could be dropped.** Tournament routes were pruned
  while a result was still queued; they're now kept until the event is over.
- **The inbound frame budget flagged fast bots.** It had been set to 20 frames
  a second, which flagged legitimate fast engine-vs-engine games; it's now 500.
- **Disconnects could forfeit stakes.** Money-moving handlers now finish in a
  spawned task. If the requester disconnected before receiving their seat, the
  game is aborted and refunded rather than forfeited.
- **Paid entries could be lost.** Entries are recorded before the buy-in moves,
  reconciled with the chain at start, and refunded at settlement if still
  unseated.

