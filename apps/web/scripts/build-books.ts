// Compose the built-in repertoire books in apps/web/public/books/*.bin from
// public-domain PGN. Regenerate:
//
//   curl -sL -o /tmp/b.zip https://github.com/official-stockfish/books/raw/master/8moves_v3.pgn.zip
//   curl -sL -o /tmp/u.zip "https://github.com/official-stockfish/books/raw/master/UHO_XXL_%2B1.00_%2B1.29.pgn.zip"
//   unzip -o /tmp/b.zip -d /tmp && unzip -o /tmp/u.zip -d /tmp
//   pnpm -C apps/web build:books
//
// Sources, both from official-stockfish/books, CC0-1.0 (public domain):
//   * 8moves_v3.pgn                 34.7k BALANCED 8-move lines — the default.
//   * UHO_XXL_+1.00_+1.29.pgn      186k UNBALANCED lines — gambits only.
//
// Why two. 8moves_v3 is filtered for engine-testing *balance*, and a gambit is
// unbalanced by definition, so it contains almost none: Smith-Morra 5 lines,
// Latvian 3, Blackmar-Diemer 0. UHO is selected for the opposite property and
// has 673 / 209 / 135. But UHO lines are deliberately lopsided by ply 16, so
// gambit books are capped at GAMBIT_MAX_PLY — long enough to reach the gambit,
// short enough that we hand off to the engine before UHO's skew matters.
//
// Books are organized by STYLE × SLOT, not by first move. "Sharp" is not one
// defense — it is a weighted mix of the Open Sicilian, the King's Gambit, the
// Scotch, the Advance variations. Corpus frequency alone would wreck those
// mixes (Réti outnumbers Larsen 23:1, so a "hypermodern" bot would just play
// 1.Nf3 forever), so each opening gets a DESIGNED share and its weights are
// rescaled to hit it. `pnpm build:books` prints the realized shares so the
// design can be checked against reality rather than assumed.
//
// This is a .ts script (run through tsx, like the test suites) specifically so
// it can import `polyglotKey`/`encodeMove` from lib/. Those are pinned to the
// Polyglot spec vectors by `pnpm test:book`, and a second hand-rolled Zobrist
// implementation here would be free to drift from the one probing at runtime.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

import { Chess } from "chessops/chess";
import { parseSan } from "chessops/san";
import { makeUci, parseUci } from "chessops/util";

import { polyglotKey, type BookEntry } from "../lib/polyglot";
import { encodeMove, mergeEntries, writeBook } from "../lib/polyglotWrite";

const BALANCED_PGN = process.env.PGN || "/tmp/8moves_v3.pgn";
const UHO_PGN = process.env.UHO_PGN || "/tmp/UHO_XXL_+1.00_+1.29.pgn";
const OUT_DIR = "public/books";

const MAX_PLY = 16;
/** Gambit books stop earlier — see the note above on UHO's deliberate skew. */
const GAMBIT_MAX_PLY = 10;
/** Post-rescale weight of the average opening, keeping entries well inside u16. */
const SCALE = 4000;
/** Prune deep rare lines: most of the bytes, least of the identity. */
const MIN_WEIGHT = 2;
const RARE_AFTER_PLY = 8;
/** Coverage tails only need to bridge the opening, not define it. */
const COVER_MAX_PLY = 10;

type Slot = "white" | "vsE4" | "vsD4" | "vsOther";
type Source = "balanced" | "uho";

/** A named opening, identified by the UCI prefix every one of its games shares. */
type Opening = { id: string; prefix: string[] };
const O = (id: string, moves: string): Opening => ({ id, prefix: moves.split(" ") });

