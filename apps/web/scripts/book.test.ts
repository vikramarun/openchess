// The shipped opening book (public/book.json) is fed STRAIGHT to a UCI engine —
// `position startpos moves <book line>` — and to the server as our move. So the
// only notation it may use is standard UCI.
//
// This is not a style rule. Stockfish's `position` parser stops at the first
// move it cannot read and keeps the prefix, WITHOUT saying anything: one
// king-takes-rook castle ("e8h8", which is what chessops' makeUci writes, and
// what Polyglot books store) leaves the engine a ply behind with the wrong side
// to move for the rest of the game. Every bestmove after that is illegal in the
// real position, the server rejects it, and the seat resigns in a level
// position. That shipped once — 553 of 1817 lines carried it.
export {};

import { readFileSync } from "node:fs";

import { Chess } from "chessops/chess";
import { parseUci } from "chessops/util";

import { makeStandardUci, replayHistory } from "../lib/uci";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

const lines: string[] = JSON.parse(readFileSync("public/book.json", "utf8"));

check("book.json is non-empty", lines.length > 0, `${lines.length} lines`);

// Every line must replay legally, and must already BE what the replay produces:
// replayHistory() rewrites castling to standard UCI, so line !== rewrite means
// the file still holds a king-takes-rook move.
const illegal: string[] = [];
const nonStandard: string[] = [];
for (const line of lines) {
  const moves = line.split(" ");
  const replay = replayHistory(moves);
  if (!replay) {
    illegal.push(line);
    continue;
  }
  if (replay.history.join(" ") !== line) nonStandard.push(line);
}
check("every book line is legal from the start position", illegal.length === 0, illegal[0]);
check(
  "no book line uses king-takes-rook castling (it desyncs the engine)",
  nonStandard.length === 0,
  `${nonStandard.length} line(s), e.g. ${nonStandard[0]}`,
);

// A blunt textual scan too: the check above only catches what a replay
// normalizes, and this states the forbidden squares outright.
const banned = /\b(e1h1|e1a1|e8h8|e8a8)\b/;
check(
  "no book line mentions e1h1/e1a1/e8h8/e8a8",
  !lines.some((l) => banned.test(l)),
  lines.find((l) => banned.test(l)),
);

// --- the converter itself ----------------------------------------------------
{
  // Ruy Lopez to White's castle: both notations mean O-O and must serialize to
  // the king's two-square form.
  const pos = Chess.default();
  for (const u of "e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6".split(" ")) pos.play(parseUci(u)!);
  check("king-takes-rook castling normalizes", makeStandardUci(pos, parseUci("e1h1")!) === "e1g1");
  check("standard castling stays put", makeStandardUci(pos, parseUci("e1g1")!) === "e1g1");
}
{
  // A rook that genuinely moves e1->h1 must NOT be mistaken for a castle.
  const pos = Chess.default();
  for (const u of "e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 e1g1 g8f6 f1e1 e8g8".split(" "))
    pos.play(parseUci(u)!);
  check("a real rook move e1h1 is left alone", makeStandardUci(pos, parseUci("e1h1")!) === "e1h1");
}
{
  // Promotion suffixes survive the round trip.
  const pos = Chess.default();
  for (const u of "a2a4 b7b5 a4b5 a7a6 b5a6 g8f6 a6b7 f6g8".split(" ")) pos.play(parseUci(u)!);
  check("promotions keep their suffix", makeStandardUci(pos, parseUci("b7a8q")!) === "b7a8q");
  check("underpromotion to a knight is 'n'", makeStandardUci(pos, parseUci("b7a8n")!) === "b7a8n");
}

console.log(failed === 0 ? "\nall checks passed" : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
