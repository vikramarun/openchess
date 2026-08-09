// Verify the MultiPV candidate collector — the substrate the playing-style
// dials will sit on.
//
// The heart of this file is a REAL captured info stream (scripts/fixtures),
// because every rule the collector implements was derived from reading
// Stockfish's source rather than from measuring the wasm build we ship.
import {
  acceptableMoves,
  sortableScore,
  CandidateCollector,
  MATE_SCORE,
  type Harvest,
} from "../lib/candidates";
import { parseInfoLine, parseUciInfo } from "../lib/engine";
import { FIXTURE_BESTMOVE, MULTIPV_STREAM } from "./fixtures/multipv";

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
}

// --- parseUciInfo ----------------------------------------------------------
{
  const i = parseUciInfo(MULTIPV_STREAM[13])!;
  check("multipv index is read", i.multipv, 2);
  check("depth is read", i.depth, 18);
  check("cp is read", i.cp, 43);
  check("wdl is read", i.wdl, [89, 908, 3]);
  check("pv[0] is the move", i.pv[0], "f1e2");

  check("an absent multipv defaults to 1", parseUciInfo("info depth 5 score cp 10 pv e2e4")!.multipv, 1);
  check("lowerbound is flagged, not dropped", parseUciInfo("info depth 5 score cp 120 lowerbound pv e2e4")!.bound, "lower");
  check("upperbound is flagged", parseUciInfo("info depth 5 score cp 120 upperbound pv e2e4")!.bound, "upper");
  check("mate is read", parseUciInfo("info depth 9 multipv 1 score mate -3 pv h7h8")!.mate, -3);
  check("chatter with no score is null", parseUciInfo("info depth 3 currmove e2e4 currmovenumber 1"), null);
  check("a bestmove line is null", parseUciInfo("bestmove e2e4 ponder e7e5"), null);
  check("wdl absent leaves null", parseUciInfo("info depth 5 score cp 10 pv e2e4")!.wdl, null);

  // parseInfoLine is now a filter over the above. Its contract is pinned by
  // scripts/eval.test.ts; re-assert the two rejections here so a change to the
  // shared tokenizer is caught in whichever suite runs first.
  check("the eval bar still rejects side PVs", parseInfoLine(MULTIPV_STREAM[13]), null);
  check("the eval bar still rejects bounds", parseInfoLine("info depth 5 score cp 120 upperbound pv e2e4"), null);
  check(
    "a wdl-carrying multipv-1 line keeps the old 4-key shape",
    parseInfoLine(MULTIPV_STREAM[12]),
    { cp: 45, mate: null, depth: 19, pv: ["c1e3", "e7e5", "d4b3"] },
  );
}

// --- sortableScore ---------------------------------------------------------
{
  const s = (cp: number | null, mate: number | null) => sortableScore({ cp, mate });
  check("a faster mate outranks a slower one", s(null, 1) > s(null, 5), true);
  check("any mate outranks any cp score", s(null, 5) > s(900, null), true);
  check("being mated slowly beats being mated fast", s(null, -5) > s(null, -1), true);
  check("being mated is worse than any cp score", s(-900, null) > s(null, -5), true);
  check("mate 0 is the floor", s(null, 0), -MATE_SCORE);
  check("a missing score is level", s(null, null), 0);
}

// --- the collector, against the real stream --------------------------------
{
  const c = new CandidateCollector();
  MULTIPV_STREAM.forEach((l) => c.feed(l));
  const h = c.harvest(FIXTURE_BESTMOVE);

  check("the deepest completed ply is found", h.maxDepth, 19);
  check("the engine's own answer is present, so the harvest is trusted", h.trusted, true);
  check("the four live candidates survive", h.candidates.map((x) => x.uci), ["c1e3", "f1e2", "f2f3", "d4b3"]);
  check("they are ordered best first", h.candidates.map((x) => x.cp), [45, 43, 40, 32]);
  check("the best candidate is the engine's bestmove", h.candidates[0].uci, FIXTURE_BESTMOVE);
  check("wdl rides along for draw-aversion", h.candidates[0].wdl, [98, 899, 3]);

  // The freshness rule: depth 19 and depth 18 are live, depth 10 and 1 are not.
  check("stale depths are dropped", h.candidates.every((x) => x.depth >= 18), true);
  // c1g5 led at depth 10 and never reappeared; it must not be offered.
  check("a move abandoned by the search is gone", h.candidates.some((x) => x.uci === "c1g5"), false);
  // f1e2 led at depth 1 but is only 2nd at depth 18 — keyed by MOVE it keeps
  // its own latest score rather than inheriting whatever is at index 1.
  check("a move that changed rank keeps its own score", h.candidates.find((x) => x.uci === "f1e2")!.cp, 43);
  check("…at its own depth", h.candidates.find((x) => x.uci === "f1e2")!.depth, 18);
}