const OPENINGS: Opening[] = [
  // --- White, 1.e4 ---
  O("open-sicilian-d6", "e2e4 c7c5 g1f3 d7d6 d2d4"),
  O("open-sicilian-nc6", "e2e4 c7c5 g1f3 b8c6 d2d4"),
  O("open-sicilian-e6", "e2e4 c7c5 g1f3 e7e6 d2d4"),
  O("rossolimo", "e2e4 c7c5 g1f3 b8c6 f1b5"),
  O("moscow", "e2e4 c7c5 g1f3 d7d6 f1b5"),
  O("alapin", "e2e4 c7c5 c2c3"),
  O("closed-sicilian", "e2e4 c7c5 b1c3"),
  O("ruy-lopez", "e2e4 e7e5 g1f3 b8c6 f1b5"),
  O("italian", "e2e4 e7e5 g1f3 b8c6 f1c4"),
  O("scotch", "e2e4 e7e5 g1f3 b8c6 d2d4"),
  O("four-knights", "e2e4 e7e5 g1f3 b8c6 b1c3"),
  O("vienna", "e2e4 e7e5 b1c3"),
  O("bishops-opening", "e2e4 e7e5 f1c4"),
  O("french-advance", "e2e4 e7e6 d2d4 d7d5 e4e5"),
  O("french-tarrasch", "e2e4 e7e6 d2d4 d7d5 b1d2"),
  O("french-nc3", "e2e4 e7e6 d2d4 d7d5 b1c3"),
  O("french-exchange", "e2e4 e7e6 d2d4 d7d5 e4d5"),
  O("caro-advance", "e2e4 c7c6 d2d4 d7d5 e4e5"),
  O("caro-panov", "e2e4 c7c6 d2d4 d7d5 e4d5 c6d5 c2c4"),
  O("caro-nc3", "e2e4 c7c6 d2d4 d7d5 b1c3"),
  O("caro-fantasy", "e2e4 c7c6 d2d4 d7d5 f2f3"),
  // --- White, 1.d4 and flank ---
  O("queens-gambit", "d2d4 d7d5 c2c4"),
  O("indian-c4", "d2d4 g8f6 c2c4"),
  O("catalan", "d2d4 g8f6 c2c4 e7e6 g2g3"),
  O("london-nf6", "d2d4 g8f6 c1f4"),
  O("london-d5", "d2d4 d7d5 c1f4"),
  O("trompowsky", "d2d4 g8f6 c1g5"),
  O("english", "c2c4"),
  O("reti", "g1f3"),
  O("kings-fianchetto", "g2g3"),
  O("bird", "f2f4"),
  O("larsen", "b2b3"),
  O("van-geet", "b1c3"),
  O("sokolsky", "b2b4"),
  // --- White gambits ---
  O("kings-gambit", "e2e4 e7e5 f2f4"),
  O("evans-gambit", "e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 b2b4"),
  O("danish", "e2e4 e7e5 d2d4 e5d4 c2c3"),
  O("goring", "e2e4 e7e5 g1f3 b8c6 d2d4 e5d4 c2c3"),
  O("scotch-gambit", "e2e4 e7e5 g1f3 b8c6 d2d4 e5d4 f1c4"),
  O("smith-morra", "e2e4 c7c5 d2d4 c5d4 c2c3"),
  O("wing-gambit", "e2e4 c7c5 b2b4"),
  O("blackmar-diemer", "d2d4 d7d5 e2e4"),
  O("vienna-gambit", "e2e4 e7e5 b1c3 g8f6 f2f4"),
  O("center-game", "e2e4 e7e5 d2d4"),
  // --- Black vs 1.e4 ---
  O("sicilian", "e2e4 c7c5"),
  O("open-games", "e2e4 e7e5"),
  O("petroff", "e2e4 e7e5 g1f3 g8f6"),
  O("french", "e2e4 e7e6"),
  O("french-winawer", "e2e4 e7e6 d2d4 d7d5 b1c3 f8b4"),
  O("french-classical", "e2e4 e7e6 d2d4 d7d5 b1c3 g8f6"),
  O("caro-kann", "e2e4 c7c6"),
  O("pirc", "e2e4 d7d6"),
  O("modern", "e2e4 g7g6"),
  O("alekhine", "e2e4 g8f6"),
  O("scandinavian", "e2e4 d7d5"),
  O("nimzowitsch", "e2e4 b8c6"),
  // --- Black gambits vs 1.e4 ---
  O("latvian", "e2e4 e7e5 g1f3 f7f5"),
  O("elephant", "e2e4 e7e5 g1f3 d7d5"),
  O("icelandic", "e2e4 d7d5 e4d5 g8f6"),
  O("traxler", "e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 f3g5"),
  // --- Black vs 1.d4 ---
  O("nimzo-indian", "d2d4 g8f6 c2c4 e7e6 b1c3 f8b4"),
  O("queens-indian", "d2d4 g8f6 c2c4 e7e6 g1f3 b7b6"),
  O("d4-e6", "d2d4 g8f6 c2c4 e7e6"),
  O("kings-indian", "d2d4 g8f6 c2c4 g7g6 b1c3 f8g7"),
  O("grunfeld", "d2d4 g8f6 c2c4 g7g6 b1c3 d7d5"),
  O("d4-g6", "d2d4 g8f6 c2c4 g7g6"),
  O("benoni", "d2d4 g8f6 c2c4 c7c5"),
  O("benko", "d2d4 g8f6 c2c4 c7c5 d4d5 b7b5"),
  O("qgd", "d2d4 d7d5 c2c4 e7e6"),
  O("slav", "d2d4 d7d5 c2c4 c7c6"),
  O("qga", "d2d4 d7d5 c2c4 d5c4"),
  O("dutch", "d2d4 f7f5"),
  O("budapest", "d2d4 g8f6 c2c4 e7e5"),
  O("albin", "d2d4 d7d5 c2c4 e7e5"),
  O("blumenfeld", "d2d4 g8f6 c2c4 e7e6 g1f3 c7c5 d4d5 b7b5"),
  // --- Black vs flank ---
  O("flank-e5", "c2c4 e7e5"),
  O("flank-c5", "c2c4 c7c5"),
  O("flank-nf6-c4", "c2c4 g8f6"),
  O("flank-d5-nf3", "g1f3 d7d5"),
  O("flank-nf6-nf3", "g1f3 g8f6"),
  // --- broad coverage tails (every game after a given first move) ---
  // A style mix only names the defenses it has an opinion about, so on its own
  // a White book leaves book the moment Black plays something else (1.e4 d5 and
  // a "Sharp" bot is calculating from move two). These add a thin mainline
  // continuation against EVERY reply. Weighted low, so they extend coverage
  // without diluting the style at the branches the style actually cares about.
  O("any-e4", "e2e4"),
  O("any-d4", "d2d4"),
];

