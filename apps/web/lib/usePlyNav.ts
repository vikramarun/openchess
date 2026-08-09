"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { goTo, isLive, plyAt, stepNext, stepPrev, type Ply } from "@/lib/plyNav";

/** Move-by-move navigation over a game, shared by the finished-game replay, the
 *  live spectator, and the two views that play a game (SeatGame, /play). The
 *  transitions live in lib/plyNav.ts — this is the React shell around them:
 *  the `ply` state, the `total` ref, and the ←/→/Home/End keys, so every view
 *  gets identical keyboard behavior.
 *
 *  The one subtlety is the LIVE case: the viewer must be able to step back
 *  through a game that is still growing without being yanked forward by every
 *  new move, so "at the end" is stored as *following the tip* (`ply === null`)
 *  rather than as a ply number. A replay's `total` never changes, so the same
 *  state behaves as a plain index there. */
export function usePlyNav(total: number) {
  const [ply, setPly] = useState<Ply>(null); // null = follow the tip

  const at = plyAt(ply, total);
  /** Showing the newest position (so live clocks/turn indicators apply). */
  const live = isLive(ply, total);

  // Read `total` through a ref inside the callbacks: in a live game it changes
  // on every move, and closing over it would both re-subscribe the key handler
  // each time and let a keypress race a move that has landed but not yet
  // re-rendered.
  const totalRef = useRef(total);
  totalRef.current = total;

  const go = useCallback((n: number) => setPly(goTo(n, totalRef.current)), []);
  const first = useCallback(() => setPly(0), []);
  const last = useCallback(() => setPly(null), []);
  const prev = useCallback(() => setPly((p) => stepPrev(p, totalRef.current)), []);
  const next = useCallback(() => setPly((p) => stepNext(p, totalRef.current)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't hijack keys while the user is typing in a field.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "Home") first();
      else if (e.key === "End") last();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next, first, last]);

  return { at, total, live, go, first, prev, next, last };
}
