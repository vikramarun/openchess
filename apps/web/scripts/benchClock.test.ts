// The bench clock must charge what the server charges. A harness clock that is
// wrong does not fail loudly — it produces plausible Elo numbers that decide
// what ships, so it is pinned like the production clamps are.
import { charge, LAG_ALLOWANCE_MS, newClock, remainingFor } from "../app/bench/time/clock";

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
}

{
  const c = newClock(60_000, 0);
  check("both sides start on the initial clock", [c.whiteMs, c.blackMs], [60_000, 60_000]);
  check("remainingFor picks the mover", remainingFor(c, "black"), 60_000);
}

// --- the round trip is charged, not just the search -------------------------
// Without this the reserve would be free and every arm that reserved less would
// win by construction.
{
  const r = charge(newClock(60_000, 0), "white", 1_000, 80);
  check("the simulated round trip comes off the clock", r.clock.whiteMs, 60_000 - 1_080);
  check("and the opponent is untouched", r.clock.blackMs, 60_000);
  check("a move in time does not flag", r.flagged, false);
}

// --- increment lands after the deduction, as on the server ------------------
{
  const r = charge(newClock(60_000, 2_000), "black", 3_000, 0);
  check("increment is added to what's left", r.clock.blackMs, 60_000 - 3_000 + 2_000);
}

// --- flagging ---------------------------------------------------------------
{
  // Exactly at the allowance is still alive; one ms past it is not. This is the
  // boundary game_engine::flag_if_expired uses (`elapsed > remaining + LAG`).
  const alive = charge(newClock(1_000, 0), "white", 1_000 + LAG_ALLOWANCE_MS, 0);
  check("the lag allowance is honoured", alive.flagged, false);
  const dead = charge(newClock(1_000, 0), "white", 1_000 + LAG_ALLOWANCE_MS + 1, 0);
  check("a ms past the allowance flags", dead.flagged, true);
  check("a flagged clock reads zero", dead.clock.whiteMs, 0);
  // A flag must not be rescued by the increment — that would make a sudden-death
  // game with any increment nearly unflaggable and quietly delete the failure
  // mode the whole bench exists to price.
  const withInc = charge(newClock(1_000, 2_000), "white", 9_000, 0);
  check("increment does not rescue a flag", [withInc.flagged, withInc.clock.whiteMs], [true, 0]);
}

// --- the round trip can be what flags you -----------------------------------
{
  // The server forgives LAG_ALLOWANCE_MS (150) on top of the clock, so a trip
  // inside that budget never flags on its own — which is exactly why a 50ms
  // reserve is survivable in bullet, and worth knowing before anyone lowers
  // MIN_MOVE_OVERHEAD_MS further.
  check("a trip inside the allowance is absorbed", charge(newClock(300, 0), "black", 250, 80).flagged, false);
  // Past it, the trip is what kills you: the search alone fits in the clock and
  // the move still arrives late. This is what a too-small reserve walks into.
  const late = charge(newClock(300, 0), "black", 250, 250);
  check("search fits but the trip does not", late.flagged, true);
}

// --- a quirk this MIRRORS rather than fixes ---------------------------------
// The balance floors at zero (the server's `saturating_sub`) while the flag test
// compares against `remaining + LAG_ALLOWANCE_MS`, so a side at 0ms survives
// every move under the allowance — the grace is renewable per move rather than
// once. Reproduced against `crates/game-engine`: a 500ms clock, moves of 120ms,
// and after 2400ms both clocks read 0 with the game still running.
//
// Pinned here so the disagreement is visible if the server is fixed and this is
// not: a harness that is kinder than the referee measures a game nobody plays.
{
  let c = newClock(500, 0);
  for (let i = 0; i < 20; i++) {
    const r = charge(c, i % 2 === 0 ? "white" : "black", 120, 0);
    if (r.flagged) break;
    c = r.clock;
  }
  check("an empty clock survives sub-allowance moves, as on the server", [c.whiteMs, c.blackMs], [0, 0]);
  check("and still does not flag", charge(c, "white", 120, 0).flagged, false);
  // One move past the allowance does end it, which is why realistic time
  // controls still flag normally: budgets there are far above 150ms.
  check("a move past the allowance still flags", charge(c, "white", 151, 0).flagged, true);
}

process.exit(failed === 0 ? 0 : 1);
