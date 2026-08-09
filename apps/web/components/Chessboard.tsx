"use client";

import { Chessground } from "chessground";
import type { Api } from "chessground/api";
import type { Color, Key } from "chessground/types";
import { useEffect, useRef } from "react";

import { EvalBar } from "@/components/EvalBar";
import { displayConfig } from "@/lib/boardPrefs";
import type { EvalScore } from "@/lib/evalScore";
import { useBoardPrefs } from "@/lib/useBoardPrefs";
// The board's look (squares, piece art) is CSS custom properties on <html> —
// see app/board.css and lib/boardPrefs.ts. Nothing about the theme reaches this
// component; only the behavioral preferences below do.

/** Read-only chessground board driven by a FEN string. Optionally highlights the
 *  last move (from/to squares) and flags the side in check — the standard cues
 *  every serious chess UI shows — and renders an evaluation bar down the left
 *  edge when the caller supplies a score (see lib/useEval.ts; the caller owns
 *  the analysis so no board silently starts a search). */
export function Chessboard({
  fen,
  orientation = "white",
  lastMove,
  check,
  evalScore,
  showEval,
  evalThinking,
  onFlip,
}: {
  fen: string;
  orientation?: "white" | "black";
  /** [from, to] of the last move, e.g. ["e2", "e4"] — highlights both squares. */
  lastMove?: [string, string] | null;
  /** Side currently in check, or true to auto-detect from the FEN. */
  check?: Color | boolean | null;
  /** White-relative engine score for the position being shown. */
  evalScore?: EvalScore | null;
  /** Render the eval bar (it holds its slot even before the first score, so the
   *  board doesn't jump sideways when the engine reports). */
  showEval?: boolean;
  evalThinking?: boolean;
  /** Show a flip control. The caller owns the flip (see lib/useFlip.ts) because
   *  the player name-plates have to swap with the board. */
  onFlip?: () => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const [prefs] = useBoardPrefs();

  // chessground builds the coordinate elements once, in its initial wrap render,
  // and api.set() never rebuilds them. "Every square" is a different DOM shape
  // from the rank/file strips, so that one switch has to recreate the board —
  // hence the dep. Hiding coordinates entirely is done in CSS instead (see the
  // data-coords rule in globals.css), which keeps the common toggle free.
  const coordsOnSquares = prefs.coords === "all";

  // Latest values, so recreating the board doesn't restore a stale position.
  const latest = useRef({ fen, orientation, lastMove, check });
  latest.current = { fen, orientation, lastMove, check };

  useEffect(() => {
    if (!el.current) return;
    const now = latest.current;
    api.current = Chessground(el.current, {
      viewOnly: true,
      coordinates: true,
      coordinatesOnSquares: coordsOnSquares,
      orientation: now.orientation,
      fen: now.fen,
      lastMove: (now.lastMove as Key[] | undefined) ?? undefined,
      check: now.check ?? undefined,
      ...displayConfig(prefs),
    });
    return () => {
      api.current?.destroy();
      api.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coordsOnSquares]);

  useEffect(() => {
    api.current?.set({
      fen,
      // `[]`, not `undefined`, when there is no last move. chessground's `set`
      // merges a config, so an `undefined` field means "leave it alone" — a null
      // lastMove would keep the PREVIOUS highlight lit. Visible wherever a board
      // returns to a position with no last move: the homepage reel loops back to
      // the start still wearing the highlight from the mate that ended the last
      // lap, and scrubbing a replay to ply 0 leaves the same stale pair.
      lastMove: (lastMove as Key[] | null) ?? [],
      check: check ?? undefined,
    });
  }, [fen, lastMove, check]);

  useEffect(() => {
    api.current?.set({ orientation });
  }, [orientation]);

  // Animation speed and the highlight toggles apply live — chessground reads
  // these from state on every render, so no rebuild and no flicker.
  useEffect(() => {
    const { animation, highlight } = displayConfig(prefs);
    api.current?.set({ animation, highlight });
  }, [prefs]);

  return (
    <div className="board-stack">
      <div className="board-row">
        {showEval && (
          <EvalBar score={evalScore ?? null} orientation={orientation} thinking={evalThinking} />
        )}
        <div className="board-wrap" data-coords={prefs.coords}>
          <div ref={el} style={{ width: "100%", aspectRatio: "1 / 1" }} />
        </div>
      </div>
      {onFlip && (
        // Outside .board-row on purpose: that row stretches the eval bar to the
        // board's height, so anything added inside it would leave the bar taller
        // than the board and its readings misaligned.
        <div className="board-tools">
          <button type="button" className="flip-btn" onClick={onFlip} title="Flip board">
            ⇅ Flip
          </button>
        </div>
      )}
    </div>
  );
}
