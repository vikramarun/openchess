"use client";

import { Chessground } from "chessground";
import type { Api } from "chessground/api";
import { useEffect, useRef } from "react";
// chessground stylesheets are loaded via <link> CDN tags in app/layout.tsx
// (the published npm package does not vendor its CSS assets).

/** Read-only chessground board driven by a FEN string. */
export function Chessboard({
  fen,
  orientation = "white",
}: {
  fen: string;
  orientation?: "white" | "black";
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
      });
    }
    return () => {
      api.current?.destroy();
      api.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    api.current?.set({ fen });
  }, [fen]);

  useEffect(() => {
    api.current?.set({ orientation });
  }, [orientation]);

  return (
    <div className="board-wrap">
      <div ref={el} style={{ width: "100%", aspectRatio: "1 / 1" }} />
    </div>
  );
}
