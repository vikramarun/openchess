// The homepage demo reel (lib/demoReel.ts + components/HomeDemo.tsx).
//
// Three separate regressions, none of which anything else here would catch.
//
// 1. The reel is a scripted game whose whole payoff is the last move. If an edit
//    to the SAN list leaves it not-mate, the page still renders — it just ends
//    on a quiet position under a card that says "Checkmate — White wins".
// 2. The board it draws is a real <Chessboard> with a real <EvalBar>, driven by
//    canned numbers. If HomeDemo ever reaches for lib/engine, lib/useEval or
//    engineContext instead, the landing page starts costing every cold mobile
//    visit a 7 MB wasm download — silently, because it would still work.
//    app/page.tsx already imports useEngine for the status banner, so an
//    import-graph check on the page would not see it.
// 3. HomeDemo's ONLY teardown for a live game is being unmounted by the
//    `inGame` ternary in app/page.tsx. Hoisted above it, a marketing reel runs
//    under a board with money on it.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Chess } from "chessops/chess";
import { parseSan } from "chessops/san";

import {
  DEMO_FRAMES,
  DEMO_NOTES,
  DEMO_SAN,
  DEMO_START,
  DEMO_TOTAL,
  beatMs,
  nextBeat,
  type DemoState,
} from "../lib/demoReel";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

// --- the game itself ---
// Replayed independently of lib/demoReel's own build(), so this is a real second
// opinion rather than an assertion about the same walk.
const pos = Chess.default();
let illegal: string | null = null;
for (const san of DEMO_SAN) {
  const m = parseSan(pos, san);
  if (!m) {
    illegal = san;
    break;
  }
  pos.play(m);
}
check("every move in the reel is legal", illegal === null, `first bad move: ${illegal}`);
check("the reel ends in checkmate", pos.isCheckmate(), `end position: ${pos.turn} to move`);
check(
  "White delivers it",
  pos.isCheckmate() && pos.turn === "black",
  `${pos.turn} is to move at the end`,
);
check(
  "one frame per ply, plus the start position",
  DEMO_FRAMES.length === DEMO_SAN.length + 1,
  `${DEMO_FRAMES.length} frames for ${DEMO_SAN.length} moves`,
);

// Castling has two UCI spellings and chessops writes the wrong one. Nothing in
// the reel reaches an engine, but a king-takes-rook lastMove would highlight the
// rook's square instead of the king's — and this is the only file in the app
// that serialises castling by hand. O-O-O is ply 23.
const castle = DEMO_FRAMES[23];
check(
  "castling is the king's two-square move, not king-takes-rook",
  castle?.lastMove?.[0] === "e1" && castle?.lastMove?.[1] === "c1",
  `ply 23 lastMove is ${JSON.stringify(castle?.lastMove)}`,
);

// Clocks are derived from the think-times, so a bad literal shows up as time
// running backwards or a seat flagging mid-reel.
check(
  "neither clock runs out or goes backwards",
  DEMO_FRAMES.every(
    (f, i) =>
      f.whiteMs > 0 &&
      f.blackMs > 0 &&
      (i === 0 ||
        (f.whiteMs <= DEMO_FRAMES[i - 1].whiteMs && f.blackMs <= DEMO_FRAMES[i - 1].blackMs)),
  ),
  "a clock increased, or hit zero",
);
check(
  "every caption lands on a real ply",
  Object.keys(DEMO_NOTES).every((k) => Number(k) >= 1 && Number(k) <= DEMO_TOTAL),
  `notes: ${Object.keys(DEMO_NOTES).join(", ")}`,
);

// --- the phase machine ---
// Driven to exhaustion: it has to reach "hold" and stop, or the reel either
// never settles or loops forever on a landing page.
let s: DemoState = DEMO_START;
const seen: DemoState[] = [s];
let steps = 0;
while (steps < 500) {
  const n = nextBeat(s);
  if (!n) break;
  s = n;
  seen.push(s);
  steps++;
}
check("the reel terminates", steps < 500, `still running after ${steps} beats`);
check("it terminates in hold", s.phase === "hold", `ended in ${s.phase}`);
check("hold is a dead end", nextBeat(s) === null);
check(
  "it plays every ply on the way",
  seen.some((x) => x.phase === "play" && x.ply === DEMO_TOTAL),
  "never reached the final ply",
);
check(
  "every beat before hold has a finite duration",
  seen.slice(0, -1).every((x) => Number.isFinite(beatMs(x))),
  "an intermediate beat would never advance",
);
check("hold waits forever", !Number.isFinite(beatMs(s)));

// --- the component's two invariants ---
const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
/** Source with comments stripped.
 *
 *  Load-bearing: HomeDemo's own doc comment EXPLAINS that it must not import
 *  the engine, and naming the modules there was enough to fail the check below
 *  against a component that does everything right. (scripts/font.test.ts has
 *  the same shape of trap, for the same reason — this codebase comments a lot.)
 *  Strip block comments before line comments: a `//` inside a block comment is
 *  not a line comment, and removing the block first makes the order moot. */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

const demo = code("components/HomeDemo.tsx");
const demoRaw = read("components/HomeDemo.tsx");

for (const banned of ["lib/engine", "lib/useEval", "lib/engineContext"]) {
  check(
    `HomeDemo.tsx does not pull in ${banned}`,
    !demo.includes(banned),
    "the demo is canned; reaching for the engine costs a cold mobile load 7 MB",
  );
}
check(
  "the demo drives a real eval bar from canned numbers",
  demo.includes("showEval") && demo.includes("evalScore={frame.score}"),
);
check(
  "reduced motion remounts the board rather than animating 33 plies at once",
  /key=\{reduced \? "static" : "reel"\}/.test(demo),
);
// Read from the RAW source: the point is that the disclaimer is in the rendered
// output, and a stripped copy would also pass if it only survived in a comment.
check(
  "the board is labelled a demo in every frame",
  demoRaw.includes('className="demo-chip"') && demoRaw.includes('className="demo-note muted"'),
  "the Demo chip and the permanent note are what stop this reading as a real game",
);

const page = read("app/page.tsx");
// The `inGame` ternary's else-arm runs from ") : (" to the closing ")}" of the
// expression; <HomeDemo> has to be inside it.
const elseArm = page.slice(page.indexOf("inGame ? ("), page.indexOf('<div id="play">'));
check(
  "page.tsx renders <HomeDemo> inside the !inGame branch",
  elseArm.includes(") : (") && elseArm.slice(elseArm.indexOf(") : (")).includes("<HomeDemo"),
  "a live game must unmount the reel — that is its only teardown",
);

process.exit(failed === 0 ? 0 : 1);
