# Tournaments

How tournaments work today, end to end. Server code is in
`crates/server/src/matchmaking.rs`, the onchain half is in
`contracts/src/ChessEscrow.sol`, and the UI is `apps/web/app/tournament`.

## Kinds

The server's `buy_in` field decides the kind:

| Kind | `buy_in` | Entry fee | Prize pool | Elo ladder |
|---|---|---|---|---|
| **Casual** | none | — | none (no chain state) | casual |
| **Buy-in** | `> 0` | `buy_in` | `fee × entrants` + any sponsorship | ranked |
| **Sponsored, free entry** | `"0"` | free | sponsorship only | casual |

- **Entrants are wallets, in every kind.** Joining needs a signed-in session,
  and the entrant id is the session's wallet. Standings show that wallet's
  username. A display name typed by the client is never used.
- **The buy-in is capped** at the same 25 USDC as per-game stakes, by the
  server.
- **Creating a pooled event** requires the organizer to have a funded escrow
  balance.
- **A ranked tournament is one with an entry fee.** Its pairings move ranked
  Elo; every other kind moves casual Elo.

## Admission

- **Open:** anyone signed in can join.
- **Invite:** joining needs one of the organizer's invite codes (up to 256 per
  event).
- **Approval:** players request to join (up to 256 requests), and the organizer
  approves or rejects each one (`POST /tournaments/{id}/requests/{wallet}` with
  `{"approve": bool}`).

A pooled event whose entry fee is under 1 USDC, free entry included, **must** be
Invite or Approval; creating it as Open returns 400. This isn't Sybil
resistance. Fees go into the pool the paying places win back, so a field you
control costs you nothing at any fee level. The point is that the cheap case
can't be open to the world: the organizer has to choose who is in it. An
Open event of that kind reloaded from an older version comes back as Approval.

## Sponsorship

Anyone can add to a pool with `sponsorTournament(tid, amount)` from their escrow
balance. Sponsorship is **irrevocable** while the event can still settle. If it
never settles, sponsors take theirs back with `refundSponsorship` once the
settle window has closed. A free-entry event with an empty pool is refused at
start, because it would play a full round-robin for nothing, and free entrants
have no buy-in to refund.

## Schedule

- **Format.** Round-robin by the circle method. Swiss and knockout aren't
  implemented, even though the contract's pool would support them.
- **One round at a time.** Each round's games are created only when the
  previous round has finished. A single connected bot can therefore play every
  round, and nobody's later games are reaped before they start.
- **The board opens itself.** A room is reaped 60 seconds after creation, so
  the tournament page opens the board automatically when a round dispatches.
  A browser entrant who isn't at the board forfeits that pairing; an offline bot
  forfeits too.
- **Who can start.** Buy-in and free-entry events: the organizer only. Casual
  events: anyone. At least 2 entrants are needed.
- **Limits.**
  - 128 entrants per event.
  - 3 open pooled events per organizer (`RL_MAX_OPEN_TOURNAMENTS`).
  - 256 in the lobby (`RL_MAX_TOURNAMENTS`).
  - Time controls up to 3h + 180s.
  - An open event leaves the lobby after 24 hours; its pool can still be
    refunded.

### The settle deadline

The live v2 contract has **one clock per tournament, starting at creation**.
Past `openedAt + settleTimeout` (24h on mainnet), both settle paths revert and
refunds open. An event that runs past it pays nobody and its standings are
discarded. Time spent filling the field comes out of the time left to play it,
and the contract has no entry deadline of its own. So the server guards it:

- **Worst-case schedule.** `rounds × (2 × initial + 200 × increment + 60s)`.
- **Starting.** `POST /tournaments/{id}/start` refuses (409) a schedule that
  doesn't fit in 80% of the time left before the deadline. A resumed event is
  sized by the rounds it has *left*. If the deadline can't be read, the start
  fails with 502 rather than guessing.
- **Joining.** A join is refused if the deadline has passed, or if one more
  entrant would make the schedule unable to fit. Payers still being confirmed
  (below) count toward the field.

The guard is the server's, not the contract's. If it ever failed, entrants would
still get their buy-ins back through `claimRefund` after the deadline. That's a
delay, not a loss.

## Paid entries

The payout divides the **onchain** pool across the **off-chain** field, so any
player who paid but was left out of the field would be funding everyone else's
prizes. The server closes that gap:

1. **Recorded before the money moves.** A paid join is written to
   `unconfirmed_entries`, along with the seat it asked for (browser or bot),
   before `enterTournament` is sent.
2. **The chain decides who paid.** If the entry's confirmation fails, the join
   re-checks the chain once and seats the player on a yes. An entry that
   definitively didn't happen (its gas estimate failed, or it reverted) is
   forgotten.
3. **Reconciled at start.** Starting seats every recorded payer the chain
   confirms, in the seat they asked for. It refuses to start if it can't read
   the chain.
4. **Refunded if still unseated.** A payer whose entry landed after the start
   is added as an extra payee in the settlement, getting their buy-in back in
   the same signed payout.

The join request itself is finished in a spawned task, so a client hanging up
mid-transaction doesn't lose a paid entry.

## Payouts

- **Split.** The organizer sets basis points per place, best first. They must
  sum to exactly 10,000, be non-increasing, and have at most 128 places. The
  default is 65/25/10.
- **Short field.** If the field is smaller than the split, the split is
  truncated and renormalized, so heads-up on the default pays 72.2/27.8.
- **Ties.** Equal scores pool their places and split evenly, with indivisible
  dust handed out one base unit at a time from the top. Join order never decides
  money.
- **Settlement.** The pool is read from the chain when the event completes,
  never derived from `buy_in × entrants`. Sixteen payees or fewer are paid
  directly (`settleTournament`). More than that commits a Merkle root
  (`settleTournamentRoot`), and each winner claims with a proof served by
  `GET /tournaments/{id}/claim/{address}`. Settlement goes through the durable
  tournament outbox and retries until it lands.
- **Rake.** Whatever the payout doesn't cover becomes rake. Because the pool is
  fixed at completion, a sponsorship that arrives between completion and
  settlement is raked, not paid out.

## Refunds and restarts

- **Unsettled events refund.** If an event doesn't settle within
  `settleTimeout` of creation, each entrant calls `claimRefund` for their
  buy-in and each sponsor calls `refundSponsorship`. The web app's "Payouts &
  refunds" panel offers both once the window opens. It lists open, completed,
  settled, abandoned and paused events, plus any event where the wallet has a
  recorded paid entry.
- **Open events survive a restart.** The organizer, entrants, bot bindings,
  payout split, admission, invites, approvals and unconfirmed entries are all
  persisted.
- **Running events are abandoned on restart.** Their games are gone, and
  partial standings must never be settled, so entrants refund onchain instead.
  A planned deploy should use maintenance mode first; see
  [operations.md](operations.md).
- **Maintenance mode pauses running events.** With maintenance mode on, the
  next round's dispatch is refused and the event goes to `paused`. The
  organizer resumes it with the same start call once maintenance is off.
