# Tournaments — respec

_Status: **Part 1 + the dispatch prerequisite are implemented.** Part 2
(sponsorship) and Part 3 (admission control) are still proposed — both wait on
the contract v2 decision._

Two asks drive this:

1. **Creator-defined payout structures** — the 65/25/10 split is hardcoded.
2. **Sponsored tournaments** — a sponsor funds the prize pool; entrants join
   free or for a nominal fee.

They split cleanly by cost: **(1) needs no contract change and ships on the live
escrow. (2) needs a new contract deployment.** Sequence them that way.

---

## Why (2) needs a new contract

[`ChessEscrow.sol`](contracts/src/ChessEscrow.sol) blocks sponsorship two ways:

- `openTournament` reverts on `buyIn == 0` (`ZeroStake`), so free entry is
  impossible.
- Nothing can add to `t.pool` except `enterTournament`. There is no path for a
  third party to fund a pool at all.

Whereas `settleTournament(tid, winners[], payouts[], …)` and
`settleTournamentRoot` already accept **any** distribution the oracle signs —
the only onchain rule is `sum(payouts) <= pool`, with the remainder raked. So
arbitrary payouts are purely a server concern today.

---

## Model

`buy_in: Option<String>` currently means five things at once: has an onchain
pool, entrant identity is a wallet, ranked ladder, organizer-gated start, and
authenticated `my-games`. Rather than unpick all five, keep the field as the
**"has a pool"** flag and let its value be zero:

| `buy_in` | meaning |
|---|---|
| `None` | casual — no onchain pool, entrants are display names, casual ladder |
| `Some("0")` | pool exists, **entry is free** (sponsor-funded) |
| `Some(n)` | pool exists, entry costs `n` base units |

Every existing `buy_in.is_some()` check stays correct unmodified. What changes
is the small number of places that read the *value*.

Three tournament kinds fall out:

| kind | entry fee | sponsorship | pool | entrants |
|---|---|---|---|---|
| Casual | — | — | none | display names |
| Buy-in | > 0 | optional | `fee × n` + sponsorship | wallets |
| Sponsored | 0 or nominal | > 0 | `fee × n` + sponsorship | wallets |

"Overlay" events (guaranteed pool *plus* buy-ins) fall out for free — they are
just the third row with a non-zero fee.

**Any tournament with a pool needs wallet entrants**, because payouts are
addresses. That is already true and stays true.

---

## Part 1 — creator-defined payouts (no contract change) — **IMPLEMENTED**

`PayoutSpec` in [matchmaking.rs](crates/server/src/matchmaking.rs), migration
[0017](crates/persistence/migrations/0017_tournament_payout.sql),
`tournament_pool` in [ledger](crates/ledger/src/lib.rs).

**One behaviour change to know about:** a two-entrant tournament used to be
special-cased at 70/30 by the old `payout_weights`. The default structure is now
a single table (65/25/10) renormalized to the field, so heads-up pays 72.2/27.8.
Nothing pinned 70/30, and a creator who wants it can now say `bps: [7000, 3000]`
— but it is a silent change for existing heads-up events. Every other field size
settles exactly as before.

### Spec

```rust
/// Basis points per finishing place, best first.
struct PayoutSpec { bps: Vec<u16> }
```

Default `[6500, 2500, 1000]`, which reproduces today's behaviour exactly.

Validated at create, rejected with 400:

- non-empty, `len <= MAX_TOURNAMENT_PLAYERS`
- **sums to exactly 10_000.** Not `<=`. Tournaments rake 0% today
  (`payout_split` pushes the remainder to the top so the whole pool is
  distributed); allowing a short sum turns creator sloppiness into silent house
  revenue. If we ever want a tournament rake, make it an explicit platform
  parameter, not an emergent property of a creator's arithmetic.
- non-increasing. Paying 2nd more than 1st is a typo, not a design, and
  monotonicity is what makes the tie-bracket rule below coherent.

### Field smaller than the structure

50/30/20 with two entrants orphans the third weight. **Truncate to the field
size, then renormalize proportionally** → 62.5/37.5. This preserves the
existing "full pool reaches players, zero rake" property. The alternative
(orphaned weight becomes rake) quietly pays the house for a short field.

### What must not change

`payout_split`'s tie handling: contiguous equal scores pool their combined slots
and split evenly, with indivisible dust handed out one base unit apiece from the
top. That was a real fix — position among equal scores is decided by join order,
so position-based money made pressing Join first worth a quarter of the pool.
Creator-defined weights make brackets *more* lopsided (winner-take-all turns a
two-way tie for first into a coin flip on join order), so this matters more, not
less.