const BY_ID = new Map(OPENINGS.map((o) => [o.id, o]));

/** One shipped book: a weighted mix of openings, for one style in one slot. */
type BookDef = {
  id: string;
  label: string;
  slot: Slot;
  style: string;
  source: Source;
  maxPly?: number;
  /** [openingId, designed share]. Shares are relative, not required to sum. */
  mix: [string, number][];
};

const BOOKS: BookDef[] = [
  // ============================ WHITE ============================
  {
    id: "w-classical", label: "Classical — main lines", slot: "white", style: "classical", source: "balanced",
    mix: [["ruy-lopez", 25], ["italian", 15], ["queens-gambit", 25], ["indian-c4", 25], ["four-knights", 5], ["scotch", 5],
          ["any-e4", 12], ["any-d4", 12]],
  },
  {
    id: "w-sharp", label: "Sharp — open lines, initiative", slot: "white", style: "sharp", source: "balanced",
    mix: [["open-sicilian-d6", 12], ["open-sicilian-nc6", 12], ["open-sicilian-e6", 11], ["kings-gambit", 14],
          ["scotch", 10], ["vienna", 8], ["bishops-opening", 5], ["caro-advance", 10], ["french-advance", 8],
          ["caro-panov", 6], ["caro-fantasy", 4], ["any-e4", 14]],
  },
  {
    id: "w-solid", label: "Solid — structure first", slot: "white", style: "solid", source: "balanced",
    mix: [["rossolimo", 14], ["moscow", 8], ["alapin", 14], ["french-tarrasch", 14], ["catalan", 14],
          ["london-d5", 12], ["london-nf6", 10], ["caro-nc3", 9], ["french-exchange", 5],
          ["any-e4", 10], ["any-d4", 10]],
  },
  {
    id: "w-hypermodern", label: "Hypermodern — flank pressure", slot: "white", style: "hypermodern", source: "balanced",
    mix: [["english", 28], ["reti", 28], ["kings-fianchetto", 16], ["trompowsky", 16], ["larsen", 7], ["bird", 5]],
  },
  {
    id: "w-gambit", label: "Gambiteer — pawns for time", slot: "white", style: "gambit", source: "uho", maxPly: GAMBIT_MAX_PLY,
    mix: [["kings-gambit", 26], ["smith-morra", 16], ["danish", 10], ["evans-gambit", 10], ["scotch-gambit", 10],
          ["goring", 8], ["blackmar-diemer", 8], ["vienna-gambit", 7], ["wing-gambit", 5],
          ["any-e4", 12], ["any-d4", 6]],
  },
  {
    id: "w-offbeat", label: "Offbeat — off the map", slot: "white", style: "offbeat", source: "balanced",
    mix: [["bird", 20], ["larsen", 20], ["kings-fianchetto", 18], ["trompowsky", 18], ["van-geet", 14], ["sokolsky", 10]],
  },

  // ========================= BLACK vs 1.e4 =========================
  {
    id: "b-e4-classical", label: "Classical — 1…e5", slot: "vsE4", style: "classical", source: "balanced",
    mix: [["open-games", 70], ["french-classical", 30]],
  },
  {
    id: "b-e4-sharp", label: "Sharp — Sicilian & Winawer", slot: "vsE4", style: "sharp", source: "balanced",
    mix: [["sicilian", 55], ["french-winawer", 20], ["alekhine", 15], ["modern", 10]],
  },
  {
    id: "b-e4-solid", label: "Solid — Caro-Kann & Petroff", slot: "vsE4", style: "solid", source: "balanced",
    mix: [["caro-kann", 45], ["petroff", 30], ["french", 25]],
  },
  {
    id: "b-e4-hypermodern", label: "Hypermodern — Pirc & Modern", slot: "vsE4", style: "hypermodern", source: "balanced",
    mix: [["pirc", 35], ["modern", 30], ["alekhine", 35]],
  },
  {
    id: "b-e4-gambit", label: "Gambiteer — counter-gambits", slot: "vsE4", style: "gambit", source: "uho", maxPly: GAMBIT_MAX_PLY,
    mix: [["icelandic", 30], ["latvian", 25], ["elephant", 22], ["traxler", 23]],
  },
  {
    id: "b-e4-offbeat", label: "Offbeat — Scandi & friends", slot: "vsE4", style: "offbeat", source: "balanced",
    mix: [["scandinavian", 32], ["alekhine", 26], ["modern", 22], ["nimzowitsch", 20]],
  },

  // ========================= BLACK vs 1.d4 =========================
  {
    id: "b-d4-classical", label: "Classical — QGD & Nimzo", slot: "vsD4", style: "classical", source: "balanced",
    mix: [["qgd", 38], ["nimzo-indian", 40], ["slav", 22]],
  },
  {
    id: "b-d4-sharp", label: "Sharp — KID, Grünfeld, Dutch", slot: "vsD4", style: "sharp", source: "balanced",
    mix: [["kings-indian", 32], ["grunfeld", 24], ["dutch", 22], ["benoni", 22]],
  },
  {
    id: "b-d4-solid", label: "Solid — Slav & Queen's Indian", slot: "vsD4", style: "solid", source: "balanced",
    mix: [["slav", 40], ["qgd", 30], ["queens-indian", 30]],
  },
  {
    id: "b-d4-hypermodern", label: "Hypermodern — Indian defenses", slot: "vsD4", style: "hypermodern", source: "balanced",
    mix: [["nimzo-indian", 28], ["queens-indian", 24], ["kings-indian", 26], ["grunfeld", 22]],
  },
  {
    id: "b-d4-gambit", label: "Gambiteer — Budapest & Benko", slot: "vsD4", style: "gambit", source: "uho", maxPly: GAMBIT_MAX_PLY,
    mix: [["budapest", 30], ["benko", 26], ["albin", 26], ["blumenfeld", 18]],
  },
  {
    id: "b-d4-offbeat", label: "Offbeat — Dutch & QGA", slot: "vsD4", style: "offbeat", source: "balanced",
    mix: [["dutch", 34], ["qga", 26], ["benoni", 24], ["d4-g6", 16]],
  },

  // ======================== BLACK vs flank ========================
  {
    id: "b-other-classical", label: "Classical — …e5 & …Nf6", slot: "vsOther", style: "classical", source: "balanced",
    mix: [["flank-e5", 50], ["flank-nf6-c4", 30], ["flank-d5-nf3", 20]],
  },
  {
    id: "b-other-sharp", label: "Sharp — Reversed Sicilian", slot: "vsOther", style: "sharp", source: "balanced",
    mix: [["flank-e5", 60], ["flank-nf6-nf3", 40]],
  },
  {
    id: "b-other-solid", label: "Solid — …d5 & Symmetrical", slot: "vsOther", style: "solid", source: "balanced",
    mix: [["flank-d5-nf3", 55], ["flank-c5", 45]],
  },
  {
    id: "b-other-hypermodern", label: "Hypermodern — …Nf6", slot: "vsOther", style: "hypermodern", source: "balanced",
    mix: [["flank-nf6-nf3", 55], ["flank-nf6-c4", 45]],
  },
  {
    // Gambits barely exist against 1.c4/1.Nf3 — the honest answer is the
    // sharpest mainstream reply rather than a manufactured one.
    id: "b-other-gambit", label: "Gambiteer — sharpest reply", slot: "vsOther", style: "gambit", source: "balanced",
    mix: [["flank-e5", 65], ["flank-c5", 35]],
  },
  {
    id: "b-other-offbeat", label: "Offbeat — Symmetrical & …d5", slot: "vsOther", style: "offbeat", source: "balanced",
    mix: [["flank-c5", 40], ["flank-d5-nf3", 30], ["flank-nf6-nf3", 30]],
  },
];

