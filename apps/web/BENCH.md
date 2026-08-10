This file covers two harnesses:

- **`/bench`** — what a playing *style* costs, at fixed nodes. The original, below.
- **`/bench/time`** — what *clock management* is worth, at a real time control.
  Written to close this file's own caveat ("Fixed nodes, not fixed time"), and
  documented at the end.

# What a playing style actually costs

Measured, not modelled. Run the harness at `/bench` (development only —
the route 404s in production):

```
/bench?nodes=400000&pairs=14&arms=0,5,10,25,60
```

Each arm plays the baseline (MultiPV 1, no style budget) head to head. Paired
openings sampled from `public/book.json`: every opening is played twice with
colours reversed, which cancels most of its own bias. Separate workers per side
so the two players never share a hash table. Strength fixed by **node count**
rather than time, to remove machine noise.

Inside the window the harness picks **uniformly at random**. A real personality
picks by taste, but taste is uncorrelated with strength, so random-in-window is
the honest isolation of what the window itself costs.

## Results

28 games per arm (small — the 95% intervals are wide, but the trend is not
subtle). ε is the style budget in centipawns.

| Arm | Score | Elo vs baseline | 95% CI |
|---|---|---|---|
| MultiPV 4, ε0 | 0.482 | **−12** | [−150, +121] |
| MultiPV 4, ε5 | 0.304 | **−144** | [−325, −18] |
| MultiPV 4, ε10 | 0.232 | **−208** | [−435, −79] |
| MultiPV 4, ε25 | 0.143 | **−311** | [−749, −171] |
| MultiPV 4, ε60 | 0.036 | **−573** | [−1200, −373] |

### Two-pass (`searchmoves`)

Same total node budget, split ~1/3 + 2/3: a cheap MultiPV pass finds the
candidates, style shortlists two of them, and the engine then re-searches
**only that shortlist** at full width with `go nodes N searchmoves m1 m2`. It
reaches far greater depth on two moves than it could on all of them, so the
style choice gets verified instead of trusted.

| Arm | Score | Elo vs baseline | 95% CI |
|---|---|---|---|
| single-pass ε25 | 0.143 | −311 | [−749, −171] |
| **two-pass ε25, k=2** | **0.321** | **−130** | **[−303, −4]** |

Verified first that this build honours `searchmoves`: unrestricted it plays
`c1g5` in the test position; restricted to `a2a3 h2h3` it plays `h2h3`.


## Two things this changed

**MultiPV is free — but only at a realistic search budget.** At 30,000
nodes/move MultiPV 4 alone cost −207 Elo; at 400,000 it costs −12, i.e.
nothing measurable. Splitting a tiny budget across four root moves is a big
relative loss; splitting a real one is a fraction of a ply, because the extra
root searches share the transposition table. Any strength measurement of this
feature at a small node count is measuring the budget, not the feature.

**The style window is expensive, and it is expensive immediately.** Even a
5-centipawn window costs ~150 Elo. The premise the design rested on — "inside a
small window every move is objectively sound, so choosing among them is nearly
free" — is **wrong**. Stockfish's ordering *within* a few centipawns is
genuinely informative rather than noise, and discarding it costs real strength.
The modelled estimate (30–80 Elo at ε15) was too optimistic by roughly a factor
of three, because it treated per-move losses as independent when they compound
over a game.

## What follows from it

- **Openings and think time are the free levers**, and both are shipped. A
  repertoire is established theory; a time signature is highly visible and
  costs nothing measurable.
- **A style budget is a handicap, not a flavour.** If it ships it belongs
  beside the `UCI_Elo` strength limiter, labelled with the numbers above — not
  presented as free character. Note that `UCI_Elo` is Stockfish's own,
  better-calibrated way to be weaker, so a style window has to justify itself
  against it.
- **Wagered games.** A style budget above zero is a measurable, knowable
  disadvantage. Either restrict wagered browser seats to ε0 or surface the cost
  at the point of staking.
- **Two-pass more than halves the cost** — 311 Elo down to 130 at ε25, for no
  extra nodes. Letting the engine re-verify the shortlist recovers most of what
  a raw window throws away, which is consistent with the finding above: the
  engine's ordering within a few centipawns is real information, so the fix is
  to give it back the final say rather than to narrow the window.
  It is still a ~130 Elo handicap, so it is a *cheaper* handicap, not free.
  It also costs a second search, so it suits longer time controls.

## Caveats

- 28 games is small; treat individual numbers as ±150 Elo and the *shape* as
  the finding.
- 400k nodes/move is still well below what a 3+0 browser game reaches
  (~1M nodes/s here, so seconds of search). The MultiPV column would only get
  cheaper; the ε column showed no sign of improving between 30k and 400k.
