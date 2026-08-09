// What to call a player, in one place.
//
// This replaced four near-identical helpers that had already drifted apart:
// `Lobby`'s seatLabel (name → address → fallback), `LiveSpectator`'s seatName
// (name → address → "Engine"), `GameReplay`'s seatName (address only — it never
// read a declared name at all), and `gameSummary`'s seatLabel (engine-first,
// whitespace-collapsed, truncated at 28).
//
// The blank-string guard is why this is worth centralising rather than
// inlining. `p.username ?? shortAddress(me)` renders an EMPTY headline the
// moment a server sends "" instead of null — a name that silently vanishes,
// with no error anywhere. Written and tested once, that cannot happen at four
// call sites.

import { shortAddress } from "./address";

/** Collapse whitespace, trim, and truncate with an ellipsis.
 *
 *  Exported because the OG card must have it: that canvas renders with
 *  `white-space: pre-wrap`, so a label made of newlines pushes the opponent, the
 *  subtitle and the footer clean off the image while fitting well inside any
 *  character cap. */
export function sanitizeLabel(s: string, maxLen: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > maxLen ? `${flat.slice(0, maxLen - 1)}…` : flat;
}

/** Treat "" and whitespace-only as absent, so they fall through rather than
 *  rendering as a blank name. */
function clean(s?: string | null): string | undefined {
  const t = s?.replace(/\s+/g, " ").trim();
  return t ? t : undefined;
}

export type PlayerLabelParts = {
  /** The verified handle, from a profile/leaderboard payload or `OpponentInfo`. */
  username?: string | null;
  /** A server-resolved seat/offer display name (already a username or a short
   *  address, or a `~`-decorated guest label). Never a client's own claim. */
  name?: string | null;
  address?: string | null;
  /** Shown when there is nothing else at all, e.g. "Engine" | "White". */
  fallback?: string;
  /** Cap the result, for fixed-width surfaces like the OG card. */
  maxLen?: number;
};

/** Username → server-resolved name → shortened address → fallback. */
export function playerLabel({
  username,
  name,
  address,
  fallback = "",
  maxLen,
}: PlayerLabelParts): string {
  const out = clean(username) ?? clean(name) ?? shortAddress(address, fallback);
  return maxLen ? sanitizeLabel(out, maxLen) : out;
}