// --- Parse a PGN into UCI move lists ------------------------------------------

function uciLines(path: string, maxPly: number): string[][] {
  const out: string[][] = [];
  for (const game of readFileSync(path, "utf8").split(/\n\s*\n(?=\[Event)/)) {
    const movetext = game
      .split("\n")
      .filter((l) => l && !l.startsWith("["))
      .join(" ")
      .replace(/\{[^}]*\}/g, " ")
      .replace(/\d+\.(\.\.)?/g, " ")
      .replace(/(1-0|0-1|1\/2-1\/2|\*)/g, " ")
      .trim();
    if (!movetext) continue;
    const pos = Chess.default();
    const uci: string[] = [];
    for (const san of movetext.split(/\s+/).filter(Boolean)) {
      if (uci.length >= maxPly) break;
      const mv = parseSan(pos, san);
      if (!mv) break;
      uci.push(makeUci(mv));
      pos.play(mv);
    }
    if (uci.length >= 4) out.push(uci);
  }
  return out;
}

// --- Compose -------------------------------------------------------------------

type PlyEntry = BookEntry & { ply: number };

/** Extract this book's side's moves from one game. */
function entriesFromGame(uci: string[], wantParity: number, maxPly: number): PlyEntry[] {
  const pos = Chess.default();
  const out: PlyEntry[] = [];
  for (let ply = 0; ply < Math.min(uci.length, maxPly); ply++) {
    if (ply % 2 === wantParity) {
      const move = encodeMove(pos, uci[ply]);
      if (move === null) throw new Error(`cannot encode ${uci[ply]} at ply ${ply}`);
      out.push({ key: polyglotKey(pos), move, weight: 1, ply });
    }
    const m = parseUci(uci[ply]);
    if (!m || !pos.isLegal(m)) throw new Error(`illegal ${uci[ply]} at ply ${ply}`);
    pos.play(m);
  }
  return out;
}

