// Reading a repertoire as a tree, for the opening picker.
//
// Being able to *see* the book is what makes the repertoire honest: you can
// tell it's real theory, and you can see exactly where it runs out and the
// engine takes over.
//
// Expansion is one level at a time rather than materializing a whole tree —
// branching factor times depth explodes fast (3^10 ≈ 59k nodes), and the UI
// only ever shows the levels a user has opened.

import { Chess } from "chessops/chess";
import { makeSan } from "chessops/san";
import { parseUci } from "chessops/util";

import { decodeMove, entriesFor, polyglotKey, type BookEntry } from "./polyglot";

export type BookChild = {
  /** UCI, as the engine and server speak it. */
  uci: string;
  /** SAN, as a human reads it (`Nf3`, `O-O`, `exd5`). */
  san: string;
  weight: number;
  /** Weight as a fraction of this position's total — the width of the bar. */
  share: number;
};

/** Replay a UCI history, returning the position or null if it isn't legal.
 *  Shared by the tree UI so a malformed path can't throw mid-render. */
export function positionAfter(history: string[]): Chess | null {
  const pos = Chess.default();
  for (const u of history) {
    const m = parseUci(u);
    if (!m || !pos.isLegal(m)) return null;
    pos.play(m);
  }
  return pos;
}

/** The book's moves for one position, heaviest first.
 *
 *  Entries that don't decode to a legal move are dropped rather than rendered
 *  as a dead branch — the tree should only ever show moves the bot could
 *  actually play. `share` is computed after that filter so the bars sum to 1. */
export function bookChildren(entries: BookEntry[], pos: Chess): BookChild[] {
  const found = entriesFor(entries, polyglotKey(pos));
  if (found.length === 0) return [];

  const out: BookChild[] = [];
  for (const e of found) {
    const uci = decodeLegal(pos, e);
    if (!uci) continue;
    const m = parseUci(uci)!;
    out.push({ uci, san: makeSan(pos, m), weight: e.weight, share: 0 });
  }
  const total = out.reduce((s, c) => s + c.weight, 0);
  for (const c of out) c.share = total > 0 ? c.weight / total : 1 / out.length;
  out.sort((a, b) => b.weight - a.weight || a.san.localeCompare(b.san));
  return out;
}

/** Decode a book entry, keeping it only if it is actually playable here.
 *  `decodeMove` needs the position to undo Polyglot's king-takes-rook castling
 *  encoding, and returns null (rather than throwing) on out-of-spec input. */
function decodeLegal(pos: Chess, e: BookEntry): string | null {
  const uci = decodeMove(pos, e.move);
  if (!uci) return null;
  const m = parseUci(uci);
  return m && pos.isLegal(m) ? uci : null;
}

/** Follow the heaviest move from the start position — the line the bot plays
 *  with `pick: "best"`, and a good default preview.
 *
 *  Bounded by `maxPly`, and additionally stops if a position repeats: a book
 *  containing a shuffle cycle (Nf3 Nf6 Ng1 Ng8 …) would otherwise walk forever
 *  under a `while (move)` loop. */
export function bookMainline(entries: BookEntry[], maxPly = 12): BookChild[] {
  const pos = Chess.default();
  const seen = new Set<bigint>([polyglotKey(pos)]);
  const line: BookChild[] = [];
  for (let ply = 0; ply < maxPly; ply++) {
    const children = bookChildren(entries, pos);
    if (children.length === 0) break;
    const best = children[0];
    line.push(best);
    pos.play(parseUci(best.uci)!);
    const key = polyglotKey(pos);
    if (seen.has(key)) break; // transposition/cycle — stop rather than loop
    seen.add(key);
  }
  return line;
}