Also keep the ranked-order guard that returns `Err` — a bad call must pay nobody
and stay retriable, not `debug_assert` its way into a release build.

### Pool must be read, not derived

`distribute_pool` computes `pool = buy_in × entrants`. That is wrong the moment
sponsorship exists, and it is already fragile (a silently failed
`enterTournament` would overstate it). Add to the ledger trait:

```rust
async fn tournament_pool(&self, tid: Uuid) -> anyhow::Result<U256>;
```

and settle against the truth. Read it in the **outbox worker immediately before
signing**, not at completion — that narrows the window in which a late sponsor
deposit becomes rake to a block or two. (Late sponsorship raking is accepted,
documented behaviour; see the open question at the end.)

### Persistence

Migration `0017`:

```sql
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS
  payout JSONB NOT NULL DEFAULT '{"bps":[6500,2500,1000]}';
```

`recover_tournaments` **must** restore it. An open tournament that rehydrates
with the default structure pays a field something other than what it was
promised — the same class of bug as the missing-organizer one that
`is_rehydratable` exists to prevent, but silent, since the money still moves.

### Views

`TourneyView` gains `payout` plus a **resolved prize table in USDC for the
current field**, computed by calling `payout_split` itself. Same principle as
`ranked_entrants`: one function, so what a player is looking at is what the pool
pays. A prize table computed a second way in the UI will drift.

---

## Part 2 — sponsorship (contract v2) — **BUILT, NOT DEPLOYED**

Contract ([ChessEscrow.sol](contracts/src/ChessEscrow.sol)): zero buy-in,
`sponsorTournament`, `refundSponsorship`, the `claimRefund` zero-buy-in guard,
and a solvency invariant that now actually covers pools.

Server ([matchmaking.rs](crates/server/src/matchmaking.rs)): the three-kind
model on `buy_in` (`None` / `Some("0")` / `Some(n)`), free entry skipping
`enterTournament`, `tournament_ladder` keyed on the entrant's risk rather than
on the pool's existence, `pool_refresh_task` polling the pool sponsorship makes
underivable, and a guard against starting an unfunded free event.

Web: `kindOf` + a shared `Terms` component so a free event doesn't render as
"0 USDC entry, Ranked"; `SponsorPool` to fund a pool from the sponsor's own
bankroll; a local record of sponsored ids so the claim panel can offer
`refundSponsorship` (the server's claimable list is entrants-only, and a sponsor
is not an entrant); and no refund button where the contract refuses one.

**Nothing is deployed** — see the warning at the top of
[DEPLOYMENTS.md](DEPLOYMENTS.md). Remaining: Part 3 (admission control), and the
audit + bankroll migration.

### Contract changes

```solidity
struct Tournament {
    uint256 buyIn;          // may now be 0
    uint256 pool;
    uint256 claimedAmount;
    uint32  entrants;
    uint64  openedAt;
    bool    settled;
    bytes32 payoutRoot;
    bool    exists;
}

mapping(bytes32 => mapping(address => uint256)) public sponsorship;  // NEW
```

**1. `openTournament`: drop the `buyIn == 0` revert.** Nothing downstream
divides by it.

**2. New `sponsorTournament(bytes32 tid, uint256 amount)`** — permissionless,
**not** oracle-gated. It moves the caller's *own* unlocked bankroll into a named
pool, which is the same trust model as `deposit`: no one else's funds are
reachable, so gating it would only add an oracle round trip and a gas bill.

```solidity
function sponsorTournament(bytes32 tid, uint256 amount) external whenNotPaused nonReentrant {
    Tournament storage t = tournaments[tid];
    if (!t.exists) revert UnknownTournament();
    if (t.settled) revert AlreadySettled();
    if (amount == 0) revert ZeroStake();
    if (block.timestamp > t.openedAt + settleTimeout) revert SettleWindowClosed();
    if (available(msg.sender) < amount) revert InsufficientUnlocked();
    bankroll[msg.sender] -= amount;
    t.pool += amount;
    sponsorship[tid][msg.sender] += amount;
    emit TournamentSponsored(tid, msg.sender, amount);
}
```

The `SettleWindowClosed` check matters: without it, someone can fund a pool that
can never be settled, and the funds sit until the sponsor refunds them.

