// Verify the eval-bar mapping: UCI `info` parsing, the side-to-move → white
// perspective flip, and the bar/label rendering of those scores. A silent sign
// error here would draw the bar backwards, which is exactly the kind of bug a
// screenshot doesn't catch.
import { parseInfoLine } from "../lib/engine";
import { formatEval, toWhiteRelative, whiteBarPct, type EvalScore } from "../lib/evalScore";

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
}

// --- info-line parsing ---
check(
  "parse cp line",
  parseInfoLine("info depth 12 seldepth 18 multipv 1 score cp 34 nodes 1 nps 1 pv e2e4 e7e5"),
  { cp: 34, mate: null, depth: 12, pv: ["e2e4", "e7e5"] },
);
check("parse mate line", parseInfoLine("info depth 9 multipv 1 score mate -3 pv h7h8"), {
  cp: null,
  mate: -3,
  depth: 9,
  pv: ["h7h8"],
});
check("ignore bound lines", parseInfoLine("info depth 5 score cp 120 upperbound pv e2e4"), null);
check("ignore currmove chatter", parseInfoLine("info depth 3 currmove e2e4 currmovenumber 1"), null);
check("ignore side PVs", parseInfoLine("info depth 8 multipv 2 score cp 10 pv d2d4"), null);
check("ignore non-info", parseInfoLine("bestmove e2e4 ponder e7e5"), null);

// --- perspective flip (UCI scores are side-to-move relative) ---
const white = (depth = 1) => ({ cp: 50, mate: null, depth, pv: [] });
check("white to move keeps sign", toWhiteRelative(white(), "white"), { cp: 50, mate: null, depth: 1 });
check("black to move flips sign", toWhiteRelative(white(), "black"), { cp: -50, mate: null, depth: 1 });
check("black mating is negative for white", toWhiteRelative({ cp: null, mate: 2, depth: 4, pv: [] }, "black"), {
  cp: null,
  mate: -2,
  depth: 4,
});
// `mate 0` = the side to move IS mated, so it must not sign-flip to zero.
check("mated white", toWhiteRelative({ cp: null, mate: 0, depth: 1, pv: [] }, "white"), {
  cp: null,
  mate: -1,
  depth: 1,
});
check("mated black", toWhiteRelative({ cp: null, mate: 0, depth: 1, pv: [] }, "black"), {
  cp: null,
  mate: 1,
  depth: 1,
});

// --- bar geometry ---
const s = (cp: number | null, mate: number | null = null): EvalScore => ({ cp, mate, depth: 20 });
check("level is centered", whiteBarPct(s(0)), 50);
check("no score is centered", whiteBarPct(null), 50);
check("white edge is above half", whiteBarPct(s(100)) > 50, true);
check("black edge is below half", whiteBarPct(s(-100)) < 50, true);
check("mirrored evals are mirrored bars", whiteBarPct(s(250)) + whiteBarPct(s(-250)), 100);
check("white mate fills the bar", whiteBarPct(s(null, 3)), 100);
check("black mate empties the bar", whiteBarPct(s(null, -3)), 0);
check("a crushing cp score still shows a sliver", whiteBarPct(s(9000)), 97);

// --- label ---
check("positive cp", formatEval(s(124)), "+1.2");
check("negative cp", formatEval(s(-30)), "-0.3");
check("level cp", formatEval(s(0)), "0.0");
check("big cp drops the decimal", formatEval(s(-1250)), "-13");
check("white mate", formatEval(s(null, 3)), "M3");
check("black mate", formatEval(s(null, -2)), "-M2");
check("no score prints nothing", formatEval(null), "");

process.exit(failed === 0 ? 0 : 1);
