"use client";

import { Chessboard } from "@/components/Chessboard";
import { EvalToggle } from "@/components/EvalBar";
import type { AnimationSpeed, CoordsMode } from "@/lib/boardPrefs";
import { boardBackground, BOARD_THEMES } from "@/lib/boardThemes";
import { PIECE_SETS, pieceSet, pieceUrl } from "@/lib/pieceSets";
import { useBoardPrefs } from "@/lib/useBoardPrefs";
import { useEvalPref } from "@/lib/useEval";

/** Ruy Lopez after 3...a6 — every piece type is on the board and the last move
 *  is a pawn push, so the piece art and the last-move highlight are both visible
 *  in the preview. */
const PREVIEW_FEN = "r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 1 4";
const PREVIEW_LAST_MOVE: [string, string] = ["a7", "a6"];

const COORD_OPTIONS: { value: CoordsMode; label: string }[] = [
  { value: "inside", label: "Inside the board" },
  { value: "all", label: "Every square" },
  { value: "off", label: "Off" },
];

const ANIMATION_OPTIONS: { value: AnimationSpeed; label: string }[] = [
  { value: "none", label: "None" },
  { value: "fast", label: "Fast" },
  { value: "normal", label: "Normal" },
  { value: "slow", label: "Slow" },
];

/** Board appearance. Every change applies immediately and everywhere — the
 *  preview below is an ordinary board reading the same preferences, not a
 *  special-cased copy, so what you see here is what a game looks like. */
export function BoardSettings() {
  const [prefs, update] = useBoardPrefs();
  const [evalOn, setEvalOn] = useEvalPref();
  const set = pieceSet(prefs.pieces);

  return (
    <div className="settings-layout">
      <div className="settings-preview">
        <Chessboard fen={PREVIEW_FEN} lastMove={PREVIEW_LAST_MOVE} />
      </div>

      <div className="settings-controls">
        <div className="panel">
          <b style={{ color: "var(--text-strong)" }}>Board</b>
          <div className="swatch-row" style={{ marginTop: 10 }}>
            {BOARD_THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                title={t.label}
                aria-label={t.label}
                aria-pressed={prefs.board === t.id}
                className={`swatch board-swatch${prefs.board === t.id ? " on" : ""}`}
                onClick={() => update({ board: t.id })}
                style={{ backgroundImage: boardBackground(t.light, t.dark) }}
              />
            ))}
          </div>
        </div>

        <div className="panel">
          <b style={{ color: "var(--text-strong)" }}>Pieces</b>
          <div className="swatch-row" style={{ marginTop: 10 }}>
            {PIECE_SETS.map((p) => (
              <button
                key={p.id}
                type="button"
                title={p.label}
                aria-label={p.label}
                aria-pressed={prefs.pieces === p.id}
                className={`swatch piece-swatch${prefs.pieces === p.id ? " on" : ""}`}
                onClick={() => update({ pieces: p.id })}
              >
                {/* White on a dark square, black on a light one — the way each
                    set is actually seen. */}
                <span style={{ background: "var(--board-dark)" }}>
                  <img src={pieceUrl(p.id, "w", "N")} alt="" />
                </span>
                <span style={{ background: "var(--board-light)" }}>
                  <img src={pieceUrl(p.id, "b", "N")} alt="" />
                </span>
              </button>
            ))}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            {set.label}: {set.credit}.{" "}
            <a href="/piece/CREDITS.md" target="_blank" rel="noreferrer">
              All credits
            </a>
          </div>
        </div>

        <div className="panel">
          <b style={{ color: "var(--text-strong)" }}>Display</b>
          <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
            <label className="muted" style={{ fontSize: 13 }}>
              Board coordinates
              <select
                value={prefs.coords}
                onChange={(e) => update({ coords: e.target.value as CoordsMode })}
                style={{ display: "block", marginTop: 4 }}
              >
                {COORD_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="muted" style={{ fontSize: 13 }}>
              Piece animation
              <select
                value={prefs.animation}
                onChange={(e) => update({ animation: e.target.value as AnimationSpeed })}
                style={{ display: "block", marginTop: 4 }}
              >
                {ANIMATION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="eval-toggle" style={{ marginTop: 0 }}>
              <input
                type="checkbox"
                checked={prefs.highlightLastMove}
                onChange={(e) => update({ highlightLastMove: e.target.checked })}
              />
              <span>Highlight the last move</span>
            </label>

            <label className="eval-toggle" style={{ marginTop: 0 }}>
              <input
                type="checkbox"
                checked={prefs.highlightCheck}
                onChange={(e) => update({ highlightCheck: e.target.checked })}
              />
              <span>Highlight check</span>
            </label>

            {/* Also offered in the game sidebars, where it is most useful — this
                is the same preference, not a second one. */}
            <EvalToggle on={evalOn} onChange={setEvalOn} />
          </div>
        </div>

        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          These settings are stored in this browser, so they apply on this device
          whether or not you are signed in.
        </p>
      </div>
    </div>
  );
}
