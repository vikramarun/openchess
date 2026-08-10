// The bench's clock. Pure, and pinned by scripts/benchClock.test.ts, because a
// clock that is subtly wrong does not fail — it just produces numbers, and the
// numbers decide what ships.
//
// It mirrors `crates/game-engine` deliberately: the server charges wall-clock
// from the moment it sends `your_turn` to the moment the move lands, adds the
// increment after, and flags with a lag allowance on top.

/** Matches `game_engine::LAG_ALLOWANCE_MS`. */
export const LAG_ALLOWANCE_MS = 150;

export type BenchClock = { whiteMs: number; blackMs: number; incMs: number };
export type Side = "white" | "black";

export function newClock(initialMs: number, incMs: number): BenchClock {
  return { whiteMs: initialMs, blackMs: initialMs, incMs };
}

export function remainingFor(clock: BenchClock, side: Side): number {
  return side === "white" ? clock.whiteMs : clock.blackMs;
}

/** Charge one move to the mover.
 *
 *  `rttMs` is the whole reason a `Move Overhead` exists, and this harness has
 *  no network — so without simulating one, every arm that reserved less would
 *  look strictly better and the bench would be rigged toward the reserve going
 *  to zero. Charging a round trip the searches do not actually pay puts the
 *  real trade-off back: reserve too little and the flag becomes reachable. */
export function charge(
  clock: BenchClock,
  side: Side,
  elapsedMs: number,
  rttMs: number,
): { clock: BenchClock; flagged: boolean } {
  const spent = elapsedMs + rttMs;
  const remaining = remainingFor(clock, side);
  if (spent > remaining + LAG_ALLOWANCE_MS) {
    const flat = side === "white" ? { ...clock, whiteMs: 0 } : { ...clock, blackMs: 0 };
    return { clock: flat, flagged: true };
  }
  // Increment lands only on a move that actually arrived in time, same as the
  // server: it is added after the deduction, not before.
  //
  // The `Math.max(0, …)` mirrors the server's `saturating_sub`, and it carries a
  // real quirk with it: because the balance floors at zero while the flag test
  // above compares against `remaining + LAG_ALLOWANCE_MS`, a side sitting at 0ms
  // survives every move that takes under the allowance. The allowance is meant
  // to absorb jitter once and is in practice renewable per move. Do NOT "fix"
  // that here — a harness that disagrees with the referee measures a game
  // nobody plays. Fix it in `crates/game-engine` and then follow it here.
  const left = Math.max(0, remaining - spent) + clock.incMs;
  return {
    clock: side === "white" ? { ...clock, whiteMs: left } : { ...clock, blackMs: left },
    flagged: false,
  };
}
