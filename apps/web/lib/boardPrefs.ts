// Board appearance preferences — theme, piece set, and the display knobs
// chessground already supports but the app has been leaving at their defaults.
//
// Persisted per browser in localStorage, like every other preference here
// (lib/useEval.ts, lib/autoAccept.ts, lib/browserBot.ts). These are cosmetic and
// per-device, so there is no server round trip and they work signed out.
//
// Two consumers, and they need different things:
//   - the LOOK (board colors, piece art) is CSS custom properties on <html>, so
//     it is stamped once and every board on the page picks it up. The inline
//     bootstrap script in app/layout.tsx writes these before first paint.
//   - the BEHAVIOUR (coordinates, animation, highlights) is chessground config,
//     which components must push through `api.set()` when it changes.

import { boardBackground, boardTheme, DEFAULT_BOARD_THEME } from "./boardThemes";
import { DEFAULT_PIECE_SET, pieceSet, pieceVars } from "./pieceSets";

/** "inside" is chessground's default: rank/file labels drawn in the corners of
 *  the edge squares. lichess also offers a true outside-the-board gutter, which
 *  needs layout work around .cg-wrap rather than a chessground flag — not
 *  offered here rather than mislabelled. */
export type CoordsMode = "off" | "inside" | "all";
export type AnimationSpeed = "none" | "fast" | "normal" | "slow";

export type BoardPrefs = {
  board: string;
  pieces: string;
  coords: CoordsMode;
  animation: AnimationSpeed;
  highlightLastMove: boolean;
  highlightCheck: boolean;
};

/** lichess's own animation ladder (Pref.animationMillis). */
export const ANIMATION_MS: Record<AnimationSpeed, number> = {
  none: 0,
  fast: 120,
  normal: 250,
  slow: 500,
};

export const DEFAULT_PREFS: BoardPrefs = {
  board: DEFAULT_BOARD_THEME,
  pieces: DEFAULT_PIECE_SET,
  coords: "inside",
  animation: "normal",
  highlightLastMove: true,
  highlightCheck: true,
};

export const STORAGE_KEY = "openchess.board";

/** Exported for the bootstrap script, which embeds the same list so its
 *  normalization can't drift from `normalizePrefs`. */
export const COORDS_MODES: CoordsMode[] = ["off", "inside", "all"];
const SPEEDS: AnimationSpeed[] = ["none", "fast", "normal", "slow"];

function oneOf<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === "string" && (allowed as string[]).includes(value) ? (value as T) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Coerce anything into a usable BoardPrefs. A theme or piece set that no longer
 *  exists falls back to the default rather than rendering an invisible board. */
export function normalizePrefs(raw: unknown): BoardPrefs {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    // boardTheme()/pieceSet() already fall back to the first entry on a miss.
    board: boardTheme(typeof o.board === "string" ? o.board : "").id,
    pieces: pieceSet(typeof o.pieces === "string" ? o.pieces : "").id,
    coords: oneOf(o.coords, COORDS_MODES, DEFAULT_PREFS.coords),
    animation: oneOf(o.animation, SPEEDS, DEFAULT_PREFS.animation),
    highlightLastMove: bool(o.highlightLastMove, DEFAULT_PREFS.highlightLastMove),
    highlightCheck: bool(o.highlightCheck, DEFAULT_PREFS.highlightCheck),
  };
}

function readStorage(): BoardPrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    return normalizePrefs(JSON.parse(raw));
  } catch {
    // Private mode, disabled storage, or corrupt JSON — the defaults are fine.
    return DEFAULT_PREFS;
  }
}

// --- store ------------------------------------------------------------------
// getSnapshot must return a stable reference or useSyncExternalStore loops, so
// the parsed value is cached and only replaced on an actual change.

let cached: BoardPrefs | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function getBoardPrefs(): BoardPrefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  if (!cached) cached = readStorage();
  return cached;
}

export function saveBoardPrefs(next: BoardPrefs) {
  cached = normalizePrefs(next);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
  } catch {
    // Storage unavailable — the preference still applies for this session.
  }
  applyBoardPrefs(cached);
  emit();
}

export function subscribeBoardPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Adopt a change made in another tab. Wired up once, in the board bootstrap. */
export function onExternalStorageChange(e: StorageEvent) {
  if (e.key !== null && e.key !== STORAGE_KEY) return;
  cached = readStorage();
  applyBoardPrefs(cached);
  emit();
}

export function getServerPrefs(): BoardPrefs {
  return DEFAULT_PREFS;
}

// --- applying ---------------------------------------------------------------

/** Every CSS custom property a board needs: the generated squares, the label
 *  ink, the last-move wash, and the 12 piece images. */
export function boardCssVars(prefs: BoardPrefs): Record<string, string> {
  const theme = boardTheme(prefs.board);
  return {
    "--board-bg": boardBackground(theme.light, theme.dark),
    "--board-light": theme.light,
    "--board-dark": theme.dark,
    "--board-coord-on-light": theme.coordOnLight,
    "--board-coord-on-dark": theme.coordOnDark,
    "--board-last-move": theme.lastMove,
    ...pieceVars(prefs.pieces),
  };
}

/** Stamp the theme onto <html>, where every board on the page inherits it.
 *
 *  Deliberately not parameterised by element: one document-level write is the
 *  whole point. Nothing here needs two boards themed differently, and the
 *  settings preview is an ordinary board reading these same variables, which is
 *  exactly why it updates in the same frame as the game boards behind it. */
export function applyBoardPrefs(prefs: BoardPrefs) {
  if (typeof document === "undefined") return;
  const target = document.documentElement;
  for (const [name, value] of Object.entries(boardCssVars(prefs))) {
    target.style.setProperty(name, value);
  }
  // Coordinates are the one DISPLAY pref CSS can honor before React mounts —
  // the bootstrap script stamps this same attribute pre-paint, and
  // globals.css hides coords under html[data-coords="off"].
  target.setAttribute("data-coords", prefs.coords);
}

/** The chessground config a live board can adopt through `api.set()`.
 *
 *  `coordinates` / `coordinatesOnSquares` are deliberately NOT here. chessground
 *  builds its coordinate elements once, in the initial wrap render, and `set()`
 *  never rebuilds them — passing them would silently do nothing. The board
 *  component owns those: it hides coordinates in CSS, and only the "every
 *  square" layout (a genuinely different DOM) recreates the instance. */
export function displayConfig(prefs: BoardPrefs) {
  return {
    animation: {
      enabled: ANIMATION_MS[prefs.animation] > 0,
      duration: ANIMATION_MS[prefs.animation],
    },
    highlight: {
      lastMove: prefs.highlightLastMove,
      check: prefs.highlightCheck,
    },
  };
}
