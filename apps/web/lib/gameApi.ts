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
  result: string | null; // "white" | "black" | "draw"
  reason: string | null;
  result_hash: string | null;
  result_sig: string | null; // oracle signature over result_hash (for replay verification)
  settlement_status: string; // none | pending | settled | failed
  initial_secs: number;
  increment_secs: number;
  finished_at: string | null;
  /** Self-declared engines, [white, black]. Null for games recorded before
   *  migration 0012 and for seats that declared none. Unverified by design. */
  white_engine: string | null;
  black_engine: string | null;
  moves: GameMove[];
};

/** Fetch full game detail; returns null on 404 / network error / bad shape. */
export async function fetchGame(id: string): Promise<GameDetail | null> {
  try {
    const r = await fetch(`${SERVER_HTTP}/games/${encodeURIComponent(id)}`);
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
