// The homepage demo: a scripted game, played back on a real board.
//
// Everything here is canned. There is no engine, no server, no socket and no
// wasm — which is the whole point: the landing page has to tell its story on a
// cold mobile connection, and lib/engine.ts is a 7 MB download that lib/useEval
// deliberately refuses to start below a 720px viewport. A reel that reached for
// it would undo that.
//
// The moves are hardcoded as SAN and everything else is DERIVED by replaying
// them with chessops at module init. Hand-transcribing 34 FENs is the version of
// this that fails silently — a typo renders a plausible, wrong board — whereas a
// bad SAN literal throws on import, in dev, immediately.

import { Chess } from "chessops/chess";
import { INITIAL_FEN, makeFen } from "chessops/fen";
import { makeSanAndPlay, parseSan } from "chessops/san";
import type { NormalMove } from "chessops/types";

import type { EvalScore } from "./evalScore";
import { makeStandardUci } from "./uci";

/** 33 plies, ending in checkmate.
 *
 *  Chosen for how it READS at 320px rather than for its theory: the opening is
 *  ordinary enough that a non-player sees "a normal game", there are four
 *  sacrifices spaced two to three moves apart rather than one clever trick, and
 *  it finishes with a rook mate on an open file — legible on a phone in a way a
 *  smothered or minor-piece mate is not. */
export const DEMO_SAN = [
  "e4", "e5",
  "Nf3", "d6",
  "d4", "Bg4",
  "dxe5", "Bxf3",
  "Qxf3", "dxe5",
  "Bc4", "Nf6",
  "Qb3", "Qe7",
  "Nc3", "c6",
  "Bg5", "b5",
  "Nxb5", "cxb5",
  "Bxb5+", "Nbd7",
  "O-O-O", "Rd8",
  "Rxd7", "Rxd7",
  "Rd1", "Qe6",
  "Bxd7+", "Nxd7",
  "Qb8+", "Nxb8",
  "Rd8#",
] as const;

/** The plies that get room to land, keyed by frame index (1-based = ply).
 *
 *  These were captions once; the reel shows no move text now, so what survives
 *  is the PACING — `beatMs` holds each of these a second longer than a normal
 *  move, which is what makes four sacrifices read as four separate moments
 *  rather than a blur. The strings are kept because they say why each ply is on
 *  the list. */
export const DEMO_NOTES: Record<number, string> = {
  19: "Knight sacrifice",
  25: "Rook sacrifice",
  29: "Bishop sacrifice",
  31: "Queen sacrifice",
  33: "Checkmate",
};

/** Milliseconds each ply "took", index-aligned with DEMO_SAN. Illustrative, and
 *  shaped like a real blitz game: the book moves are instant, the sacrifices are
 *  long thinks. The REMAINING clocks are derived from these, so they cannot go
 *  non-monotonic or disagree with each other. */
const THINK_MS = [
  600, 500, 700, 600, 900, 1200, 1500, 900, 800, 1100,
  1400, 1600, 2100, 2400, 1800, 2600, 3100, 4200, 9400, 1100,
  1300, 3800, 2200, 3400, 6100, 1500, 4800, 5200, 3300, 1900,
  7600, 2100, 2800,
];

/** White-relative centipawns AFTER each ply; index 0 is the start position.
 *  Hand-set to track the story. This is an illustration of an evaluation, not
 *  the output of a search — see the permanent demo note in HomeDemo. */
const CP: (number | null)[] = [
  20, 30, 20, 30, 50, 60, 90, 110, 100, 110, 120,
  130, 150, 170, 200, 210, 230, 260, 420, 430, 450,
  470, 490, 620, 660, 700, 720, 900, 980, 1050, 1100,
  null, null, null,
];
/** The last three plies are a forced mate, where a centipawn score is the wrong
 *  shape entirely — EvalBar renders `mate` differently. */
const MATE: (number | null)[] = [...Array(31).fill(null), 2, 1, 1];
const DEPTH = 22;

/** 3+0, the shortest time control the lobby offers. */
const START_MS = 180_000;

/** The scripted coin result.
 *
 *  A const, never Math.random(): this renders on the server as well as the
 *  client, and a random landing would be a hydration mismatch on the one page
 *  every visitor sees first. */
export const DEMO_COIN: "white" | "black" = "white";

/** 5 USDC in base units (USDC has 6 decimals). Passed through the real
 *  profitForStake()/fmtUsdc() at the call site rather than being written out as
 *  "+4.95", so the figure moves if the fee ever does. */
