// Piece sets. Each set is 12 SVGs under public/piece/<id>/, named the way
// lichess names them (wP, wN, … bK). See public/piece/CREDITS.md for authors
// and licenses — every set here permits commercial use and redistribution.
//
// The set is applied as 12 CSS custom properties rather than by swapping a
// stylesheet, which is how lila does it too: switching sets becomes a style
// write with no network round trip and no flash of the previous set.

export type PieceSet = {
  id: string;
  label: string;
  /** Shown under the picker so attribution is visible, not just in a file. */
  credit: string;
};

export const PIECE_SETS: PieceSet[] = [
  { id: "cburnett", label: "Cburnett", credit: "Colin M.L. Burnett · BSD" },
  { id: "chessnut", label: "Chessnut", credit: "Alexis Luengas · Apache-2.0" },
  { id: "fantasy", label: "Fantasy", credit: "Maurizio Monge · MIT" },
  { id: "spatial", label: "Spatial", credit: "Maurizio Monge · MIT" },
  { id: "celtic", label: "Celtic", credit: "Maurizio Monge · MIT" },
  { id: "rhosgfx", label: "RhosGFX", credit: "RhosGFX · CC0" },
];

export const DEFAULT_PIECE_SET = "cburnett";

export function pieceSet(id: string): PieceSet {
  return PIECE_SETS.find((p) => p.id === id) ?? PIECE_SETS[0];
}

/** chessground's piece classes are `piece.pawn.white`; our files are `wP.svg`. */
export const ROLES: ReadonlyArray<readonly [role: string, letter: string]> = [
  ["pawn", "P"],
  ["knight", "N"],
  ["bishop", "B"],
  ["rook", "R"],
  ["queen", "Q"],
  ["king", "K"],
];

export const COLORS: ReadonlyArray<readonly [color: string, letter: string]> = [
  ["white", "w"],
  ["black", "b"],
];

/** CSS custom-property name for one piece, e.g. `--piece-white-pawn`. Must match
 *  the static rules in app/board.css. */
export function pieceVar(color: string, role: string): string {
  return `--piece-${color}-${role}`;
}

export function pieceUrl(setId: string, colorLetter: string, roleLetter: string): string {
  return `/piece/${setId}/${colorLetter}${roleLetter}.svg`;
}

/** The 12 `--piece-*` variables for a set. */
export function pieceVars(setId: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [color, c] of COLORS) {
    for (const [role, r] of ROLES) {
      vars[pieceVar(color, role)] = `url("${pieceUrl(setId, c, r)}")`;
    }
  }
  return vars;
}

// No <link rel="preload"> for the 12 files, deliberately. lila preloads because
// it serves pieces from a CDN, but ours are same-origin and only fetched once an
// actual <piece> element exists — so preloading in the document head would cost
// ~48 KB on every page, including the ones with no board on them, to save at
// most one frame on the pages that do.
