// A REAL MultiPV=4 info stream, captured from the vendored
// public/stockfish-18-lite-single.wasm — not hand-written.
//
// Everything the collector assumes about burst structure comes from reading
// Stockfish's source, so this fixture is what turns those assumptions into
// tested facts about the build we actually ship.
//
// Captured with:
//   const w = new Worker('/stockfish-18-lite-single.js');
//   w.postMessage('setoption name MultiPV value 4');
//   w.postMessage('setoption name UCI_ShowWDL value true');
//   w.postMessage('position startpos moves e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6');
//   w.postMessage('go movetime 3000');
//
// 19 bursts over 3s. Four of them are kept (first, middle, and the last two),
// with the principal variations trimmed to three moves — nothing under test
// looks past pv[0].
//
// Three properties this pins, all visible in the data below:
//
//  1. Lines arrive in BURSTS of all N indices, once per completed depth.
//  2. A move's multipv INDEX is not stable. `f1e2` is index 1 at depth 1,
//     `c1g5` is index 1 at depth 10, `c1e3` is index 1 at depth 18. Keying a
//     collection by index would merge different moves' scores; keying by
//     pv[0] is what makes it correct.
//  3. Stale lines are labelled exactly ONE ply back. In the final burst index 1
//     is depth 19 while indices 2-4 are depth 18 — Stockfish reprints
//     un-re-searched lines at `depth - 1` with their previous score, so
//     depth-inconsistency never has to be guessed at.

/** The Sicilian Najdorf after 1.e4 c5 2.Nf3 d6 3.d4 cxd4 4.Nxd4 Nf6 5.Nc3 a6. */
export const FIXTURE_POSITION =
  "e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6".split(" ");

/** The engine's final answer for the stream below. */
export const FIXTURE_BESTMOVE = "c1e3";

export const MULTIPV_STREAM: string[] = [
  // --- depth 1: index 1 is f1e2 ---
  "info depth 1 seldepth 2 multipv 1 score cp 26 wdl 47 947 6 nodes 195 nps 19500 hashfull 0 time 10 pv f1e2",
  "info depth 1 seldepth 2 multipv 2 score cp 26 wdl 46 948 6 nodes 195 nps 19500 hashfull 0 time 10 pv c1e3",
  "info depth 1 seldepth 2 multipv 3 score cp 23 wdl 42 951 7 nodes 195 nps 17727 hashfull 0 time 11 pv f1d3",
  "info depth 1 seldepth 2 multipv 4 score cp 20 wdl 37 955 8 nodes 195 nps 17727 hashfull 0 time 11 pv f2f4",
  // --- depth 10: index 1 is now c1g5, and f1e2 has dropped out entirely ---
  "info depth 10 seldepth 16 multipv 1 score cp 58 wdl 156 842 2 nodes 79479 nps 764221 hashfull 23 time 104 pv c1g5 e7e6 f2f4",
  "info depth 10 seldepth 16 multipv 2 score cp 38 wdl 75 921 4 nodes 79479 nps 764221 hashfull 23 time 104 pv g2g3 g7g6 c1e3",
  "info depth 10 seldepth 15 multipv 3 score cp 38 wdl 75 921 4 nodes 79479 nps 764221 hashfull 23 time 104 pv f2f4 e7e5 d4f3",
  "info depth 10 seldepth 15 multipv 4 score cp 35 wdl 66 930 4 nodes 79479 nps 764221 hashfull 23 time 104 pv d1d3 e7e5 d4f5",
  // --- depth 18: a complete burst, index 1 is c1e3 ---
  "info depth 18 seldepth 31 multipv 1 score cp 44 wdl 93 904 3 nodes 2812185 nps 1019646 hashfull 808 time 2758 pv c1e3 e7e5 d4b3",
  "info depth 18 seldepth 35 multipv 2 score cp 43 wdl 89 908 3 nodes 2812185 nps 1019646 hashfull 808 time 2758 pv f1e2 e7e6 c1e3",
  "info depth 18 seldepth 32 multipv 3 score cp 40 wdl 81 916 3 nodes 2812185 nps 1019276 hashfull 808 time 2759 pv f2f3 e7e5 d4b3",
  "info depth 18 seldepth 39 multipv 4 score cp 32 wdl 58 937 5 nodes 2812185 nps 1019276 hashfull 808 time 2759 pv d4b3 g7g6 c1e3",
  // --- final burst: index 1 reached depth 19, the rest are reprinted at 18 ---
  "info depth 19 seldepth 34 multipv 1 score cp 45 wdl 98 899 3 nodes 3051476 nps 1017158 hashfull 838 time 3000 pv c1e3 e7e5 d4b3",
  "info depth 18 seldepth 35 multipv 2 score cp 43 wdl 89 908 3 nodes 3051476 nps 1017158 hashfull 838 time 3000 pv f1e2 e7e6 c1e3",
  "info depth 18 seldepth 32 multipv 3 score cp 40 wdl 81 916 3 nodes 3051476 nps 1017158 hashfull 838 time 3000 pv f2f3 e7e5 d4b3",
  "info depth 18 seldepth 39 multipv 4 score cp 32 wdl 58 937 5 nodes 3051476 nps 1017158 hashfull 838 time 3000 pv d4b3 g7g6 c1e3",
];