export const DEMO_STAKE = 5_000_000n;

export type DemoFrame = {
  fen: string;
  /** [from, to] of the move that produced this position; null at ply 0. */
  lastMove: [string, string] | null;
  san: string | null;
  check: "white" | "black" | null;
  whiteMs: number;
  blackMs: number;
  score: EvalScore;
};

function build(): DemoFrame[] {
  const pos = Chess.default();
  let w = START_MS;
  let b = START_MS;
  const out: DemoFrame[] = [
    {
      fen: INITIAL_FEN,
      lastMove: null,
      san: null,
      check: null,
      whiteMs: w,
      blackMs: b,
      score: { cp: CP[0], mate: MATE[0], depth: DEPTH },
    },
  ];

  DEMO_SAN.forEach((san, i) => {
    const move = parseSan(pos, san);
    // Loud on purpose. A bad literal must never render a plausible wrong board.
    if (!move || !("from" in move)) {
      throw new Error(`demoReel: illegal SAN "${san}" at ply ${i + 1}`);
    }
    // Through makeStandardUci, so O-O-O comes out "e1c1" and not the
    // king-takes-rook "e1a1" chessops would otherwise write. Nothing here
    // reaches an engine, but the board highlight would point at the rook's
    // square instead of the king's — and this is the one file in the app that
    // writes castling by hand.
    const uci = makeStandardUci(pos, move as NormalMove);
    const canonical = makeSanAndPlay(pos, move);
    if (i % 2 === 0) w -= THINK_MS[i];
    else b -= THINK_MS[i];
    out.push({
      fen: makeFen(pos.toSetup()),
      lastMove: [uci.slice(0, 2), uci.slice(2, 4)],
      san: canonical,
      check: pos.isCheck() ? pos.turn : null,
      whiteMs: w,
      blackMs: b,
      score: { cp: CP[i + 1], mate: MATE[i + 1], depth: DEPTH },
    });
  });

  return out;
}

export const DEMO_FRAMES: DemoFrame[] = build();
export const DEMO_TOTAL = DEMO_FRAMES.length - 1;

// ---------------------------------------------------------------------------
// The phase machine. Pure and exported so scripts/demoReel.test.ts can drive it
// without a DOM — nothing in this suite renders a page.
// ---------------------------------------------------------------------------

export type DemoPhase = "coin" | "call" | "play" | "result" | "hold";
export type DemoState = { phase: DemoPhase; ply: number; loop: number };

export const DEMO_START: DemoState = { phase: "coin", ply: 0, loop: 0 };
/** Where reduced-motion jumps straight to: the finished game, no animation. */
export const DEMO_END: DemoState = { phase: "hold", ply: DEMO_TOTAL, loop: 0 };

const BEAT = {
  coin: 1800,
  call: 1000,
  /** Plies 1–12 are book: brisk, because nothing is happening yet. */
  open: 480,
  ply: 640,
  /** A ply with a caption gets room for the caption to land. */
  sac: 1500,
  mate: 1600,
  hold: 8000,
};
/** The reel runs forever: coin, game, result, coin again.
 *
 *  `hold` is still reachable, but only through `DEMO_END` — the reduced-motion
 *  path jumps straight to it, and a state machine that loops is exactly what
 *  reduced motion is asking us not to do. So `hold` is the still frame, and the
 *  live reel never enters it. */

/** How long to SIT in this state before advancing. */
export function beatMs(s: DemoState): number {
  switch (s.phase) {
    case "coin":
      return BEAT.coin;
    case "call":
      return BEAT.call;
    case "play":
      if (s.ply === DEMO_TOTAL) return BEAT.mate;
      if (DEMO_NOTES[s.ply]) return BEAT.sac;
      return s.ply <= 12 ? BEAT.open : BEAT.ply;
    case "result":
      return BEAT.hold;
    case "hold":
      return Infinity;
  }
}

/** The next state, or null once the reel is finished for good. */
export function nextBeat(s: DemoState): DemoState | null {
  switch (s.phase) {
    case "coin":
      return { ...s, phase: "call" };
    case "call":
      return { ...s, phase: "play", ply: 1 };
    case "play":
      return s.ply < DEMO_TOTAL
        ? { ...s, ply: s.ply + 1 }
        : { ...s, phase: "result" };
    case "result":
      return { phase: "coin", ply: 0, loop: s.loop + 1 };
    case "hold":
      return null;
  }
}
