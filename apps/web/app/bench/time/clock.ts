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

/** What the SEAT sees: the wire clock, clamped at zero like `to_wire` in
 *  `crates/game-engine`. A seat never learns it is in debt, so the policy under
 *  test must not either. */
export function remainingFor(clock: BenchClock, side: Side): number {
  return Math.max(0, side === "white" ? clock.whiteMs : clock.blackMs);
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
  // The SIGNED balance, not the clamped one: an overrun is carried as debt, so
  // the next flag test starts from it. Mirrors `crates/game-engine`, where
  // flooring this at zero handed the allowance back every move and a side at
  // 0ms could play on forever.
  const remaining = side === "white" ? clock.whiteMs : clock.blackMs;
  if (spent > remaining + LAG_ALLOWANCE_MS) {
    const flat = side === "white" ? { ...clock, whiteMs: 0 } : { ...clock, blackMs: 0 };
    return { clock: flat, flagged: true };
  }
  // Increment lands only on a move that actually arrived in time, same as the
  // server: it is added after the deduction, not before.
  //
  // Exact — no `Math.max(0, …)`. That clamp is what made the allowance
  // renewable, and it is now absent from the referee too; putting it back here
  // would make the harness kinder than the game, which measures a game nobody
  // plays. Clamping belongs in `remainingFor`, which is what the seat sees.
  const left = remaining - spent + clock.incMs;
  return {
    clock: side === "white" ? { ...clock, whiteMs: left } : { ...clock, blackMs: left },
    flagged: false,
  };
}
