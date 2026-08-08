// Pure helpers for turning a UCI search score into what an eval bar shows.
// Kept separate from the engine + React so the mapping (which is the part that
// is easy to get subtly wrong — perspective and mate handling) is testable and
// lives in one place.

import type { EngineInfo } from "./engine";
import type { Side } from "./board";

/** A score from WHITE's perspective: +cp = white better, mate > 0 = white mates. */
export type EvalScore = { cp: number | null; mate: number | null; depth: number };

/** Flip a search score (side-to-move relative, per UCI) to white-relative. */
export function toWhiteRelative(info: EngineInfo, turn: Side): EvalScore {
  const sign = turn === "white" ? 1 : -1;
  return {
    cp: info.cp === null ? null : sign * info.cp,
    // `mate 0` means "side to move is mated" — sign-flipping 0 loses that, so
    // map it explicitly to a mate FOR the other side.
    mate: info.mate === null ? null : info.mate === 0 ? -sign : sign * info.mate,
    depth: info.depth,
  };
}

/** White's share of the bar, 0–100. Centipawns are mapped through the standard
 *  logistic win-probability curve (the lichess constant) rather than a linear
 *  scale, so the bar moves a lot around equality and saturates when the game is
 *  already decided. Clamped so the losing side never fully disappears — except
 *  on a forced mate, where a full bar is the point. */
export function whiteBarPct(score: EvalScore | null): number {
  if (!score) return 50;
  if (score.mate !== null) return score.mate > 0 ? 100 : 0;
  if (score.cp === null) return 50;
  const pct = 100 / (1 + Math.exp(-0.00368208 * score.cp));
  return Math.min(97, Math.max(3, pct));
}

/** The number printed on the bar: "+1.2", "-0.3", "M3" (white mates in 3),
 *  "-M2" (black mates in 2). One decimal, and whole pawns once the game is
 *  lopsided — the bar is ~20px wide, and past a few pawns the extra precision
 *  says nothing the bar itself doesn't. */
export function formatEval(score: EvalScore | null): string {
  if (!score) return "";
  if (score.mate !== null) return `${score.mate < 0 ? "-" : ""}M${Math.abs(score.mate)}`;
  if (score.cp === null) return "";
  const pawns = score.cp / 100;
  const sign = pawns > 0 ? "+" : pawns < 0 ? "-" : "";
  const mag = Math.abs(pawns);
  return `${sign}${mag >= 10 ? Math.round(mag) : mag.toFixed(1)}`;
}
