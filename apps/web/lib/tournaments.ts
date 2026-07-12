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

/** Fetch one tournament's full detail. */
export async function fetchTournament(id: string): Promise<Tournament> {
  const d = await fetch(`${SERVER_HTTP}/tournaments/${id}`).then((r) => r.json());
  return { id, ...d } as Tournament;
}

/** Fetch every tournament with full detail (ids → detail per id). Shared by the
 *  tournament lobby and the bankroll claim discovery so the fan-out lives once. */
export async function fetchTournaments(): Promise<Tournament[]> {
  const ids: { tournament_id: string }[] = await fetch(`${SERVER_HTTP}/tournaments`).then((r) =>
    r.ok ? r.json() : [],
  );
  return Promise.all(ids.map(({ tournament_id }) => fetchTournament(tournament_id)));
}