- Fixed nodes, not fixed time. Time-based play adds clock-management effects
  this does not capture.
- **Two-pass at ε60 was not measured.** The harness kept exhausting the dev
  server at that length (six wasm engines, ~20 min per arm). Re-run with
  `?conc=2` and one arm at a time if the wide-window number matters.
- Harness gotchas worth keeping: pool the engines per concurrency slot (a fresh
  pair per opening compiles the 7 MB wasm two dozen times per arm and the
  handshake starts timing out), give the handshake a long timeout, stagger slot
  startup, and never let one failed game reject the run — an early version
  froze silently with no error anywhere because `Promise.all` rejected.

---

# What clock management is worth

Measured, not modelled. Run the harness at `/bench/time` (development only —
the route 404s in production, and inherits `/bench`'s `noindex`):

```
/bench/time?tc=1+0&pairs=8&arms=scaled,t2&rtt=80
```

This exists because the harness above says of itself: *"Fixed nodes, not fixed
time. Time-based play adds clock-management effects this does not capture."*
Those effects turned out to be where the real bug was — a flat `Move Overhead`
made Stockfish answer in ~2ms below 13 seconds of clock — so they needed a
harness of their own.

## What it does differently, and why each matters

**Concurrency 1, always.** The style bench runs six engines at once because a
node is a node whatever else the CPU is doing. Here the unit of measurement *is*
wall-clock, so a second engine on the same core changes the thing being
measured. Copying `?conc=` across is the easiest way to get numbers that look
fine and mean nothing.

**A simulated round trip (`?rtt=`, default 80ms).** The whole purpose of a
`Move Overhead` reserve is to pay for a network the harness does not have.
Without charging one, every arm that reserved less would win by construction and
the bench would confidently recommend a reserve of zero. Charging a trip the
searches don't actually pay puts the real trade-off back: reserve too little and
the flag becomes reachable.

**Flagging is a real loss**, since it is most of what clock management is for.
An arm that thinks beautifully and flags has lost.

**The clock is charged from the ENGINE's own reported `time`, not from wall
time.** This is the subtlest thing in the harness and it was got wrong first.
A browser tab that isn't visible is throttled, so worker-to-main-thread delivery
stretches — and billing that stretch to the player's clock pushes every arm
deeper into the low-clock regime, which is exactly the regime under test. The
bias is systematic, not noise, and it is silent: the run completes and the
numbers look plausible. Charging `info … time` instead makes a run reproducible
whether or not anyone is looking at the tab. The real per-move cost that wall
time was standing in for is then modelled explicitly by `?rtt=`, which is a
constant you control rather than a property of your window manager. Each arm
still reports `overhead Nms/move` (wall minus engine time) — small on an idle
foreground tab, large if the environment was busy. It no longer corrupts the
result, but it tells you how much to trust it.

**Both sides run the shipped code.** Arms differ only in `Move Overhead` and the
takeover factor threaded through `goCommand`; the budget itself is
`lib/timePolicy`'s. The bench measures what players get, not a paraphrase.

The baseline is what shipped **before** any of this work: a flat 250ms reserve
and full delegation to the engine's own manager. So an arm's Elo reads as
"versus the bot players actually had".

| arm | reserve | handover |
|---|---|---|
| `flat250/delegate` (baseline) | 250ms | never |
| `scaled` | scaled to the TC | never |
| `t1` / `t2` / `t4` | scaled | `overhead × 52 × factor` |

## Harness gotchas, in the spirit of the ones above

- **A time-control label is MINUTES.** `tc=1+0` is one minute; reading it as
  seconds is silent, not fatal — the run completes, prints "1+0", and measures a
  one-second game. It happened on the first run here. The tell was the reserve
  line reading 50ms where a real 1+0 scales to 60. It now resolves through
  `lib/timeControls` `tcByLabel` rather than parsing the label locally.
- **The clock is pinned by a test** (`pnpm test:benchclock`). A harness clock
  that is subtly wrong does not fail; it produces plausible Elo numbers that
  decide what ships.
- **The clock mirrors a server quirk on purpose.** The balance floors at zero
  (`saturating_sub`) while the flag test compares against
  `remaining + LAG_ALLOWANCE_MS`, so a side sitting at 0ms survives every move
  that takes under the allowance — the grace is effectively renewable per move
  rather than granted once. Reproduced directly against `crates/game-engine`: a
  500ms clock, moves of 120ms, and after 2400ms both clocks read 0 with the game
  still running. It barely shows at real time controls, where budgets are well
  above 150ms. Do not "fix" it in the harness alone — a harness kinder than the
  referee measures a game nobody plays.
