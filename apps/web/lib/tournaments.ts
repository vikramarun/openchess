import { SERVER_HTTP } from "./config";

export type TournamentGame = {
  game_id: string;
  white: string;
  black: string;
  round: number;
};

export type Tournament = {
  id: string;
  name: string;
  buy_in: string | null;
  status: string;
  players: string[];
  games: TournamentGame[];
  current_round: number;
  total_rounds: number;
};

export type ClaimableTournament = {
  tournament_id: string;
  name: string;
  status: string;
};

/** The connected wallet's finished buy-in tournaments that may have a payout or
 *  refund to collect. DB-sourced server-side (survives a restart, unlike the
 *  in-memory GET /tournaments list) and already filtered to the wallet's
 *  finished entries — the bankroll claim UI just renders these. */
export async function fetchClaimableTournaments(address: string): Promise<ClaimableTournament[]> {
  const r = await fetch(`${SERVER_HTTP}/tournaments/claimable/${address}`);
  if (!r.ok) return [];
  return r.json();
}

/** Fetch one tournament's full detail. Throws on a non-OK response. */
export async function fetchTournament(id: string): Promise<Tournament> {
  const r = await fetch(`${SERVER_HTTP}/tournaments/${id}`);
  if (!r.ok) throw new Error(`tournament ${id} (${r.status})`);
  return { id, ...(await r.json()) } as Tournament;
}

/** Fetch every tournament with full detail (ids → detail per id). Shared by the
 *  tournament lobby so the fan-out lives once. Tolerates a tournament that
 *  vanished between the list and detail fetch — one bad row shouldn't blank the
 *  whole list. */
export async function fetchTournaments(): Promise<Tournament[]> {
  const ids: { tournament_id: string }[] = await fetch(`${SERVER_HTTP}/tournaments`).then((r) =>
    r.ok ? r.json() : [],
  );
  const settled = await Promise.all(
    ids.map(({ tournament_id }) => fetchTournament(tournament_id).catch(() => null)),
  );
  return settled.filter((t): t is Tournament => t !== null);
}
