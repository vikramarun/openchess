// Small pure helpers for presenting a chess position — shared by the game views
// so the board shows the same cues every serious chess UI does (last move,
// side to move, material edge) without re-deriving them three times.

export type Side = "white" | "black";

/** [from, to] squares of a UCI move (e.g. "e2e4" -> ["e2","e4"], "e7e8q" too). */
export function lastMoveFromUci(uci: string | null | undefined): [string, string] | null {
  if (!uci || uci.length < 4) return null;
  return [uci.slice(0, 2), uci.slice(2, 4)];
}

/** Side to move, read from the FEN's active-color field. */
export function sideToMoveFromFen(fen: string): Side {
  return fen.split(" ")[1] === "b" ? "black" : "white";
}

const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };

/** Material advantage in pawns from white's perspective (+3 = white up a minor
 *  piece), plus the list of piece letters each side has captured, derived from
 *  the FEN board field vs the standard starting complement. */
export function material(fen: string): {
  advantage: number;
  whiteCaptured: string[]; // black pieces white has captured (shown by white)
  blackCaptured: string[];
} {
  const board = fen.split(" ")[0];
  const counts: Record<string, number> = {};
  for (const ch of board) {
    if (/[a-zA-Z]/.test(ch)) counts[ch] = (counts[ch] ?? 0) + 1;
  }
  const start: Record<string, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };
  const whiteCaptured: string[] = []; // missing black pieces
  const blackCaptured: string[] = []; // missing white pieces
  let advantage = 0;
  for (const [letter, n0] of Object.entries(start)) {
    const missingBlack = n0 - (counts[letter] ?? 0); // black lowercase
    const missingWhite = n0 - (counts[letter.toUpperCase()] ?? 0);
    for (let i = 0; i < Math.max(0, missingBlack); i++) whiteCaptured.push(letter);
    for (let i = 0; i < Math.max(0, missingWhite); i++) blackCaptured.push(letter);
    advantage += (VALUE[letter] ?? 0) * (missingBlack - missingWhite);
  }
  return { advantage, whiteCaptured, blackCaptured };
}

const GLYPH: Record<string, string> = { p: "♟", n: "♞", b: "♝", r: "♜", q: "♛" };
export function capturedGlyphs(letters: string[]): string {
  // Heaviest first for a tidy strip.
  const order = ["q", "r", "b", "n", "p"];
  return [...letters]
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .map((l) => GLYPH[l] ?? "")
    .join("");
}
