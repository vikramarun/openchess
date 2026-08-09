"use client";

import { useCallback, useState } from "react";

import type { Side } from "./board";

export function other(side: Side): Side {
  return side === "white" ? "black" : "white";
}

/** Which side of the board the viewer is sitting on, and a way to swap it.
 *
 *  Deliberately not persisted: flipping is a per-view act ("let me see it from
 *  black's side"), not a preference, and a sticky flip would silently show a
 *  seated player their own game upside down on the next visit.
 *
 *  The caller owns this rather than the board because flipping has to move the
 *  player name-plates too — the board is only half of the perspective. */
export function useFlip(base: Side): { orientation: Side; flipped: boolean; flip: () => void } {
  const [flipped, setFlipped] = useState(false);
  const flip = useCallback(() => setFlipped((f) => !f), []);
  return { orientation: flipped ? other(base) : base, flipped, flip };
}
