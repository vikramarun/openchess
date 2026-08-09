// Standard-UCI move serialization, and the reason this file exists.
//
// chessops — like Polyglot, and like Chess960 UCI — represents castling as
// KING TAKES ROOK ("e1h1"). A UCI engine running standard chess does not accept
// that form, and it does not complain either: Stockfish's `position startpos
// moves …` parser stops at the first move it cannot read and silently keeps the
// prefix. The engine is then a ply behind for the rest of the game, usually with
// the wrong side to move, so every `bestmove` it returns is illegal in the real
// position — which the server rejects, and the seat resigns over.
//
// So: anything that reaches an engine, or the wire, goes through here first.

import { Chess } from "chessops/chess";
import { parseUci } from "chessops/util";
import type { Move } from "chessops/types";

const FILES = "abcdefgh";
const squareName = (s: number) => `${FILES[s & 7]}${(s >> 3) + 1}`;

/** Serialize a move as standard UCI: the king's two-square form for castling
 *  ("e1g1"), never king-takes-rook. Drops are not part of standard chess. */
export function makeStandardUci(pos: Chess, move: Move): string {
  if (!("from" in move)) return "";
  const { from, to } = move;
  const piece = pos.board.get(from);
  const target = pos.board.get(to);
  // Castling is the only move that lands a king on its own rook.
  if (piece?.role === "king" && target?.role === "rook" && target.color === piece.color) {
    return `${squareName(from)}${squareName(to > from ? from + 2 : from - 2)}`;
  }
  const promo = move.promotion ? move.promotion[0].replace("k", "n") : "";
  return `${squareName(from)}${squareName(to)}${promo}`;
}

/** Rewrite `uci` into standard UCI for `pos`, or null if it isn't legal there.
 *  Accepts either castling notation on the way in — the server does too, so a
 *  peer's "e1h1" must not be able to desync our engine. */
export function toStandardUci(pos: Chess, uci: string): string | null {
  const move = parseUci(uci);
  if (!move || !pos.isLegal(move)) return null;
  return makeStandardUci(pos, move);
}

export type Replay = {
  /** The position after the whole history. */
  pos: Chess;
  /** The history, every move in standard UCI. */
  history: string[];
};

/** Replay a move history from the start position. Returns null if any move is
 *  illegal — the caller has nothing trustworthy to say about that position. */
export function replayHistory(movesUci: string[]): Replay | null {
  const pos = Chess.default();
  const history: string[] = [];
  for (const uci of movesUci) {
    const move = parseUci(uci);
    if (!move || !pos.isLegal(move)) return null;
    history.push(makeStandardUci(pos, move));
    pos.play(move);
  }
  return { pos, history };
}
