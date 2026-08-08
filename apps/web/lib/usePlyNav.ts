"use client";

import { useCallback, useEffect, useState } from "react";

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

  // Landing on the last ply re-attaches to the tip: in a live game "End" means
  // "follow along again", not "pin me to move N".
  const go = useCallback(
    (n: number) => setPly(n >= total ? null : Math.max(0, n)),
    [total],
  );
  const first = useCallback(() => setPly(0), []);
  const last = useCallback(() => setPly(null), []);
  const prev = useCallback(
    () => setPly((p) => Math.max(0, (p === null ? total : p) - 1)),
    [total],
  );
  const next = useCallback(
    () => setPly((p) => {
      const n = (p === null ? total : p) + 1;
      return n >= total ? null : n;
    }),
    [total],
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