function compose(def: BookDef, corpora: Record<Source, string[][]>): BookEntry[] {
  const wantParity = def.slot === "white" ? 0 : 1;
  const maxPly = def.maxPly ?? MAX_PLY;
  const totalShare = def.mix.reduce((s, [, sh]) => s + sh, 0);

  const scaled: BookEntry[] = [];
  const report: string[] = [];

  for (const [openingId, share] of def.mix) {
    const opening = BY_ID.get(openingId);
    if (!opening) throw new Error(`${def.id}: unknown opening ${openingId}`);
    // Coverage tails always come from the BALANCED corpus and stay shallow.
    // Drawing them from UHO would be wrong twice over: it is 5x the size (the
    // gambit book hit 624 KB), and its lines are deliberately lopsided — the
    // opposite of what you want for "just don't be out of book here".
    const isCover = openingId.startsWith("any-");
    const games = isCover ? corpora.balanced : corpora[def.source];
    const plyCap = isCover ? Math.min(maxPly, COVER_MAX_PLY) : maxPly;
    const matched = games.filter((u) => opening.prefix.every((m, i) => u[i] === m));
    if (matched.length === 0) {
      report.push(`      !! ${openingId}: NO LINES in ${def.source}`);
      continue;
    }

    // Merge and prune this opening ALONE first, while weights are still honest
    // game counts. Pruning after rescaling would mean the threshold meant a
    // different thing for every opening.
    const mine: PlyEntry[] = [];
    const plyOf = new Map<string, number>();
    for (const u of matched) {
      for (const e of entriesFromGame(u, wantParity, plyCap)) {
        const id = `${e.key}:${e.move}`;
        plyOf.set(id, Math.min(plyOf.get(id) ?? e.ply, e.ply));
        mine.push(e);
      }
    }
    const pruned = mergeEntries(mine).filter(
      (e) => (plyOf.get(`${e.key}:${e.move}`) ?? 0) < RARE_AFTER_PLY || e.weight >= MIN_WEIGHT,
    );

    // Rescale onto the designed share. Uniform scaling preserves the opening's
    // own internal odds while shifting how often it is chosen against its
    // stylemates. Weights stay FRACTIONAL here — rounding or flooring now would
    // inflate every opening whose factor is below 1 (a big corpus opening like
    // the English gets factor ≈ 0.2, so an early floor of 1 was silently
    // multiplying it by five and swamping the small ones).
    const rawTotal = pruned.reduce((s, e) => s + e.weight, 0);
    const factor = ((share / totalShare) * SCALE * def.mix.length) / rawTotal;
    for (const e of pruned) scaled.push({ ...e, weight: e.weight * factor });
    report.push(`      ${openingId.padEnd(20)} ${String(matched.length).padStart(6)} lines → ${share}%`);
  }

  // Combine across openings (transpositions merge), then land on integers once,
  // at the end. Floor at 1 so a rare line is playable rather than weight-0.
  const merged = mergeEntries(scaled).map((e) => ({ ...e, weight: Math.max(1, Math.round(e.weight)) }));
  console.log(`  ${def.id.padEnd(20)} ${String(merged.length).padStart(6)} entries  ${((merged.length * 16) / 1024).toFixed(0)} KB`);
  if (process.env.VERBOSE) report.forEach((r) => console.log(r));
  return merged;
}

