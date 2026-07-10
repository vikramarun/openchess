// Precompute apps/web/public/book.json — a compact UCI opening book sampled from
// official-stockfish/books (8moves_v3.pgn). Regenerate:
//   1. curl -sL -o /tmp/b.zip https://github.com/official-stockfish/books/raw/master/8moves_v3.pgn.zip
//   2. unzip -o /tmp/b.zip -d /tmp
//   3. PGN=/tmp/8moves_v3.pgn node scripts/build-book.mjs
// Source is Stockfish-vs-Stockfish balanced 8-move opening lines (GPL data).
import { readFileSync, writeFileSync } from "node:fs";
import { Chess } from "chessops/chess";
import { parseSan } from "chessops/san";
import { makeUci } from "chessops/util";

const PGN = process.env.PGN || "/tmp/8moves_v3.pgn";
const MAX_PLIES = 12, SAMPLE_EVERY = 18, MAX_LINES = 2200;

const games = readFileSync(PGN, "utf8").split(/\n\s*\n(?=\[Event)/);
const out = new Set();
let gi = -1;
for (const g of games) {
  if (++gi % SAMPLE_EVERY !== 0 || out.size >= MAX_LINES) continue;
  const mt = g.split("\n").filter((l) => l && !l.startsWith("[")).join(" ");
  const sans = mt
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\d+\.(\.\.)?/g, " ")
    .replace(/(1-0|0-1|1\/2-1\/2|\*)/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const pos = Chess.default();
  const uci = [];
  for (const san of sans) {
    if (uci.length >= MAX_PLIES) break;
    const mv = parseSan(pos, san);
    if (!mv) break;
    uci.push(makeUci(mv));
    pos.play(mv);
  }
  if (uci.length >= 6) out.add(uci.join(" "));
}
writeFileSync("public/book.json", JSON.stringify([...out]));
console.log(`wrote public/book.json: ${out.size} lines`);
