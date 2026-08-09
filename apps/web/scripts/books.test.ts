// Verify the repertoire-book layer: the Polyglot `.bin` writer (the inverse of
// the reader that pnpm test:book pins to the spec vectors), weighted move
// selection, and the fact that a White book and a Black book can simply be
// concatenated because Polyglot is keyed by position.
//
// The writer matters more than it looks: built-in repertoires and a user's
// uploaded book share one probe path, so a bug here would silently mis-play
// every built-in opening while the uploaded-book tests stayed green.
import { readFileSync } from "node:fs";

import { Chess } from "chessops/chess";
import { parseUci } from "chessops/util";

import {
  BOOKS,
  DEFAULT_REPERTOIRE,
  PRESETS,
  SLOTS,
  booksForSlot,
  concatBooks,
  normalizeRepertoire,
} from "../lib/books";
import { bookChildren, bookMainline, positionAfter } from "../lib/bookTree";
import { browserEngineLabel, parseBrowserBotConfig } from "../lib/browserBot";
import { DEFAULT_TIME_POLICY } from "../lib/timePolicy";
import {
  decodeMove,
  entriesFor,
  parseBook,
  pickBookMove,
  polyglotKey,
  type BookEntry,
} from "../lib/polyglot";
import { encodeMove, mergeEntries, writeBook, MAX_WEIGHT } from "../lib/polyglotWrite";

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
}

function posAfter(moves: string[]): Chess {
  const pos = Chess.default();
  for (const u of moves) {
    const m = parseUci(u);
    if (!m || !pos.isLegal(m)) throw new Error(`illegal ${u}`);
    pos.play(m);
  }
  return pos;
}

/** Build a book from (move-history, uci, weight) triples, the way the composer
 *  does: key the position, encode the move, merge duplicates, serialize. */
