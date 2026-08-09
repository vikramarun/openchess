// Collecting the engine's top-N moves from a MultiPV search.
//
// This is the substrate for playing-style dials: ask Stockfish for several
// moves, keep only those within a small centipawn window of the best (inside
// that window every move is objectively sound), and let a personality pick
// among them. Modern Stockfish has no style options at all — Contempt was
// removed and never reimplemented for NNUE — so choosing among the engine's own
// good moves is the only place character can come from.
//
// The overriding rule: this is an OVERLAY. It can only ever pick a move the
// engine already endorsed, and every ambiguity resolves back to `bestmove`.

import { parseUciInfo, type InfoLine } from "./engine";

/** Mate scores map above every centipawn score, ordered by distance to mate. */
export const MATE_SCORE = 100_000;
/** Within this of MATE_SCORE, the game is decided by force — stop styling. */
export const MATE_WINDOW = 1_000;

/** One comparable integer for `cp` and `mate` scores alike.
 *
 *  Faster mates rank above slower ones (`mate 1` > `mate 5`), and being mated
 *  slowly beats being mated quickly (`mate -5` > `mate -1`). */
export function sortableScore(c: { cp: number | null; mate: number | null }): number {
  if (c.mate !== null) return c.mate > 0 ? MATE_SCORE - c.mate : -MATE_SCORE - c.mate;
  return c.cp ?? 0;
}

export type Candidate = {
  /** `pv[0]` — the move itself, and this candidate's identity. */
  uci: string;
  cp: number | null;
  mate: number | null;
  depth: number;
  pv: string[];
  wdl: [number, number, number] | null;
};

export type Harvest = {
  /** Fresh candidates, best first. */
  candidates: Candidate[];
  maxDepth: number;
  /** False when the engine's final `bestmove` isn't among the fresh
   *  candidates — the search changed its mind after the last PV burst, so the
   *  collection is stale and must not be styled. */
  trusted: boolean;
};

/** Accumulates a MultiPV search's `info` lines into a candidate set.
 *
 *  Keyed by MOVE, not by multipv index. Stockfish prints all N pv lines in one
 *  burst per completed depth, but a move's INDEX is not stable across depths —
 *  moves swap ranks as the search deepens. Keying by index would eventually
 *  merge one move's depth-21 score with another's depth-22 score under the same
 *  slot and compare scores from different searches. */
export class CandidateCollector {
  private byMove = new Map<string, Candidate>();
  private deepest = 0;

  feed(line: string): void {
    const i = parseUciInfo(line);
    if (!i) return;
    this.add(i);
  }

  /** Feed an already-parsed line (used by the tests and by callers that have
   *  parsed for another reason). */
  add(i: InfoLine): void {
    // Bounds are inequalities, not values: a `lowerbound 40` move could truly
    // be +400, and putting that in a centipawn window is a category error.
    if (i.bound !== null) return;
    if (i.pv.length === 0) return; // no move identity
    const uci = i.pv[0];
    const prev = this.byMove.get(uci);
    // Strictly greater, so an equal-depth re-report (a later burst in the same
    // iteration) wins and refreshes the score.
    if (prev && prev.depth > i.depth) return;
    this.byMove.set(uci, {
      uci,
      cp: i.cp,
      mate: i.mate,
      depth: i.depth,
      pv: i.pv,
      wdl: i.wdl,
    });
    if (i.depth > this.deepest) this.deepest = i.depth;
  }

  /** Freeze the collection against the engine's final answer.
   *
   *  Keeps candidates at `maxDepth` or one ply behind. That is exactly
   *  Stockfish's own staleness convention: lines it has not re-searched at the
   *  current depth are reprinted labelled `depth - 1` with their previous
   *  score, so depth-inconsistency never has to be guessed at. */
  harvest(bestmove: string): Harvest {
    const fresh = [...this.byMove.values()].filter((c) => c.depth >= this.deepest - 1);
    fresh.sort((a, b) => sortableScore(b) - sortableScore(a) || a.uci.localeCompare(b.uci));
    return {
      candidates: fresh,
      maxDepth: this.deepest,
      trusted: fresh.some((c) => c.uci === bestmove),
    };
  }
}

export type WindowOpts = {
  /** How much eval may be given up for style, in centipawns. 0 disables. */
  epsilonCp: number;
  /** Below this completed depth the search is too green to style. */
  minDepth: number;
  /** Once |score| exceeds this the game is decided; just play the best move. */
  disableBeyondCp: number;
};

/** The moves a personality may choose between.
 *
 *  Returns an EMPTY array whenever style must not apply, which the caller reads
 *  as "play `bestmove` verbatim". That happens more often than not, and every
 *  case is deliberate:
 *
 *   - `epsilonCp` is 0 (the default — full strength, today's behaviour);
 *   - the collection is untrusted (the engine's final answer isn't in it);
 *   - the search is shallower than `minDepth`;
 *   - a mate is on the board, in either direction. An attacking personality
 *     must never trade a forced mate for a flashier non-mating sacrifice, and
 *     a losing one must play the engine's longest resistance;
 *   - the position is already decided, so there is nothing to express. */
export function acceptableMoves(h: Harvest, opts: WindowOpts): Candidate[] {
  if (opts.epsilonCp <= 0) return [];
  if (!h.trusted || h.candidates.length < 2) return [];
  if (h.maxDepth < opts.minDepth) return [];

  const best = sortableScore(h.candidates[0]);
  if (Math.abs(best) >= MATE_SCORE - MATE_WINDOW) return [];
  if (Math.abs(best) > opts.disableBeyondCp) return [];

  // Belt and braces: a mate score anywhere in the pool is excluded even if the
  // best move isn't a mate, so style can never walk into being mated.
  return h.candidates.filter((c) => c.mate === null && best - sortableScore(c) <= opts.epsilonCp);
}
