// How a game describes itself outside the app: in a tab title, and on the OG
// card a shared link unfurls into.
//
// Both consumers have to agree, and they run in different places — the title in
// generateMetadata, the card in a separate image request — so the labelling
// lives here rather than in either one.

import { fmtUsdc } from "./escrow";
import type { GameDetail } from "./gameApi";
import { playerLabel } from "./playerLabel";

/** What to call a seat: the engine it declared, else its wallet, else the
 *  color. Engine names are self-declared and unverified (see GameDetail), so
 *  they are shown as given but truncated — a seat could otherwise put a
 *  sentence in the field and blow out the card.
 *
 *  ENGINE-first, unlike every other surface, and that stays a deliberate product
 *  decision about what a shared link says rather than an oversight: a game card
 *  is about the matchup, not the accounts. `pnpm test:gamemeta` pins the exact
 *  strings, so this shares `playerLabel`'s implementation without adopting its
 *  precedence. Preferring a username here needs `white_username`/`black_username`
 *  on `GameDetail` first. */
export function seatLabel(
  engine: string | null,
  address: string | null,
  color: "White" | "Black",
): string {
  // The whitespace collapse is load-bearing, not cosmetic: the OG card renders
  // the title with `white-space: pre-wrap` so the two seats stack, which means a
  // name made of newlines pushes the opponent, the subtitle and the footer clean
  // off the canvas — while fitting well inside the length cap on its way.
  return playerLabel({ name: engine, address, fallback: color, maxLen: 28 });
}

/** "1-0" / "0-1" / "½-½", or null while the game is still running. */
export function scoreLine(d: GameDetail): string | null {
  if (d.result === "white") return "1-0";
  if (d.result === "black") return "0-1";
  if (d.result === "draw") return "½-½";
  return null;
}

/** e.g. `Stockfish 17 vs. Berserk — 1-0`. */
export function gameTitle(d: GameDetail): string {
  const white = seatLabel(d.white_engine, d.white, "White");
  const black = seatLabel(d.black_engine, d.black, "Black");
  const score = scoreLine(d);
  return score ? `${white} vs. ${black} — ${score}` : `${white} vs. ${black}`;
}

/** Time control in the conventional `10+0` shorthand. */
export function timeControl(d: GameDetail): string {
  return `${Math.round(d.initial_secs / 60)}+${d.increment_secs}`;
}

/** One line of context: time control, stake, and how it ended. */
export function gameSubtitle(d: GameDetail): string {
  const parts = [`${timeControl(d)} · ${d.moves.length} ply`];
  // "0" is a real value here and must not be printed as a stake.
  if (d.stake && d.stake !== "0") parts.push(`${fmtUsdc(d.stake)} USDC`);
  if (d.reason) parts.push(d.reason.replace(/_/g, " "));
  return parts.join(" · ");
}
