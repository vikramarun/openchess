"use client";

import { formatEval, whiteBarPct, type EvalScore } from "@/lib/evalScore";

/** Vertical evaluation bar shown beside the board: white's share of the bar
 *  grows from the white player's end, so it flips with board orientation. The
 *  number sits at that same end (dark-on-white once white's fill reaches it). */
export function EvalBar({
  score,
  orientation = "white",
  thinking,
}: {
  /** White-relative score, or null while the engine has nothing yet. */
  score: EvalScore | null;
  orientation?: "white" | "black";
  /** A search is in flight — dims the readout slightly. */
  thinking?: boolean;
}) {
  const pct = whiteBarPct(score);
  // "…" while there is no score: the engine is a 7 MB lazy download, so the
  // first seconds of a bar are legitimately empty. That used to be explained by
  // the toggle in the sidebar ("· loading engine…"), which no longer exists —
  // an unexplained blank strip beside the board is what this avoids.
  const label = formatEval(score) || "…";
  const flipped = orientation === "black";
  // The label sits in the last ~15px at white's end, which even a small board
  // covers by ~5% of bar height — so it has to flip to dark text well before
  // the fill is a visible fraction of the bar, or a lost position renders the
  // number light-on-white. Right at the boundary the label straddles both, and
  // the text-shadow in globals.css keeps it readable either way.
  const onWhite = pct >= 4;

  return (
    <div
      className={`eval-bar${flipped ? " flipped" : ""}`}
      role="img"
      aria-label={
        score ? `Engine evaluation ${label} (white's perspective)` : "Engine evaluation pending"
      }
      title={score ? `${label} · depth ${score.depth}` : "Evaluating…"}
    >
      <div className="eval-track">
        <div className="eval-fill" style={{ height: `${pct}%` }} />
      </div>
      <span className={`eval-num${onWhite ? " on-white" : ""}${thinking ? " thinking" : ""}`}>
        {label}
      </span>
    </div>
  );
}

/** On/off switch for the eval bar. The analysis runs on the viewer's own CPU,
 *  so this has to be opt-outable.
 *
 *  It lives in Customize → Settings and NOWHERE ELSE. It used to sit in every
 *  board sidebar as well, which put a preferences control on the one screen a
 *  player is watching money change hands on — four copies of one switch, three
 *  of them in the way. The bar itself covers the state the sidebar copies used
 *  to explain: it shows "…" until the first score arrives. */
export function EvalToggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className="eval-toggle">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span>Eval bar</span>
      <span className="muted">· runs in your browser</span>
    </label>
  );
}
