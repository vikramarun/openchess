// Client for the single-game detail endpoint (GET /games/{id}) — powers replay
// of a finished game and settlement-status polling for a wagered one.

import { SERVER_HTTP } from "./config";

export type GameMove = {
  ply: number;
  uci: string;
  san: string;
  white_ms: number;
  black_ms: number;
};

export type GameDetail = {
  game_id: string;
  mode: string;
  status: string; // pending | active | finished | aborted
  white: string | null;
  black: string | null;
  stake: string | null;
  /** Which ladder it counted for. Not `stake != null`: a buy-in tournament game
   *  is ranked with no stake of its own. Absent from an older server. */
  rated?: boolean;
  result: string | null; // "white" | "black" | "draw"
  reason: string | null;
  result_hash: string | null;
  result_sig: string | null; // oracle signature over result_hash (for replay verification)
  settlement_status: string; // none | pending | settled | failed
  initial_secs: number;
  increment_secs: number;
  finished_at: string | null;
  /** Self-declared engines, [white, black]. Null for games recorded before
   *  migration 0013 and for seats that declared none. Unverified by design. */
  white_engine: string | null;
  black_engine: string | null;
  moves: GameMove[];
};

/** How long a server-rendered game detail may be reused, in seconds.
 *
 *  Next 14's fetch defaults to `force-cache`, so without this the Data Cache
 *  holds a game forever: one crawled while live would keep a scoreless title
 *  for the life of the deployment, even as its OG image (which sets its own
 *  revalidate) went on to show the result. Both now expire together.
 *
 *  app/game/[id]/opengraph-image.tsx repeats this number as a literal, because
 *  Next requires the `revalidate` segment export to be statically analyzable
 *  and so cannot import it. Change both. */
export const GAME_REVALIDATE_SECS = 300;

/** Fetch full game detail; returns null on 404 / network error / bad shape.
 *  The `next` option is server-only and ignored by the browser, so the client
 *  components calling this are unaffected. */
export async function fetchGame(id: string): Promise<GameDetail | null> {
  try {
    const r = await fetch(`${SERVER_HTTP}/games/${encodeURIComponent(id)}`, {
      next: { revalidate: GAME_REVALIDATE_SECS },
    });
    if (!r.ok) return null;
    const d = await r.json();
    // Validate the shape the replay depends on rather than trusting the body —
    // a 200 with an unexpected payload must not crash the board.
    if (!d || typeof d.status !== "string" || !Array.isArray(d.moves)) return null;
    return d as GameDetail;
  } catch {
    return null;
  }
}

export function isFinished(status: string): boolean {
  return status === "finished" || status === "aborted";
}

/** Wagered games of `address` whose escrow the server never settled — the
 *  candidates for the contract's `claimTimeout` refund. Server-filtered to the
 *  wallet; the chain decides whether any of them is actually claimable yet. */
export type UnsettledGame = { game_id: string };

export async function fetchUnsettledGames(address: string): Promise<UnsettledGame[]> {
  const r = await fetch(`${SERVER_HTTP}/games/unsettled/${address}`);
  if (!r.ok) return [];
  return r.json();
}