**3. New `refundSponsorship(bytes32 tid, address sponsor)`** — this is not
optional. The server **deliberately abandons `running` tournaments on restart**
(their rooms are gone and partial standings must never reach settlement). Today
that costs entrants a buy-in they recover via `claimRefund`; with sponsorship it
would strand the sponsor's entire pool **permanently**, because `claimRefund`
only ever returns `t.buyIn` to entrants.

```solidity
function refundSponsorship(bytes32 tid, address sponsor) external {
    Tournament storage t = tournaments[tid];
    if (!t.exists) revert UnknownTournament();
    if (t.settled) revert AlreadySettled();
    if (block.timestamp <= t.openedAt + settleTimeout) revert TimeoutNotReached();
    uint256 amt = sponsorship[tid][sponsor];
    if (amt == 0) revert NotEntered();
    sponsorship[tid][sponsor] = 0;
    t.pool -= amt;
    bankroll[sponsor] += amt;
    emit TournamentSponsorRefunded(tid, sponsor, amt);
}
```

**Sponsorship is irrevocable before the timeout, by design.** A sponsor who
could withdraw at will could rug a field that paid to enter a "500 USDC"
event.

**4. Guard `claimRefund` against a zero buy-in** (`if (t.buyIn == 0) revert
ZeroStake()`), so a free entrant can't burn their `tournamentClaimed` flag on a
0-value refund.

### Gas: skip `enterTournament` when entry is free

A zero buy-in entry moves no money. The only onchain consumer of
`tournamentEntered` is `claimRefund`, which has nothing to refund at zero. So
**only call `enterTournament` when the fee is > 0** — a free sponsored
tournament then costs the oracle exactly two transactions (`openTournament` +
settle) regardless of field size.

### Sponsorship is a browser transaction

The sponsor signs `sponsorTournament` from their own wallet, exactly like
`deposit` — the server never touches it and needs no authed endpoint. It learns
the pool by reading `tournaments(tid).pool` (the same call Part 1 adds) and can
list sponsors from `TournamentSponsored` events for display.

### The solvency invariant is currently blind to pools

`Invariant.t.sol`'s handler only does deposit / withdraw / openGame /
settleGame — **no tournament path is fuzzed at all**, so `t.pool` is always zero
and the asserted invariant (`balanceOf == sum(bankroll)`) holds trivially. Any
pool-mutating code lands with no invariant coverage.

Before shipping v2: extend the handler with `enterTournament`,
`sponsorTournament`, `settleTournament`, `claimTournament`, `claimRefund`,
`refundSponsorship`, and correct the invariant to

```
token.balanceOf(escrow) == sum(bankroll) + sum(tournament pools)
```

---

## Part 3 — admission control

The creator picks one. All three are per-tournament settings, chosen at create.

| mode | mechanism | trust |
|---|---|---|
| **Nominal fee** | `buy_in` > 0, however small | **onchain.** The only trustless one — N fake entrants cost N × fee, and the fee lands in the pool they are trying to farm |
| **Invite codes** | organizer mints single-use codes; join requires one | server policy |
| **Approval** | join creates a request; organizer approves | server policy |

Invite codes should reuse the single-use link-code machinery in `auth.rs`
(`POST /auth/link` → `/auth/link/claim`) rather than growing a second
one-shot-credential implementation.

### The ordering rule for approval + paid entry

**Approval must precede payment, always.** There is no onchain path to return a
rejected applicant's entry before the settle timeout, so an applicant who pays
first and is then rejected has USDC locked in a pool they are not in — which is
exactly the failure `tourney_join` already fires a `🚨` alert for when a buy-in
lands after start.

So a gated join is two-phase:

```
POST /tournaments/{id}/requests      → pending          (no money moves)
POST /tournaments/{id}/requests/{addr}/approve   (organizer)
POST /tournaments/{id}/join          → enterTournament  (money moves)
```

New routes: `POST /tournaments/{id}/invites` (organizer, mint), the three
request routes above, and `GET /tournaments/{id}` gains the caller's own
admission status.

Persistence (same migration `0017`, and all restored by `recover_tournaments` —
an open tournament that rehydrates with its door open is a gate that silently
stopped existing):

```sql
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS admission TEXT NOT NULL DEFAULT 'open';
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS invites   JSONB NOT NULL DEFAULT '{}';
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS approvals JSONB NOT NULL DEFAULT '{}';
```

---

## Ladder: free entry should be casual

`tournament_ladder` currently returns `Ranked` for any buy-in tournament, on the
rule that **money at risk** is what makes a game ranked. Free entry breaks that:
two cooperating wallets can enter a free sponsored event and trade wins to farm
ranked Elo at zero cost, which is precisely why casual Elo is kept off the
leaderboard.

