// Polyglot opening-book support for the in-browser bot: compute the polyglot
// Zobrist key for a chessops position, parse an uploaded `.bin`, and probe it.
//
// The key tables are generated from shakmaty's polyglot-compatible zobrist
// implementation (lib/polyglotTable.ts), so browser and native clients agree
// byte-for-byte on which positions are "in book". Verified against the
// polyglot spec's reference keys (see scripts/test in the PR).

import type { Chess } from "chessops/chess";

import { CASTLING, EN_PASSANT, PIECES, WHITE_TURN } from "./polyglotTable";

const ROLE_IDX: Record<string, number> = {
  pawn: 0,
  knight: 1,
  bishop: 2,
  rook: 3,
  queen: 4,
  king: 5,
};

/** Polyglot Zobrist key of a position (matches shakmaty/`.bin` semantics). */
export function polyglotKey(pos: Chess): bigint {
  let key = 0n;
  // Pieces.
  for (const square of pos.board.occupied) {
    const piece = pos.board.get(square)!;
    const colorIdx = piece.color === "white" ? 0 : 1;
    key ^= PIECES[colorIdx * 6 * 64 + ROLE_IDX[piece.role] * 64 + square];
  }
  // Castling rights: standard-chess rook squares still holding rights.
  const rooks = pos.castles.castlingRights;
  if (rooks.has(7)) key ^= CASTLING[0]; // h1: white king-side
  if (rooks.has(0)) key ^= CASTLING[1]; // a1: white queen-side
  if (rooks.has(63)) key ^= CASTLING[2]; // h8: black king-side
  if (rooks.has(56)) key ^= CASTLING[3]; // a8: black queen-side
  // En passant, only when a side-to-move pawn can actually capture (polyglot
  // and shakmaty's EnPassantMode::Legal both use the "pseudo-legal capture
  // exists" refinement; chessops' epSquare is already legality-filtered).
  if (pos.epSquare !== undefined) {
    const file = pos.epSquare & 7;
    const rank = pos.epSquare >> 3;
    const capturerRank = pos.turn === "white" ? rank - 1 : rank + 1;
    const pawns = pos.board.pawn.intersect(pos.board[pos.turn]);
    const left = file > 0 ? capturerRank * 8 + file - 1 : -1;
    const right = file < 7 ? capturerRank * 8 + file + 1 : -1;
    if ((left >= 0 && pawns.has(left)) || (right >= 0 && pawns.has(right))) {
      key ^= EN_PASSANT[file];
    }
  }
  if (pos.turn === "white") key ^= WHITE_TURN;
  return key;
}

export type BookEntry = { key: bigint; move: number; weight: number };

/** Parse a Polyglot `.bin`: 16-byte big-endian entries sorted by key. */
export function parseBook(buf: ArrayBuffer): BookEntry[] {
  if (buf.byteLength % 16 !== 0) throw new Error("not a Polyglot book (size % 16 != 0)");
  const view = new DataView(buf);
  const entries: BookEntry[] = [];
  for (let off = 0; off < buf.byteLength; off += 16) {
    entries.push({
      key: view.getBigUint64(off, false),
      move: view.getUint16(off + 8, false),
      weight: view.getUint16(off + 10, false),
    });
  }
  // Books are sorted by key on disk, but don't trust the input.
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return entries;
}

const FILES = "abcdefgh";

/** Decode a polyglot move field to UCI for the given position. Polyglot
 *  encodes castling as king-takes-rook (e1h1); convert to standard UCI. */
export function decodeMove(pos: Chess, mv: number): string | null {
  const toFile = mv & 7;
  const toRank = (mv >> 3) & 7;
  const fromFile = (mv >> 6) & 7;
  const fromRank = (mv >> 9) & 7;
  const promo = (mv >> 12) & 7; // 0 none, 1 knight … 4 queen
  const from = fromRank * 8 + fromFile;
  const to = toRank * 8 + toFile;

  // Castling: king moves onto its own rook.
  const piece = pos.board.get(from);
  if (piece?.role === "king" && pos.board.get(to)?.role === "rook" && pos.board.get(to)?.color === piece.color) {
    // chessops accepts king-takes-rook as a castling Move object; emit the
    // standard UCI square form instead so the server accepts it.
    const kingTo = to > from ? from + 2 : from - 2;
    return `${FILES[from & 7]}${(from >> 3) + 1}${FILES[kingTo & 7]}${(kingTo >> 3) + 1}`;
  }

  // Polyglot promo: 0 none, 1 knight … 4 queen. Values 5-7 are out of spec —
  // reject rather than silently dropping the promotion (which would yield an
  // illegal, non-promoting move).
  if (promo > 4) return null;
  const promoStr = ["", "n", "b", "r", "q"][promo];
  return (
    `${FILES[fromFile]}${fromRank + 1}${FILES[toFile]}${toRank + 1}` + promoStr
  );
}

/** All book entries for a position (binary search over the sorted entries). */
export function entriesFor(entries: BookEntry[], key: bigint): BookEntry[] {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].key < key) lo = mid + 1;
    else hi = mid;
  }
  const out: BookEntry[] = [];
  for (let i = lo; i < entries.length && entries[i].key === key; i++) out.push(entries[i]);
  return out;
}

/** Highest-weight book move for the position, as UCI (matches the native
 *  client's deterministic `BookPolicy::Best`). */
export function pickBookMove(entries: BookEntry[], pos: Chess): string | null {
  const found = entriesFor(entries, polyglotKey(pos));
  if (found.length === 0) return null;
  const best = found.reduce((a, b) => (b.weight > a.weight ? b : a));
  return decodeMove(pos, best.move);
}