// --- Run ------------------------------------------------------------------------

console.log(`parsing ${BALANCED_PGN} …`);
const balanced = uciLines(BALANCED_PGN, MAX_PLY);
console.log(`  ${balanced.length} balanced lines`);

const needsUho = BOOKS.some((b) => b.source === "uho");
let uho: string[][] = [];
if (needsUho) {
  console.log(`parsing ${UHO_PGN} …`);
  uho = uciLines(UHO_PGN, GAMBIT_MAX_PLY);
  console.log(`  ${uho.length} unbalanced lines`);
}
const corpora: Record<Source, string[][]> = { balanced, uho };

mkdirSync(OUT_DIR, { recursive: true });
console.log("");
const manifest: { id: string; label: string; slot: Slot; style: string; bytes: number }[] = [];
for (const def of BOOKS) {
  const entries = compose(def, corpora);
  const bytes = writeBook(entries);
  writeFileSync(`${OUT_DIR}/${def.id}.bin`, bytes);
  manifest.push({ id: def.id, label: def.label, slot: def.slot, style: def.style, bytes: bytes.byteLength });
}

const total = manifest.reduce((s, m) => s + m.bytes, 0);
console.log(`\nwrote ${manifest.length} books, ${(total / 1024 / 1024).toFixed(2)} MB total\n`);
console.log("// paste into lib/books.ts BOOKS:");
for (const m of manifest) {
  console.log(`  { id: "${m.id}", label: "${m.label}", slot: "${m.slot}", style: "${m.style}", bytes: ${m.bytes} },`);
}
