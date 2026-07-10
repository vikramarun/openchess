// Lightweight opening book for the in-browser engine. Bare Stockfish computes
// every move from scratch — including move 1, where it burns a big slice of the
// clock. A book makes the opening instant and gives games variety. Moves are
// matched by exact UCI move-sequence prefix; on any deviation we fall through to
// the engine. (The native client uses full Polyglot books; this is a curated
// mainline set, enough to skip the slow opening.)

const LINES: string[][] = [
  // 1.e4 e5
  ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6", "e1g1", "f8e7", "f1e1", "b7b5", "a4b3", "d7d6"], // Ruy Lopez
  ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "c2c3", "g8f6", "d2d3", "d7d6"], // Italian
  ["e2e4", "e7e5", "g1f3", "b8c6", "d2d4", "e5d4", "f3d4", "g8f6", "d4c6", "b7c6", "e4e5"], // Scotch
  ["e2e4", "e7e5", "g1f3", "g8f6", "f3e5", "d7d6", "e5f3", "f6e4", "d2d4", "d6d5"], // Petroff
  ["e2e4", "e7e5", "f2f4", "e5f4", "g1f3", "g7g5"], // King's Gambit
  // 1.e4 c5 (Sicilian)
  ["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4", "f3d4", "g8f6", "b1c3", "a7a6", "f1e2", "e7e5"], // Najdorf
  ["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4", "f3d4", "g8f6", "b1c3", "g7g6", "c1e3", "f8g7"], // Dragon
  ["e2e4", "c7c5", "g1f3", "b8c6", "f1b5", "g7g6", "e1g1", "f8g7"], // Rossolimo
  ["e2e4", "c7c5", "g1f3", "e7e6", "d2d4", "c5d4", "f3d4", "b8c6", "b1c3", "d8c7"], // Taimanov
  ["e2e4", "c7c5", "b1c3", "b8c6", "g2g3", "g7g6"], // Closed Sicilian
  // 1.e4 e6 (French)
  ["e2e4", "e7e6", "d2d4", "d7d5", "b1c3", "f8b4", "e4e5", "c7c5"], // Winawer
  ["e2e4", "e7e6", "d2d4", "d7d5", "b1d2", "g8f6", "e4e5", "f6d7"], // Tarrasch
  // 1.e4 c6 (Caro-Kann)
  ["e2e4", "c7c6", "d2d4", "d7d5", "b1c3", "d5e4", "c3e4", "c8f5"], // Classical
  ["e2e4", "c7c6", "d2d4", "d7d5", "e4e5", "c8f5"], // Advance
  // Other 1.e4
  ["e2e4", "d7d5", "e4d5", "d8d5", "b1c3", "d5a5"], // Scandinavian
  ["e2e4", "d7d6", "d2d4", "g8f6", "b1c3", "g7g6"], // Pirc
  ["e2e4", "g7g6", "d2d4", "f8g7", "b1c3", "d7d6"], // Modern
  // 1.d4 d5
  ["d2d4", "d7d5", "c2c4", "e7e6", "b1c3", "g8f6", "c1g5", "f8e7"], // QGD
  ["d2d4", "d7d5", "c2c4", "c7c6", "g1f3", "g8f6", "b1c3", "d5c4"], // Slav
  ["d2d4", "d7d5", "c2c4", "d5c4", "g1f3", "g8f6", "e2e3", "e7e6"], // QGA
  // 1.d4 Nf6
  ["d2d4", "g8f6", "c2c4", "e7e6", "b1c3", "f8b4", "e2e3", "e8g8"], // Nimzo-Indian
  ["d2d4", "g8f6", "c2c4", "g7g6", "b1c3", "f8g7", "e2e4", "d7d6"], // King's Indian
  ["d2d4", "g8f6", "c2c4", "g7g6", "b1c3", "d7d5", "c4d5", "f6d5"], // Grünfeld
  ["d2d4", "g8f6", "c2c4", "e7e6", "g1f3", "b7b6", "g2g3", "c8a6"], // Queen's Indian
  ["d2d4", "f7f5", "g2g3", "g8f6", "f1g2", "e7e6"], // Dutch
  // 1.c4 (English) / 1.Nf3
  ["c2c4", "e7e5", "b1c3", "g8f6", "g1f3", "b8c6"], // English
  ["c2c4", "c7c5", "g1f3", "g8f6", "b1c3", "b8c6"], // Symmetrical English
  ["g1f3", "d7d5", "d2d4", "g8f6", "c2c4", "e7e6"], // Réti → QGD
  ["g1f3", "g8f6", "g2g3", "g7g6", "f1g2", "f8g7"], // King's Indian Attack
];

// prefix (space-joined UCI) -> possible next moves
const BOOK = new Map<string, string[]>();
function addLine(line: string[]) {
  for (let i = 0; i < line.length; i++) {
    const key = line.slice(0, i).join(" ");
    const arr = BOOK.get(key) ?? [];
    // Keep duplicates so a random pick is weighted by how often a continuation
    // appears across the book — mainlines (e4/d4) dominate offbeat lines.
    arr.push(line[i]);
    BOOK.set(key, arr);
  }
}
// Curated lines are always available instantly (bundled). The big precomputed
// book (public/book.json, ~1800 real Stockfish opening lines from
// official-stockfish/books) is merged in lazily on the client for breadth.
LINES.forEach(addLine);

let bookRequested = false;
export function loadOpeningBook(): void {
  if (bookRequested || typeof window === "undefined") return;
  bookRequested = true;
  fetch("/book.json")
    .then((r) => (r.ok ? r.json() : []))
    .then((lines: string[]) => {
      for (const l of lines) addLine(l.split(" "));
    })
    .catch(() => {
      /* fall back to the curated lines */
    });
}
// Kick off the fetch as soon as this module is imported (client-side), so the
// broad book is usually ready by the time the first moves are played.
loadOpeningBook();

/** A book continuation (UCI) for the given move history, or null if out of book.
 *  Picks randomly among known continuations for variety. Index varies by move
 *  count so we don't need Math.random at module scope. */
export function bookMove(movesUci: string[]): string | null {
  const opts = BOOK.get(movesUci.join(" "));
  if (!opts || opts.length === 0) return null;
  if (opts.length === 1) return opts[0];
  return opts[Math.floor(Math.random() * opts.length)];
}