Recommendation: **`Ranked` iff `entry_fee > 0`**, else `Casual`. The creator
already sets the fee, so a nominal 1 USDC buys both sybil resistance and a
ranked event — the incentives line up on their own. Prizes are real either way.

---

## Rollout

**Phase 1 — live contract, no redeploy.** Creator-defined weights, validation,
renormalization, `tournament_pool` read, prize table in views, migration `0017`
for `payout`, rehydration. Independently shippable and useful on its own.

**Phase 2 — contract v2.** Sponsorship, free entry, admission control. Requires:

- audit first (`PRODUCTION.md` already gates raising `MAX_STAKE` on one, and
  this adds new money paths to an unaudited contract)
- a **bankroll migration**: balances live inside the current escrow, so users
  must withdraw from v1 and deposit into v2. Keep v1 live until its in-flight
  games and tournaments settle; point the server at v2 for new ones. Small
  mercy — `MAX_STAKE` is 25 USDC, so bankrolls are small.
- `DEPLOYMENTS.md` + Basescan verification for the new address

---

## Tests this needs

- `payout_split`: sums to exactly `pool` for every valid spec × field size;
  ties split evenly; renormalization on a short field; rejects unranked
  standings; rejects specs that don't sum to 10_000 at create.
- Rehydration: payout spec, admission mode, invites, and approvals survive the
  durable round trip (mirror `bot_entrants_survive_the_durable_round_trip`).
- Foundry: sponsor → settle, sponsor → timeout → `refundSponsorship`,
  free-entry open/settle, sponsorship after the settle window reverts.
- Invariant handler extended to cover pools, with the corrected invariant.

---

## Resolved

**Late sponsorship rakes — accepted.** A deposit landing between the
settle-signing pool read and the onchain submit is not in `sum(payouts)`, so the
contract rakes it to the fee recipient. Reading the pool in the outbox worker
immediately before signing narrows the window to a block or two. No
`closeSponsorship` tx; alert if the pool at submit differs from the pool at
completion.

---

## Prerequisite — a restart still kills a running tournament — **FIXED**

Not a player leaving (a no-show forfeits their pairing and the event rolls on) —
the **server process** restarting: any `crates/*` deploy, a crash, a Fly machine
replacement. Rooms are in-process actors, so a restart evaporates every live
game, and `recover_tournaments` then marks every `running` tournament
`abandoned` on purpose: forfeits are memory-only, only rounds dispatched so far
are persisted, and settling on partial standings is permanent
(`AlreadySettled`).

Nobody loses funds — entrants `claimRefund`, the sponsor `refundSponsorship`.
The cost is a 24h lockup and a dead event, which is tolerable for a 1 USDC
buy-in and bad when a sponsor's name is on it.

**The intended workaround is currently unsafe, and this must be fixed
regardless of sponsorship.** `dispatch_round` treats *any* `start_game` error as
"neither side got to play → score it a draw". That is right for its documented
case (an agent vanished after being claimed → `FAILED_DEPENDENCY`), but
`start_game` also returns `SERVICE_UNAVAILABLE` when maintenance is on **or when
the global room ceiling is hit**. So draining before a deploy — or simply
running a busy server — scores every remaining pairing 0.5/0.5, walks the rest
of the schedule doing the same, marks the tournament `complete`, and settles a
real pool on results nobody played.

Fixed: `dispatch_round` now distinguishes the codes and returns
`RoundDispatch { live, blocked }`. `FAILED_DEPENDENCY` stays a forfeit; anything
else parks the tournament at status **`paused`** — nothing scored, nothing
settled, `current_round` unmoved — and fires an operator alert. Dispatch is
idempotent per pairing, so `POST /tournaments/{id}/start` resumes a paused event
exactly where it stopped, keeping its schedule, scores and position. A `paused`
tournament is abandoned on restart alongside `running` ones, since it has the
same in-flight rooms.

Pinned by `a_drained_server_pauses_a_tournament_instead_of_scoring_phantom_draws`
and `re_dispatching_a_round_does_not_double_create_its_games`. Reverting the fix
makes the first fail with the tournament reaching `settled`.

With that fixed, drain-before-deploy becomes a real mitigation and Phase 2 can
ship without full running-tournament recovery. Recovery (persist forfeits +
round schedule + `current_round`; re-dispatch the current round's unfinished
pairings as fresh games — per-ply `moves` are already persisted) stays a
follow-up, and it wants multi-node anyway.
