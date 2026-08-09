// Board themes. A board is a light/dark square pair plus the ink used for the
// rank/file labels — no image assets. chessground draws the squares as a
// background-image on <cg-board>, so a theme is one generated SVG data URI.
//
// Generating rather than shipping textures keeps a theme at ~700 bytes, gives
// crisp edges at any board size, and sidesteps the license on lichess's board
// images (their board art is AGPLv3+, unlike the piece sets we vendor).

export type BoardTheme = {
  id: string;
  label: string;
  light: string;
  dark: string;
  /** Label ink drawn over a light square. */
  coordOnLight: string;
  /** Label ink drawn over a dark square. */
  coordOnDark: string;
  /** Last-move square wash. Overridable so dark boards can stay legible. */
  lastMove: string;
};

const LAST_MOVE_DEFAULT = "rgba(155, 199, 0, 0.41)"; // chessground's brown value
const INK_DARK = "rgba(72, 72, 72, 0.8)";
const INK_LIGHT = "rgba(255, 255, 255, 0.8)";

export const BOARD_THEMES: BoardTheme[] = [
  {
    id: "brown",
    label: "Brown",
    light: "#f0d9b5",
    dark: "#b58863",
    coordOnLight: INK_DARK,
    coordOnDark: INK_LIGHT,
    lastMove: LAST_MOVE_DEFAULT,
  },
  {
    id: "blue",
    label: "Blue",
    light: "#dee3e6",
    dark: "#8ca2ad",
    coordOnLight: INK_DARK,
    coordOnDark: INK_LIGHT,
    lastMove: LAST_MOVE_DEFAULT,
  },
  {
    id: "green",
    label: "Green",
    light: "#ffffdd",
    dark: "#86a666",
    coordOnLight: INK_DARK,
    coordOnDark: INK_LIGHT,
    lastMove: LAST_MOVE_DEFAULT,
  },
  {
    id: "ic",
    label: "Ivory",
    light: "#ececec",
    dark: "#c1c18e",
    coordOnLight: INK_DARK,
    coordOnDark: INK_LIGHT,
    lastMove: LAST_MOVE_DEFAULT,
  },
  {
    id: "purple",
    label: "Purple",
    light: "#e8e0f0",
    dark: "#9a86b8",
    coordOnLight: INK_DARK,
    coordOnDark: INK_LIGHT,
    lastMove: LAST_MOVE_DEFAULT,
  },
  {
    id: "walnut",
    label: "Walnut",
    light: "#e5cfa9",
    dark: "#8f6244",
    coordOnLight: INK_DARK,
    coordOnDark: INK_LIGHT,
    lastMove: LAST_MOVE_DEFAULT,
  },
  {
    id: "grey",
    label: "Grey",
    light: "#dcdcdc",
    dark: "#9e9e9e",
    coordOnLight: INK_DARK,
    coordOnDark: INK_LIGHT,
    lastMove: LAST_MOVE_DEFAULT,
  },
  {
    id: "midnight",
    label: "Midnight",
    light: "#6f7d92",
    dark: "#3d4a5c",
    // A dark board needs light ink on both halves, and a warmer last-move wash
    // than the yellow-green that reads well on a light board.
    coordOnLight: "rgba(20, 24, 30, 0.85)",
    coordOnDark: INK_LIGHT,
    lastMove: "rgba(190, 220, 90, 0.32)",
  },
];

export const DEFAULT_BOARD_THEME = "brown";

export function boardTheme(id: string): BoardTheme {
  return BOARD_THEMES.find((t) => t.id === id) ?? BOARD_THEMES[0];
}

/** The 32 dark squares of an 8x8 board as one SVG path, in a 0 0 8 8 viewBox.
 *  Built once — the light squares are just the backdrop rect. Exported so the
 *  pre-paint bootstrap script (lib/boardBootstrap.ts) can build the same URI
 *  without shipping a copy of this table. */
export const DARK_SQUARES = (() => {
  let d = "";
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      if ((rank + file) % 2 === 1) d += `M${file} ${rank}h1v1H${file}z`;
    }
  }
  return d;
})();

/** A board's squares as a CSS `url(...)` value.
 *
 *  `shape-rendering="crispEdges"` is what keeps square borders sharp instead of
 *  antialiased into a seam — the same trick chessground's own board CSS uses.
 *  <cg-board> sets `background-size: cover`, so the 8-unit viewBox scales to
 *  exactly one square per board square at any size. */
export function boardBackground(light: string, dark: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" shape-rendering="crispEdges">` +
    `<rect width="8" height="8" fill="${light}"/>` +
    `<path fill="${dark}" d="${DARK_SQUARES}"/>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
