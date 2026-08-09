// Verify the board-preference plumbing: that stored junk can never render an
// invisible board, that the CSS variables the stylesheet reads are all actually
// produced, and that the pre-paint bootstrap script agrees with the React path.
//
// That last one is the reason this file exists. The theme is applied twice by
// two different code paths — an inline script before first paint, and
// applyBoardPrefs() after React mounts — and if they disagree the board visibly
// changes on load. A screenshot of a settled page would never catch it.
import {
  ANIMATION_MS,
  DEFAULT_PREFS,
  boardCssVars,
  displayConfig,
  normalizePrefs,
} from "../lib/boardPrefs";
import { boardBootstrapScript } from "../lib/boardBootstrap";
import { BOARD_THEMES, boardBackground, boardTheme } from "../lib/boardThemes";
import { COLORS, PIECE_SETS, ROLES, pieceVar } from "../lib/pieceSets";

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`,
  );
}

// --- normalization: anything stored must yield a usable board ---
check("empty object falls back to defaults", normalizePrefs({}), DEFAULT_PREFS);
check("null falls back to defaults", normalizePrefs(null), DEFAULT_PREFS);
check("garbage falls back to defaults", normalizePrefs("nonsense"), DEFAULT_PREFS);
check(
  "a removed theme falls back rather than rendering nothing",
  normalizePrefs({ board: "no-such-theme" }).board,
  DEFAULT_PREFS.board,
);
check(
  "a removed piece set falls back rather than rendering nothing",
  normalizePrefs({ pieces: "no-such-set" }).pieces,
  DEFAULT_PREFS.pieces,
);
check("an unknown coords mode falls back", normalizePrefs({ coords: "sideways" }).coords, "inside");
check("a non-boolean highlight falls back", normalizePrefs({ highlightCheck: "yes" }).highlightCheck, true);
check("valid values survive", normalizePrefs({ board: "blue", pieces: "celtic", coords: "all" }), {
  ...DEFAULT_PREFS,
  board: "blue",
  pieces: "celtic",
  coords: "all",
});
check("normalizing is idempotent", normalizePrefs(normalizePrefs({ board: "green" })), {
  ...DEFAULT_PREFS,
  board: "green",
});

// --- every theme and set is selectable and complete ---
check("theme ids are unique", BOARD_THEMES.length, new Set(BOARD_THEMES.map((t) => t.id)).size);
check("piece set ids are unique", PIECE_SETS.length, new Set(PIECE_SETS.map((p) => p.id)).size);
check("the default theme exists", boardTheme(DEFAULT_PREFS.board).id, DEFAULT_PREFS.board);
for (const t of BOARD_THEMES) {
  check(`theme ${t.id} round-trips through normalize`, normalizePrefs({ board: t.id }).board, t.id);
}
for (const p of PIECE_SETS) {
  check(`set ${p.id} round-trips through normalize`, normalizePrefs({ pieces: p.id }).pieces, p.id);
}

// --- the variables app/board.css reads must all be produced ---
const vars = boardCssVars(DEFAULT_PREFS);
const REQUIRED_BOARD_VARS = [
  "--board-bg",
  "--board-light",
  "--board-dark",
  "--board-coord-on-light",
  "--board-coord-on-dark",
  "--board-last-move",
];
for (const name of REQUIRED_BOARD_VARS) {
  check(`${name} is set`, typeof vars[name] === "string" && vars[name].length > 0, true);
}
const pieceVarNames = COLORS.flatMap(([color]) => ROLES.map(([role]) => pieceVar(color, role)));
check("there are 12 piece variables", pieceVarNames.length, 12);
for (const name of pieceVarNames) {
  check(`${name} is set`, typeof vars[name] === "string" && vars[name].startsWith("url("), true);
}
check(
  "piece urls point at the chosen set",
  vars[pieceVar("white", "knight")],
  `url("/piece/${DEFAULT_PREFS.pieces}/wN.svg")`,
);

// --- the generated board image ---
const bg = boardBackground("#f0d9b5", "#b58863");
check("board background is a data uri", bg.startsWith('url("data:image/svg+xml,'), true);
check("board background encodes both colors", bg.includes("f0d9b5") && bg.includes("b58863"), true);
check(
  "board background has 32 dark squares",
  (decodeURIComponent(bg).match(/h1v1H/g) ?? []).length,
  32,
);
check(
  "two themes produce different backgrounds",
  boardBackground("#111111", "#222222") === boardBackground("#333333", "#444444"),
  false,
);

// --- live chessground config ---
check("animation ladder matches lichess", ANIMATION_MS, { none: 0, fast: 120, normal: 250, slow: 500 });
check("no animation disables it outright", displayConfig({ ...DEFAULT_PREFS, animation: "none" }).animation, {
  enabled: false,
  duration: 0,
});
check("slow animation stays enabled", displayConfig({ ...DEFAULT_PREFS, animation: "slow" }).animation, {
  enabled: true,
  duration: 500,
});
check(
  "highlights pass through",
  displayConfig({ ...DEFAULT_PREFS, highlightLastMove: false, highlightCheck: true }).highlight,
  { lastMove: false, check: true },
);
// coordinates must NOT be here: chessground only reads them when it builds the
// board, so shipping them through api.set() would silently do nothing.
check(
  "displayConfig omits coordinates",
  Object.keys(displayConfig(DEFAULT_PREFS)).sort(),
  ["animation", "highlight"],
);

// --- the bootstrap script must agree with applyBoardPrefs ---
const script = boardBootstrapScript();
check("bootstrap cannot break out of the script tag", script.includes("</script"), false);
for (const t of BOARD_THEMES) {
  check(`bootstrap knows theme ${t.id}`, script.includes(`"${t.id}"`), true);
}
for (const p of PIECE_SETS) {
  check(`bootstrap knows set ${p.id}`, script.includes(`"${p.id}"`), true);
}
for (const name of [...REQUIRED_BOARD_VARS, ...pieceVarNames]) {
  // Piece variables are built by concatenation in the script, so check the stem.
  const stem = name.startsWith("--piece-") ? "--piece-" : name;
  check(`bootstrap writes ${name}`, script.includes(stem), true);
}

// Run the bootstrap the way a browser would and compare what it stamps on
// <html> against what the React path computes for the same stored preference.
function runBootstrap(stored: unknown): Record<string, string> {
  const applied: Record<string, string> = {};
  const sandbox = {
    localStorage: { getItem: () => (stored === undefined ? null : JSON.stringify(stored)) },
    document: {
      documentElement: {
        style: {
          setProperty(name: string, value: string) {
            applied[name] = value;
          },
        },
      },
    },
  };
  // eslint-disable-next-line no-new-func
  new Function("localStorage", "document", script)(sandbox.localStorage, sandbox.document);
  return applied;
}

for (const stored of [
  undefined,
  {},
  { board: "blue", pieces: "celtic" },
  { board: "midnight", pieces: "rhosgfx" },
  { board: "bogus", pieces: "bogus" },
]) {
  const label = JSON.stringify(stored) ?? "nothing stored";
  check(`bootstrap matches applyBoardPrefs for ${label}`, runBootstrap(stored), boardCssVars(normalizePrefs(stored)));
}

console.log(failed === 0 ? "\nall board-preference checks passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
