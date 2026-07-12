"use client";

import { capturedGlyphs } from "@/lib/board";

function fmtClock(ms: number | null | undefined) {
  if (ms == null) return "—";
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A player's name-plate above/below the board: color dot, name, engine,
 *  captured-material strip, and a bound clock that highlights on their turn —
 *  the layout Chess.com / Lichess use. */
export function PlayerBar({
  color,
  name,
  engine,
  clockMs,
  active,
  captured,
  edge,
}: {
  color: "white" | "black";
  name: string;
  engine?: string | null;
  clockMs?: number | null;
  /** True when it is this player's turn (game still live). */
  active?: boolean;
  /** Piece letters this player has captured (from lib/board material()). */
  captured?: string[];
  /** Material edge in pawns for this player (>0 shown as +N). */
  edge?: number;
}) {
  return (
    <div className={`player-bar${active ? " active" : ""}`}>
      <div className="player-id">
        <span className={`player-dot ${color}`} aria-hidden />
        <span className="player-name">{name}</span>
        {engine && <span className="player-sub">🤖 {engine}</span>}
        {((captured && captured.length > 0) || (edge != null && edge > 0)) && (
          <span className="player-captured" aria-label="captured pieces">
            {captured && captured.length > 0 && capturedGlyphs(captured)}
            {edge != null && edge > 0 && <span className="player-edge">+{edge}</span>}
          </span>
        )}
      </div>
      <div className="player-clock">{fmtClock(clockMs)}</div>
    </div>
  );
}
