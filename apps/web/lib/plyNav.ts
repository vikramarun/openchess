/** The pure state machine behind `usePlyNav` (see lib/usePlyNav.ts), split out
 *  so it can be tested without React — `pnpm test:nav`.
 *
 *  The whole design rests on one choice: "at the end" is stored as *following
 *  the tip* (`null`), not as a ply number. In a live game `total` grows under
 *  you, so a viewer parked on ply N must stay on ply N while a viewer at the end
 *  must be carried forward — and only a null can tell those two apart once the
 *  numbers happen to coincide. */

/** Where the viewer is: a ply index, or `null` for "follow the newest move". */
export type Ply = number | null;

/** Resolve to a concrete ply. A remembered ply is clamped, never dropped: a
 *  shorter game (a NEW game on a view that wasn't remounted) pins you at its
 *  end, and if that game grows past N you are back on N — which is why a caller
 *  that starts a fresh game must also re-attach to the tip. */
export function plyAt(ply: Ply, total: number): number {
  return ply === null ? total : Math.min(Math.max(ply, 0), total);
}

/** Showing the newest position, so live clocks and turn indicators apply. */
export function isLive(ply: Ply, total: number): boolean {
  return plyAt(ply, total) >= total;
}

/** Jump to a ply. Landing on the last one re-attaches to the tip: in a live game
 *  "go to the end" means "follow along again", not "pin me to move N". */
export function goTo(n: number, total: number): Ply {
  return n >= total ? null : Math.max(0, n);
}

export function stepPrev(ply: Ply, total: number): Ply {
  return Math.max(0, (ply === null ? total : ply) - 1);
}

export function stepNext(ply: Ply, total: number): Ply {
  return goTo((ply === null ? total : ply) + 1, total);
}
