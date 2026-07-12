// Verify lib/polyglot.ts against the reference keys from the Polyglot book
// format specification (book_format.html) — the canonical test vectors.
import { Chess } from "chessops/chess";
import { parseUci } from "chessops/util";

import { polyglotKey, parseBook, pickBookMove } from "../lib/polyglot";

function posAfter(moves: string[]): Chess {
  const pos = Chess.default();
  for (const u of moves) {
    const m = parseUci(u);
    if (!m || !pos.isLegal(m)) throw new Error(`illegal ${u}`);
    pos.play(m);
  }
  return pos;
}

const VECTORS: [string[], bigint][] = [
  [[], 0x463b96181691fc9cn],
  [["e2e4"], 0x823c9b50fd114196n],
  [["e2e4", "d7d5"], 0x0756b94461c50fb0n],
  [["e2e4", "d7d5", "e4e5"], 0x662fafb965db29d4n],
  [["e2e4", "d7d5", "e4e5", "f7f5"], 0x22a48b5a8e47ff78n], // en passant
  [["e2e4", "d7d5", "e4e5", "f7f5", "e1e2"], 0x652a607ca3f242c1n], // castling lost
  [["e2e4", "d7d5", "e4e5", "f7f5", "e1e2", "e8f7"], 0x00fdd303c946bdd9n],
  [["a2a4", "b7b5", "h2h4", "b5b4", "c2c4"], 0x3c8123ea7b067637n], // ep on c3
  [["a2a4", "b7b5", "h2h4", "b5b4", "c2c4", "b4c3", "a1a3"], 0x5c3f9b829b279560n],
];

let failed = 0;
for (const [moves, expected] of VECTORS) {
  const got = polyglotKey(posAfter(moves));
  const ok = got === expected;
  if (!ok) failed++;
  console.log(
    `${ok ? "ok " : "FAIL"} [${moves.join(" ") || "startpos"}] got 0x${got.toString(16)} want 0x${expected.toString(16)}`,
  );
}

// Probe test: a one-entry book mapping startpos -> a2a3 (weight 7).
const buf = new ArrayBuffer(16);
const view = new DataView(buf);
view.setBigUint64(0, 0x463b96181691fc9cn, false);
view.setUint16(8, (1 << 9) | (0 << 6) | (2 << 3) | 0, false); // a2a3
view.setUint16(10, 7, false);
const entries = parseBook(buf);
const pick = pickBookMove(entries, Chess.default());
console.log(pick === "a2a3" ? "ok  probe startpos -> a2a3" : `FAIL probe got ${pick}`);
if (pick !== "a2a3") failed++;

process.exit(failed === 0 ? 0 : 1);
