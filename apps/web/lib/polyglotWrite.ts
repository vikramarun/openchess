// Writing Polyglot `.bin` books — the inverse of lib/polyglot.ts.
//
// We compose our own repertoire books from public-domain PGN rather than
// redistributing third-party books (see public/books/BOOKS.md). Because
// `polyglotKey` is already verified against the polyglot spec's reference keys
// (pnpm test:book), writing a book is just "encode the move, emit 16 bytes" —
// and built-in books then travel the exact same probe path as a user's
// uploaded `.bin` instead of needing a second format.
//
// Used by scripts/build-books.mjs (build time) and exercised by
// scripts/books.test.ts, which round-trips everything back through parseBook.

import type { Chess } from "chessops/chess";

import type { BookEntry } from "./polyglot";

const FILES = "abcdefgh";
/** Polyglot promotion codes: 0 none, 1 knight, 2 bishop, 3 rook, 4 queen. */
const PROMO_CODE: Record<string, number> = { n: 1, b: 2, r: 3, q: 4 };

/** Max value of the 16-bit weight field. */
export const MAX_WEIGHT = 0xffff;

function squareOf(uci: string, off: number): number | null {
  const file = FILES.indexOf(uci[off]);
  const rank = uci.charCodeAt(off + 1) - 49; // '1' -> 0
  if (file < 0 || rank < 0 || rank > 7) return null;
  return rank * 8 + file;
}

/** Encode a UCI move as a Polyglot move field, or null if it isn't well formed.
 *
 *  Polyglot stores castling as KING-TAKES-ROOK (e1h1), while the rest of this
 *  codebase — and the server — speak standard UCI (e1g1). `pos` is what lets us
 *  tell a castle from an ordinary two-square king move, so this is the exact
 *  inverse of `decodeMove` rather than a naive square-pair encoder. */
export function encodeMove(pos: Chess, uci: string): number | null {
  if (uci.length < 4 || uci.length > 5) return null;
  const from = squareOf(uci, 0);
  let to = squareOf(uci, 2);
  if (from === null || to === null) return null;

  const promoChar = uci.length === 5 ? uci[4] : "";
  if (promoChar && PROMO_CODE[promoChar] === undefined) return null;
  const promo = promoChar ? PROMO_CODE[promoChar] : 0;

  // Castling: a king stepping two files. Retarget onto its own corner rook,
  // mirroring decodeMove's `from ± 2` standard-chess assumption.
  const piece = pos.board.get(from);
  if (piece?.role === "king" && Math.abs((to & 7) - (from & 7)) === 2) {
    const rank = from >> 3;
    to = to > from ? rank * 8 + 7 : rank * 8;
  }

  return (to & 7) | (((to >> 3) & 7) << 3) | ((from & 7) << 6) | (((from >> 3) & 7) << 9) | (promo << 12);
}

/** Serialize entries as a Polyglot `.bin`: 16 big-endian bytes each — key(8),
 *  move(2), weight(2), learn(4) — sorted by key, which is what makes the
 *  binary search in `entriesFor` valid. Weights are clamped into the u16 the
 *  format allows. */
export function writeBook(entries: BookEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : a.move - b.move,
  );
  const buf = new ArrayBuffer(sorted.length * 16);
  const view = new DataView(buf);
  sorted.forEach((e, i) => {
    const off = i * 16;
    view.setBigUint64(off, e.key, false);
    view.setUint16(off + 8, e.move & 0xffff, false);
    view.setUint16(off + 10, Math.max(0, Math.min(MAX_WEIGHT, Math.round(e.weight))), false);
    view.setUint32(off + 12, 0, false); // `learn` — unused, and parseBook skips it
  });
  return new Uint8Array(buf);
}

/** Merge duplicate (key, move) pairs by summing their weights, so a book built
 *  from many games counts a repeated line once with a bigger weight. Overflow
 *  is clamped rather than wrapped — a wrapped u16 would turn the most popular
 *  move in the book into the least popular one. */
export function mergeEntries(entries: BookEntry[]): BookEntry[] {
  const byKeyMove = new Map<string, BookEntry>();
  for (const e of entries) {
    const k = `${e.key}:${e.move}`;
    const prev = byKeyMove.get(k);
    if (prev) prev.weight = Math.min(MAX_WEIGHT, prev.weight + e.weight);
    else byKeyMove.set(k, { ...e });
  }
  return [...byKeyMove.values()];
}
