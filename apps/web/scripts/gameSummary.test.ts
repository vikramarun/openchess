// The strings a shared game link shows: its tab title and the text on its OG
// card. Both are built from lib/gameSummary, and both are rendered somewhere no
// test of the app itself would look — a Twitter unfurl, a browser tab.
//
// The cases that matter are the empty ones. Engine names are self-declared and
// optional, seats can be unnamed, and a casual game has no stake, so most of
// this file is about what the card says when there is nothing to say.
import { readFileSync } from "node:fs";

import { GAME_REVALIDATE_SECS, type GameDetail } from "../lib/gameApi";
import {
  gameSubtitle,
  gameTitle,
  scoreLine,
  seatLabel,
  timeControl,
} from "../lib/gameSummary";

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`,
  );
}

const WHITE = "0x1111111111111111111111111111111111111111";
const BLACK = "0x2222222222222222222222222222222222222222";

function game(over: Partial<GameDetail> = {}): GameDetail {
  return {
    game_id: "g1",
    mode: "casual",
    status: "finished",
    white: WHITE,
    black: BLACK,
    stake: null,
    result: "white",
    reason: null,
    result_hash: null,
    result_sig: null,
    settlement_status: "none",
    initial_secs: 600,
    increment_secs: 0,
    finished_at: null,
    white_engine: "Stockfish 17",
    black_engine: "Berserk",
    moves: [],
    ...over,
  };
}

// --- score ---
check("white win", scoreLine(game({ result: "white" })), "1-0");
check("black win", scoreLine(game({ result: "black" })), "0-1");
check("draw", scoreLine(game({ result: "draw" })), "½-½");
check("unfinished has no score", scoreLine(game({ result: null })), null);
check("an unknown result is not invented", scoreLine(game({ result: "weird" })), null);

// --- seat labels ---
check("a declared engine wins", seatLabel("Stockfish 17", WHITE, "White"), "Stockfish 17");
check("no engine falls back to the wallet", seatLabel(null, WHITE, "White"), "0x1111…1111");
check("no engine and no wallet falls back to the color", seatLabel(null, null, "Black"), "Black");
check("an empty engine string is not a name", seatLabel("   ", WHITE, "White"), "0x1111…1111");
// A seat declares its own engine name, unverified. Without a cap one could put a
// paragraph in the field and push everything else off the card.
check(
  "an overlong engine name is truncated",
  seatLabel("x".repeat(80), WHITE, "White"),
  `${"x".repeat(27)}…`,
);
check("a 28-char name is left alone", seatLabel("x".repeat(28), WHITE, "White"), "x".repeat(28));
// Engine names are self-declared and unverified, and the OG card stacks the two
// seats with `white-space: pre-wrap`. A name of newlines fits inside the length
// cap and still pushes everything below it off the card, so whitespace has to
// be flattened before the cap, not just trimmed at the ends.
check("newlines are flattened", seatLabel("A\n\n\n\n\n\nB", WHITE, "White"), "A B");
check("tabs and runs collapse", seatLabel("Stock\t\t  fish", WHITE, "White"), "Stock fish");
check(
  "a name of pure newlines is not a name",
  seatLabel("\n".repeat(26), WHITE, "White"),
  "0x1111…1111",
);

// --- titles ---
check("a finished game names both sides and the score", gameTitle(game()), "Stockfish 17 vs. Berserk — 1-0");
check(
  "a live game omits the score",
  gameTitle(game({ result: null, status: "active" })),
  "Stockfish 17 vs. Berserk",
);
check(
  "an anonymous game still reads as a matchup",
  gameTitle(game({ white_engine: null, black_engine: null, white: null, black: null, result: "draw" })),
  "White vs. Black — ½-½",
);

// --- time control ---
check("10+0", timeControl(game()), "10+0");
check("3+2", timeControl(game({ initial_secs: 180, increment_secs: 2 })), "3+2");

// --- subtitles ---
check("a casual game shows no stake", gameSubtitle(game()), "10+0 · 0 ply");
check(
  "a zero stake is not a stake",
  gameSubtitle(game({ stake: "0" })),
  "10+0 · 0 ply",
);
check(
  "a real stake is shown in USDC",
  gameSubtitle(game({ stake: "5000000" })),
  "10+0 · 0 ply · 5 USDC",
);
check(
  "the reason is spelled for humans",
  gameSubtitle(game({ reason: "time_forfeit" })),
  "10+0 · 0 ply · time forfeit",
);
check(
  "ply count comes from the move list",
  gameSubtitle(game({ moves: [{ ply: 1, uci: "e2e4", san: "e4", white_ms: 0, black_ms: 0 }] })),
  "10+0 · 1 ply",
);

// --- the title and the picture expire together ---
// The OG image route repeats this number as a literal, because Next requires a
// `revalidate` segment export to be statically analyzable and so it cannot
// import the constant. If the two drift, a game crawled while live keeps a
// scoreless title beside a card that already shows the result.
const ogSource = readFileSync(
  new URL("../app/game/[id]/opengraph-image.tsx", import.meta.url),
  "utf8",
);
const declared = ogSource.match(/^export const revalidate = (\d+)/m)?.[1];
check("the OG image declares a revalidate", declared !== undefined, true);
check("it matches GAME_REVALIDATE_SECS", Number(declared), GAME_REVALIDATE_SECS);

console.log(failed === 0 ? "\nall game-summary checks passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
