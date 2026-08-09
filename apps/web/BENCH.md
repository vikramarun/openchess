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
