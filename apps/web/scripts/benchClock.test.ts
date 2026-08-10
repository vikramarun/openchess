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

// --- an empty clock cannot be played through --------------------------------
// The harness mirrors the referee, and the referee used to floor the balance at
// zero while the flag test compared against `remaining + LAG_ALLOWANCE_MS` —
// handing the grace back every move, so a side at 0ms never flagged as long as
// each move landed inside it. Both are exact now. This is the property that
// broke, so it is the property that gets pinned; if the harness ever goes back
// to clamping, it becomes kinder than the game and measures a game nobody plays.
{
  let c = newClock(500, 0);
  let flaggedAt: number | null = null;
  for (let i = 0; i < 20; i++) {
    const r = charge(c, i % 2 === 0 ? "white" : "black", 120, 0);
    if (r.flagged) {
      flaggedAt = i;
      break;
    }
    c = r.clock;
  }
  check("somebody flags on a 500ms clock at 120ms a move", flaggedAt !== null, true);
  // The overdraft is carried, not forgiven per move: one 100ms overrun on a
  // 1000ms clock is absorbed, a second one is not.
  const once = charge(newClock(1_000, 0), "white", 1_100, 0);
  check("a single late arrival is still absorbed", once.flagged, false);
  check("and the debt is carried, not floored", once.clock.whiteMs, -100);
  check("so the next overrun ends it", charge(once.clock, "white", 60, 0).flagged, true);
}

// --- but the SEAT never sees the debt ---------------------------------------
// `remainingFor` is the wire clock, clamped like `to_wire` in the referee: the
// policy under test must be fed what a real seat is told, not our bookkeeping.
{
  const inDebt = charge(newClock(1_000, 0), "white", 1_100, 0).clock;
  check("the seat reads zero, not a negative clock", remainingFor(inDebt, "white"), 0);
}

process.exit(failed === 0 ? 0 : 1);