// --- collector edge cases --------------------------------------------------
{
  const c = new CandidateCollector();
  c.feed("info depth 5 multipv 1 score cp 10 lowerbound pv e2e4");
  check("bound lines never enter the collection", c.harvest("e2e4").candidates.length, 0);

  const d = new CandidateCollector();
  d.feed("info depth 5 multipv 1 score cp 10 pv e2e4");
  d.feed("info depth 4 multipv 1 score cp 99 pv e2e4"); // a late, shallower report
  check("depth never regresses", d.harvest("e2e4").candidates[0].cp, 10);
  d.feed("info depth 5 multipv 1 score cp 22 pv e2e4"); // same depth, refreshed
  check("an equal-depth re-report refreshes the score", d.harvest("e2e4").candidates[0].cp, 22);

  const e = new CandidateCollector();
  e.feed("info depth 5 multipv 1 score cp 10 pv e2e4");
  check("an unknown bestmove makes the harvest untrusted", e.harvest("h2h4").trusted, false);
  check("an empty collection is untrusted", new CandidateCollector().harvest("e2e4").trusted, false);
  check("lines with no pv are ignored", (() => { const f = new CandidateCollector(); f.feed("info depth 5 score cp 10"); return f.harvest("e2e4").candidates.length; })(), 0);
}

// --- the style window ------------------------------------------------------
{
  const c = new CandidateCollector();
  MULTIPV_STREAM.forEach((l) => c.feed(l));
  const h = c.harvest(FIXTURE_BESTMOVE);
  const OPTS = { epsilonCp: 15, minDepth: 6, disableBeyondCp: 400 };

  // Real numbers from the fixture: 45 / 43 / 40 / 32, so the losses from best
  // are 0 / 2 / 5 / 13. The window is inclusive at its edge.
  check("a 15cp window admits all four", acceptableMoves(h, OPTS).map((x) => x.uci), ["c1e3", "f1e2", "f2f3", "d4b3"]);
  check("13cp is exactly the edge, and includes it", acceptableMoves(h, { ...OPTS, epsilonCp: 13 }).length, 4);
  check("12cp drops the widest move", acceptableMoves(h, { ...OPTS, epsilonCp: 12 }).map((x) => x.uci), ["c1e3", "f1e2", "f2f3"]);
  check("a 3cp window keeps only the top two", acceptableMoves(h, { ...OPTS, epsilonCp: 3 }).map((x) => x.uci), ["c1e3", "f1e2"]);
  check("a 1cp window keeps only the best move", acceptableMoves(h, { ...OPTS, epsilonCp: 1 }).map((x) => x.uci), ["c1e3"]);

  // Every case below means "defer to bestmove", which is what an empty pool
  // signals to the caller.
  check("epsilon 0 is full strength — no styling at all", acceptableMoves(h, { ...OPTS, epsilonCp: 0 }), []);
  check("a shallow search is not styled", acceptableMoves(h, { ...OPTS, minDepth: 30 }), []);
  check("an untrusted harvest is not styled", acceptableMoves({ ...h, trusted: false }, OPTS), []);
  check("a single candidate leaves nothing to choose", acceptableMoves({ ...h, candidates: h.candidates.slice(0, 1) }, OPTS), []);

  // A decided game has nothing to express.
  const won: Harvest = { ...h, candidates: h.candidates.map((x) => ({ ...x, cp: (x.cp ?? 0) + 900 })) };
  check("a won position is not styled", acceptableMoves(won, OPTS), []);

  // Mate handling — the rule that keeps style from ever costing a game.
  const mating: Harvest = {
    maxDepth: 20,
    trusted: true,
    candidates: [
      { uci: "h5f7", cp: null, mate: 2, depth: 20, pv: ["h5f7"], wdl: null },
      { uci: "d1h5", cp: 900, mate: null, depth: 20, pv: ["d1h5"], wdl: null },
    ],
  };
  check("a forced mate is never traded for style", acceptableMoves(mating, { ...OPTS, epsilonCp: 60 }), []);
  const mated: Harvest = {
    maxDepth: 20,
    trusted: true,
    candidates: [
      { uci: "a1a2", cp: -50, mate: null, depth: 20, pv: ["a1a2"], wdl: null },
      { uci: "a1b1", cp: null, mate: -1, depth: 20, pv: ["a1b1"], wdl: null },
    ],
  };
  check("a losing-mate move is never in the pool", acceptableMoves(mated, OPTS).map((x) => x.uci), ["a1a2"]);
}

process.exit(failed === 0 ? 0 : 1);
