"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Move-by-move navigation over a game, shared by the finished-game replay and
 *  the live spectator. The one subtlety is the LIVE case: the viewer must be
 *  able to step back through a game that is still growing without being yanked
 *  forward by every new move — so "at the end" is stored as *following the tip*
 *  (`ply === null`) rather than as a ply number. A replay's `total` never
 *  changes, so the same state behaves as a plain index there.
 *
 *  Also owns ←/→/Home/End, so both views get identical keyboard behavior. */
export function usePlyNav(total: number) {
  const [ply, setPly] = useState<number | null>(null); // null = follow the tip

  const at = ply === null ? total : Math.min(Math.max(ply, 0), total);
  /** Showing the newest position (so live clocks/turn indicators apply). */
  const live = at >= total;

  // Read `total` through a ref inside the callbacks: in a live game it changes
  // on every move, and closing over it would both re-subscribe the key handler
  // each time and let a keypress race a move that has landed but not yet
  // re-rendered.
  const totalRef = useRef(total);
  totalRef.current = total;

  // Landing on the last ply re-attaches to the tip: in a live game "End" means
  // "follow along again", not "pin me to move N".
  const go = useCallback((n: number) => setPly(n >= totalRef.current ? null : Math.max(0, n)), []);
  const first = useCallback(() => setPly(0), []);
  const last = useCallback(() => setPly(null), []);
  const prev = useCallback(
    () => setPly((p) => Math.max(0, (p === null ? totalRef.current : p) - 1)),
    [],
  );
  const next = useCallback(
    () =>
      setPly((p) => {
        const n = (p === null ? totalRef.current : p) + 1;
        return n >= totalRef.current ? null : n;
      }),
    [],
  );

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
