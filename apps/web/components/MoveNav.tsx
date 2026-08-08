"use client";

import { useEffect, useRef } from "react";

/** Transport controls under the board. In `live` mode the last button is a
 *  "Live" pill instead of a plain skip-to-end, because in a running game that
 *  action means "resume following", and a viewer who has scrubbed back needs an
 *  obvious way home. */
export function MoveNav({
  at,
  total,
  mode = "replay",
  live,
  onFirst,
  onPrev,
  onNext,
  onLast,
}: {
  at: number;
  total: number;
  mode?: "replay" | "live";
  /** Currently following the newest position (live mode only). */
  live?: boolean;
  onFirst: () => void;
  onPrev: () => void;
  onNext: () => void;
  onLast: () => void;
}) {
  return (
    <div className="replay-nav" role="group" aria-label="Move navigation">
      <button onClick={onFirst} disabled={at === 0} aria-label="Start">
        ⏮
      </button>
      <button onClick={onPrev} disabled={at === 0} aria-label="Previous move">
        ◀
      </button>
      <span className="replay-count">
        {at} / {total}
      </span>
      <button onClick={onNext} disabled={at === total} aria-label="Next move">
        ▶
      </button>
      {mode === "live" ? (
        <button
          className={`live-jump${live ? " on" : ""}`}
          onClick={onLast}
          disabled={!!live}
          aria-label="Jump to the live position"
        >
          ● Live
        </button>
      ) : (
        <button onClick={onLast} disabled={at === total} aria-label="End">
          ⏭
        </button>
      )}
    </div>
  );
}

/** Numbered, clickable move list. `at` is a ply index (1 = after white's first
 *  move), matching usePlyNav. Keeps the current move scrolled into view, so a
 *  long live game doesn't leave the highlight off-screen. */
export function MoveList({
  sans,
  at,
  onSelect,
  emptyText = "No moves yet.",
}: {
  sans: string[];
  at: number;
  onSelect: (ply: number) => void;
  emptyText?: string;
}) {
  const box = useRef<HTMLDivElement>(null);

  // Scroll the list box itself rather than calling scrollIntoView, which also
  // scrolls ancestors — on a narrow screen the move list sits below the board,
  // so every move of a live game would yank the page down away from it.
  useEffect(() => {
    const list = box.current;
    const active = list?.querySelector(".move-btn.active");
    if (!list || !active) return;
    const l = list.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    if (a.top < l.top) list.scrollTop -= l.top - a.top;
    else if (a.bottom > l.bottom) list.scrollTop += a.bottom - l.bottom;
  }, [at, sans.length]);

  return (
    <div className="moves" ref={box}>
      {sans.length === 0 && <span className="muted">{emptyText}</span>}
      {sans.map((san, i) => (
        <span key={i}>
          {i % 2 === 0 && <span className="num">{i / 2 + 1}.</span>}
          <button
            className={`move-btn${at === i + 1 ? " active" : ""}`}
            onClick={() => onSelect(i + 1)}
          >
            {san}
          </button>{" "}
        </span>
      ))}
    </div>
  );
}