function book(lines: [string[], string, number][]): BookEntry[] {
  const entries: BookEntry[] = [];
  for (const [history, uci, weight] of lines) {
    const pos = posAfter(history);
    const move = encodeMove(pos, uci);
    if (move === null) throw new Error(`cannot encode ${uci}`);
    entries.push({ key: polyglotKey(pos), move, weight });
  }
  const bytes = writeBook(mergeEntries(entries));
  return parseBook(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

// --- encodeMove is the exact inverse of decodeMove -------------------------
{
  const start = Chess.default();
  check("encode/decode e2e4", decodeMove(start, encodeMove(start, "e2e4")!), "e2e4");
  check("encode/decode g1f3", decodeMove(start, encodeMove(start, "g1f3")!), "g1f3");

  // Castling is the case that isn't a plain square-pair: Polyglot stores
  // king-takes-rook (e1h1) while the server speaks standard UCI (e1g1).
  const castle = posAfter(["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5"]);
  const enc = encodeMove(castle, "e1g1")!;
  check("castling encodes as king-takes-rook", [(enc >> 6) & 7, (enc >> 9) & 7, enc & 7, (enc >> 3) & 7], [4, 0, 7, 0]);
  check("castling round-trips to standard UCI", decodeMove(castle, enc), "e1g1");

  // Queenside, and from Black's side of the board.
  const q = posAfter(["d2d4", "d7d5", "b1c3", "b8c6", "c1f4", "c8f5", "d1d2", "d8d7"]);
  check("queenside castle round-trips", decodeMove(q, encodeMove(q, "e1c1")!), "e1c1");
  const bq = posAfter(["d2d4", "d7d5", "b1c3", "b8c6", "c1f4", "c8f5", "d1d2", "d8d7", "a2a3"]);
  check("black queenside castle round-trips", decodeMove(bq, encodeMove(bq, "e8c8")!), "e8c8");

  // Promotions use Polyglot's 1=knight..4=queen coding.
  const promo = posAfter(["a2a4", "b7b5", "a4b5", "a7a6", "b5a6", "g8f6", "a6a7", "f6g8"]);
  check("queen promotion round-trips", decodeMove(promo, encodeMove(promo, "a7a8q")!), "a7a8q");
  check("knight promotion round-trips", decodeMove(promo, encodeMove(promo, "a7a8n")!), "a7a8n");
  check("promo code for queen is 4", (encodeMove(promo, "a7a8q")! >> 12) & 7, 4);

  check("rejects a short move", encodeMove(start, "e2e"), null);
  check("rejects an off-board file", encodeMove(start, "z2z4"), null);
  check("rejects an unknown promotion piece", encodeMove(start, "a7a8k"), null);
}

// --- writeBook round-trips through parseBook -------------------------------
{
  const entries = book([
    [[], "e2e4", 60],
    [[], "d2d4", 40],
    [["e2e4"], "c7c5", 100],
  ]);
  check("round-trip entry count", entries.length, 3);
  check("entries are sorted by key", entries.every((e, i) => i === 0 || entries[i - 1].key <= e.key), true);

  const start = Chess.default();
  const found = entriesFor(entries, polyglotKey(start));
  check("startpos has both first moves", found.length, 2);
  check(
    "weights survive the round trip",
    found.map((e) => decodeMove(start, e.move) + ":" + e.weight).sort(),
    ["d2d4:40", "e2e4:60"],
  );
  check("writeBook emits 16 bytes per entry", writeBook(entries).byteLength, 48);
}

// --- weight merging --------------------------------------------------------
{
  const start = Chess.default();
  const e4 = encodeMove(start, "e2e4")!;
  const key = polyglotKey(start);
  const merged = mergeEntries([
    { key, move: e4, weight: 10 },
    { key, move: e4, weight: 5 },
    { key, move: encodeMove(start, "d2d4")!, weight: 3 },
  ]);
  check("duplicates merge into one entry", merged.length, 2);
  check("merged weights sum", merged.find((m) => m.move === e4)!.weight, 15);
  check(
    "weight overflow clamps instead of wrapping",
    mergeEntries([
      { key, move: e4, weight: MAX_WEIGHT },
      { key, move: e4, weight: 100 },
    ])[0].weight,
    MAX_WEIGHT,
  );
}

// --- best vs weighted picking ---------------------------------------------
{
  const entries = book([
    [[], "e2e4", 70],
    [[], "d2d4", 30],
  ]);
  const start = Chess.default();

  // Default (no options) must stay byte-identical to the old behaviour.
  check("default pick is the highest weight", pickBookMove(entries, start), "e2e4");
  check("explicit best pick", pickBookMove(entries, start, { pick: "best" }), "e2e4");

  // Weighted sampling is deterministic given a seeded rng: r = rng()*100, then
  // walk the entries in stored order (d2d4 sorts before e2e4 by move field).
  const at = (r: number) => pickBookMove(entries, start, { pick: "weighted", rng: () => r });
  const picks = new Set([at(0), at(0.2), at(0.5), at(0.9), at(0.999)]);
  check("weighted only ever returns book moves", [...picks].sort(), ["d2d4", "e2e4"]);
  check("weighted is deterministic for a fixed rng", [at(0.1), at(0.1), at(0.1)], [at(0.1), at(0.1), at(0.1)]);
  check("rng at the top of the range still returns a move", at(0.9999999) !== null, true);

  // A book whose weights are all zero must still produce a move.
  const zeroed = book([
    [[], "e2e4", 0],
    [[], "d2d4", 0],
  ]);
  check("all-zero weights degrade to uniform, not null", zeroed.length > 0 && at(0) !== null, true);
  check("zero-weight book returns a legal move", ["d2d4", "e2e4"].includes(pickBookMove(zeroed, start, { pick: "weighted", rng: () => 0.5 })!), true);

  check("a position outside the book returns null", pickBookMove(entries, posAfter(["a2a3"]), { pick: "weighted", rng: () => 0.5 }), null);
}

// --- White ∥ Black books concatenate, because Polyglot is position-keyed ---
{
  // A White repertoire (1.e4) and a Black repertoire (…c5 vs 1.e4) built
  // independently, then concatenated the way a selected repertoire is.
  const white = book([[[], "e2e4", 100]]);
  const black = book([[["e2e4"], "c7c5", 100]]);
  const combined = parseBook(
    (() => {
      const b = writeBook([...white, ...black]);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    })(),
  );

  check("combined book plays the White move at startpos", pickBookMove(combined, Chess.default()), "e2e4");
  check("combined book plays the Black reply after 1.e4", pickBookMove(combined, posAfter(["e2e4"])), "c7c5");
  // The White entry must not leak into a position where it isn't White to move.
  check("White entry doesn't match a Black-to-move position", pickBookMove(white, posAfter(["e2e4"])), null);
  check("Black entry doesn't match startpos", pickBookMove(black, Chess.default()), null);
}

// --- the books we actually ship -------------------------------------------
// Reading the real artifacts, because everything above only proves the
// machinery works — not that the committed books are the ones we meant to
// build. A bad `pnpm build:books` would otherwise ship silently.
{
  const load = (id: string): BookEntry[] => {
    const b = readFileSync(`public/books/${id}.bin`);
    return parseBook(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  };

  // Every shipped book exists, parses, and is non-empty.
  for (const meta of BOOKS) {
    const e = load(meta.id);
    check(`${meta.id} parses and has entries`, e.length > 0, true);
  }

  // A style is a MIX, not one opening: given the defence, the book should offer
  // several playable answers weighted toward its style. This is the property
  // the old by-first-move books didn't have.
  const sharpW = load("w-sharp");
  const afterE5 = posAfter(["e2e4", "e7e5"]);
  const sharpReplies = bookChildren(sharpW, afterE5);
  check("Sharp offers several answers to 1…e5", sharpReplies.length >= 4, true);
  check(
    "Sharp's King's Gambit is a real share vs 1…e5",
    (sharpReplies.find((c) => c.san === "f4")?.share ?? 0) > 0.2,
    true,
  );
  const afterC5 = posAfter(["e2e4", "c7c5"]);
  check(
    "Sharp plays the Open Sicilian vs 1…c5",
    bookChildren(sharpW, afterC5)[0].san,
    "Nf3",
  );

  // Gambiteer is a genuine style, not a relabelled Sharp: it meets 1…c5 with
  // the Smith-Morra and 1…e5 with gambit tries.
  const gambitW = load("w-gambit");
  check("Gambiteer answers 1…c5 with d4 (Smith-Morra)", bookChildren(gambitW, afterC5)[0].san, "d4");
  check(
    "Gambiteer's f4/d4 tries dominate vs 1…e5",
    bookChildren(gambitW, afterE5)
      .filter((c) => c.san === "f4" || c.san === "d4")
      .reduce((s, c) => s + c.share, 0) > 0.4,
    true,
  );

  // Solid must NOT be sharp: it answers 1…c5 with the quiet systems.
  const solidW = load("w-solid");
  const solidVsC5 = bookChildren(solidW, afterC5);
  check(
    "Solid meets 1…c5 with Rossolimo/Alapin systems",
    (solidVsC5.find((c) => c.san === "c3")?.share ?? 0) > 0.2,
    true,
  );

  // Coverage: a White book must answer EVERY Black first move, not just the
  // defences its own style names. Without the coverage tails a Sharp bot was
  // out of book at move two against the Scandinavian.
  for (const id of ["w-classical", "w-sharp", "w-solid", "w-gambit"]) {
    const bk = load(id);
    const uncovered = [["e2e4", "d7d5"], ["e2e4", "d7d6"], ["e2e4", "g7g6"], ["e2e4", "g8f6"], ["e2e4", "b8c6"]]
      .filter((h) => bookChildren(bk, posAfter(h)).length === 0);
    check(`${id} answers every reply to 1.e4`, uncovered, []);
  }

  // The isolation property the whole repertoire design rests on: a White book
  // must contribute nothing when it is Black to move, and vice versa.
  check("w-sharp is silent when Black is to move", pickBookMove(sharpW, posAfter(["e2e4"])), null);
  check("b-e4-sharp is silent at startpos", pickBookMove(load("b-e4-sharp"), Chess.default()), null);

  // Concatenating a White book with a Black answer book yields real theory and
  // keeps yielding it — which is the whole feature.
  const combined = concatBooks([load("w-sharp"), load("b-e4-sharp")]);
  const line: string[] = [];
  const walk = Chess.default();
  for (let i = 0; i < 10; i++) {
    const uci = pickBookMove(combined, walk);
    if (!uci) break;
    const m = parseUci(uci);
    if (!m || !walk.isLegal(m)) break;
    line.push(uci);
    walk.play(m);
  }
  check("a Sharp repertoire stays in book for 10 plies", line.length, 10);
  check("…and it opens 1.e4", line[0], "e2e4");
}

// --- concatBooks keeps the array sorted (entriesFor binary-searches) -------
{
  const a = book([[[], "e2e4", 10]]);
  const b = book([[["e2e4"], "c7c5", 10]]);
  const merged = concatBooks([a, b]);
  check(
    "concat stays sorted by key",
    merged.every((e, i) => i === 0 || merged[i - 1].key <= e.key),
    true,
  );
  // The real risk: naive concat leaves the array unsorted, and entriesFor's
  // binary search then can't find the second book's positions at all.
  check("both books remain findable after concat", [
    pickBookMove(merged, Chess.default()),
    pickBookMove(merged, posAfter(["e2e4"])),
  ], ["e2e4", "c7c5"]);
  check("concat of nothing is empty", concatBooks([]), []);
}

// --- repertoire validation -------------------------------------------------
{
  const d = DEFAULT_REPERTOIRE;
  check("empty repertoire normalizes to defaults", normalizeRepertoire({}), d);
  check("null normalizes to defaults", normalizeRepertoire(null), d);
  check(
    "a valid selection survives",
    normalizeRepertoire({ white: "w-sharp", vsE4: "b-e4-sharp", maxPly: 10, pick: "best" }),
    { white: "w-sharp", vsE4: "b-e4-sharp", vsD4: null, vsOther: null, maxPly: 10, pick: "best" },
  );
  // A book id in the wrong slot would fetch a real file but play the wrong
  // colour's moves, which is worse than playing no book at all.
  check("a book in the wrong slot is rejected", normalizeRepertoire({ white: "b-e4-sharp" }).white, null);
  check("an unknown id is rejected", normalizeRepertoire({ white: "w-nonsense" }).white, null);
  check("maxPly clamps high", normalizeRepertoire({ maxPly: 9999 }).maxPly, 60);
  check("maxPly clamps negative", normalizeRepertoire({ maxPly: -5 }).maxPly, 0);
  check("NaN maxPly falls back to the default", normalizeRepertoire({ maxPly: NaN }).maxPly, d.maxPly);
  check("an unknown pick falls back to weighted", normalizeRepertoire({ pick: "chaos" }).pick, "weighted");

  // Every preset must reference books that exist, in the right slots —
  // otherwise a preset silently selects nothing.
  const presetsValid = PRESETS.every((p) => {
    const n = normalizeRepertoire(p.rep);
    return (
      n.white === p.rep.white && n.vsE4 === p.rep.vsE4 && n.vsD4 === p.rep.vsD4 && n.vsOther === p.rep.vsOther
    );
  });
  check("every preset references real books in the right slots", presetsValid, true);
  check("every book id is unique", new Set(BOOKS.map((b) => b.id)).size, BOOKS.length);
  check("every slot has at least one book", SLOTS.every((s) => booksForSlot(s.slot).length > 0), true);
}

// --- config migration ------------------------------------------------------
{
  // A blob written before repertoires existed must keep its settings.
  const v1 = parseBrowserBotConfig({ name: "My Bot", bookMaxPly: 12 });
  check("v1 config keeps its name", v1.name, "My Bot");
  check("v1 config keeps bookMaxPly", v1.bookMaxPly, 12);
  check("v1 config gains a default repertoire", v1.repertoire, DEFAULT_REPERTOIRE);
  check("v1 config gains a default time policy", v1.time, DEFAULT_TIME_POLICY);

  check("garbage config falls back cleanly", parseBrowserBotConfig(null).name, "");
  check("a long name is truncated", parseBrowserBotConfig({ name: "x".repeat(200) }).name.length, 48);
  check(
    "a hostile repertoire blob is sanitized",
    parseBrowserBotConfig({ repertoire: { white: 42, maxPly: Infinity, pick: {} } }).repertoire,
    DEFAULT_REPERTOIRE,
  );

  // The declared label names the repertoire, and must survive the server's
  // 48-char sanitize_label cap.
  const sharp = PRESETS.find((p) => p.id === "sharp")!;
  const label = browserEngineLabel({ name: "", bookMaxPly: 16, time: DEFAULT_TIME_POLICY, repertoire: normalizeRepertoire(sharp.rep) });
  check("label names the style", label, "Stockfish 18 · Sharp");
  check("label fits the 48-char cap", label.length <= 48, true);
  check(
    "no repertoire keeps the plain label",
    browserEngineLabel({ name: "", bookMaxPly: 16, time: DEFAULT_TIME_POLICY, repertoire: DEFAULT_REPERTOIRE }),
    "Stockfish 18 (browser)",
  );
  const mixed = normalizeRepertoire({ white: "w-sharp", vsE4: "b-e4-solid", vsD4: "b-d4-solid", vsOther: "b-other-solid" });
  check(
    "a mixed repertoire names both styles",
    browserEngineLabel({ name: "", bookMaxPly: 16, time: DEFAULT_TIME_POLICY, repertoire: mixed }),
    "Stockfish 18 · Sharp/Solid",
  );
}

// --- tree walk -------------------------------------------------------------
{
  const entries = book([
    [[], "e2e4", 70],
    [[], "d2d4", 20],
    [[], "c2c4", 10],
    [["e2e4"], "c7c5", 100],
  ]);
  const kids = bookChildren(entries, Chess.default());
  check("children are sorted heaviest first", kids.map((c) => c.san), ["e4", "d4", "c4"]);
  check("children carry SAN", kids[0].san, "e4");
  check("shares sum to 1", Math.round(kids.reduce((s, c) => s + c.share, 0) * 1000) / 1000, 1);
  check("share is proportional to weight", Math.round(kids[0].share * 100), 70);
  check("a position outside the book has no children", bookChildren(entries, posAfter(["a2a3"])), []);

  check("positionAfter replays a legal history", positionAfter(["e2e4", "c7c5"]) !== null, true);
  check("positionAfter rejects an illegal history", positionAfter(["e2e4", "e2e4"]), null);

  const line = bookMainline(entries, 12);
  check("mainline follows the heaviest moves", line.map((c) => c.san), ["e4", "c5"]);
  check("mainline stops when the book does", line.length, 2);

  // A shuffle cycle (Nf3 Nf6 Ng1 Ng8 → back to the start position) must
  // terminate rather than walk forever.
  const cyclic = book([
    [[], "g1f3", 10],
    [["g1f3"], "g8f6", 10],
    [["g1f3", "g8f6"], "f3g1", 10],
    [["g1f3", "g8f6", "f3g1"], "f6g8", 10],
  ]);
  const cycleLine = bookMainline(cyclic, 100);
  check("a cyclic book terminates", cycleLine.length <= 4, true);
  check("the cycle walks its four plies then stops", cycleLine.map((c) => c.uci), ["g1f3", "g8f6", "f3g1", "f6g8"]);

  // And the real books produce a readable tree.
  const real = (() => {
    const b = readFileSync("public/books/w-sharp.bin");
    return parseBook(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  })();
  check("the shipped Sharp book opens 1.e4", bookChildren(real, Chess.default())[0].san, "e4");
  check("the shipped book answers 1…c5", bookChildren(real, posAfter(["e2e4", "c7c5"])).length > 0, true);
}

process.exit(failed === 0 ? 0 : 1);
