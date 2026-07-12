"use client";

import { Chessground } from "chessground";
import type { Api } from "chessground/api";
import type { Color, Key } from "chessground/types";
import { useEffect, useRef } from "react";
// chessground stylesheets are loaded via <link> CDN tags in app/layout.tsx
// (the published npm package does not vendor its CSS assets).

/** Read-only chessground board driven by a FEN string. Optionally highlights the
 *  last move (from/to squares) and flags the side in check — the standard cues
 *  every serious chess UI shows. */
export function Chessboard({
  fen,
  orientation = "white",
  lastMove,
  check,
}: {
  fen: string;
  orientation?: "white" | "black";
  /** [from, to] of the last move, e.g. ["e2", "e4"] — highlights both squares. */
  lastMove?: [string, string] | null;
  /** Side currently in check, or true to auto-detect from the FEN. */
  check?: Color | boolean | null;
}) {
  const el = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);

  useEffect(() => {
    if (el.current && !api.current) {
      api.current = Chessground(el.current, {
        viewOnly: true,
        coordinates: true,
        orientation,
        fen,
        lastMove: (lastMove as Key[] | undefined) ?? undefined,
        check: check ?? undefined,
      });
    }
    return () => {
      api.current?.destroy();
      api.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    api.current?.set({
      fen,
      lastMove: (lastMove as Key[] | undefined) ?? undefined,
      check: check ?? undefined,
    });
  }, [fen, lastMove, check]);

  useEffect(() => {
    api.current?.set({ orientation });
  }, [orientation]);

  return (
    <div className="board-wrap">
      <div ref={el} style={{ width: "100%", aspectRatio: "1 / 1" }} />
    </div>
  );
}
