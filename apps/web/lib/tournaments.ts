import { SERVER_HTTP } from "./config";

/** A pairing in the schedule. `game_id` is null for a forfeit — the pairing was
 *  awarded without a game, so there is no room to spectate. */
export type TournamentGame = {
  game_id: string | null;
  white: string;
  black: string;
  round: number;
  /** "white" | "black" | "draw"; null while the game is still in progress. */
  result: "white" | "black" | "draw" | null;
  forfeit: boolean;
};

export type Standing = {
  player: string;
  score: number;
  played: number;
  /** 1-based; equal scores share a rank. */
  rank: number;
  bot: boolean;
};

export type Tournament = {
  id: string;
  name: string;
  buy_in: string | null;
  status: string;
  players: string[];
  games: TournamentGame[];
  standings: Standing[];
  current_round: number;
  total_rounds: number;
  initial_secs: number;
  increment_secs: number;
  organizer: string | null;
  age_secs: number;
};

export type ClaimableTournament = {
  tournament_id: string;
  name: string;
  status: string;
};

/** The connected wallet's finished buy-in tournaments that may have a payout or
 *  refund to collect. DB-sourced server-side and already filtered to the
 *  wallet's finished entries — the bankroll claim UI just renders these. */
export async function fetchClaimableTournaments(address: string): Promise<ClaimableTournament[]> {
  const r = await fetch(`${SERVER_HTTP}/tournaments/claimable/${address}`);
  if (!r.ok) return [];
  return r.json();
}

/** Fill in the fields an older server doesn't send.
 *
 *  This matters because of how the two halves ship: the web app deploys itself
 *  on merge to `main`, while the Rust server only moves when someone runs
 *  `scripts/deploy-server.sh`. So there is always a window where this code is
 *  live against the previous server. Reading `standings.length` in that window
 *  would blank the whole page — degrade to an empty table instead. */
function normalize(id: string, view: Partial<Omit<Tournament, "id">>): Tournament {
  const players = Array.isArray(view.players) ? view.players : [];
  return {
    id,
    name: view.name ?? "Tournament",
    buy_in: view.buy_in ?? null,
    status: view.status ?? "open",
    players,
    games: Array.isArray(view.games) ? view.games : [],
    // Pre-standings servers sent no table; show the field on zero rather than
    // pretending nobody entered.
    standings: Array.isArray(view.standings)
      ? view.standings
      : players.map((player) => ({ player, score: 0, played: 0, rank: 1, bot: false })),
    current_round: view.current_round ?? 0,
    total_rounds: view.total_rounds ?? 0,
    initial_secs: view.initial_secs ?? 0,
    increment_secs: view.increment_secs ?? 0,
    organizer: view.organizer ?? null,
    age_secs: view.age_secs ?? 0,
  };
}

/** Fetch one tournament's full detail. Throws on a non-OK response. */
export async function fetchTournament(id: string): Promise<Tournament> {
  const r = await fetch(`${SERVER_HTTP}/tournaments/${id}`);
  if (!r.ok) throw new Error(`tournament ${id} (${r.status})`);
  return normalize(id, await r.json());
}

/** Fetch the whole lobby in ONE request.
 *
 *  `GET /tournaments` used to return bare ids and this fanned out to a detail
 *  request per id, every 3s — N+1 against a server that holds a mutex over the
 *  lobby for each one. The list route now inlines each tournament's full view,
 *  keeping `tournament_id` alongside it. */
export async function fetchTournaments(): Promise<Tournament[]> {
  const r = await fetch(`${SERVER_HTTP}/tournaments`);
  if (!r.ok) return [];
  const rows: ({ tournament_id: string } & Partial<Omit<Tournament, "id">>)[] = await r.json();
  if (!Array.isArray(rows)) return [];
  // An id-only response means the server predates the inlined view; fall back to
  // the old per-id fan-out so the lobby still renders until it's deployed.
  if (rows.length > 0 && rows.every((row) => row.players === undefined)) {
    const detailed = await Promise.all(
      rows.map((row) => fetchTournament(row.tournament_id).catch(() => null)),
    );
    return detailed.filter((t): t is Tournament => t !== null);
  }
  return rows.map(({ tournament_id, ...view }) => normalize(tournament_id, view));
}

/** Which entrant am I in this tournament?
 *
 *  A buy-in tournament keys entrants by the authenticated wallet, so the
 *  connected address answers it. A casual one keys them by the display name the
 *  player chose, which lives only in the browser — so it is persisted here.
 *  Keeping it in React state (as this page used to) meant a reload turned an
 *  entrant into a stranger: no Start button, no games, no way back into an
 *  event they had already joined. */
const IDENTITY_KEY = "openchess.tournamentIdentity";

type Identities = Record<string, string>;

function readIdentities(): Identities {
  try {
    const raw = window.localStorage.getItem(IDENTITY_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Identities) : {};
  } catch {
    return {};
  }
}

export function casualIdentity(tid: string): string | null {
  try {
    return readIdentities()[tid] ?? null;
  } catch {
    return null;
  }
}

/** Remember the entrant id the SERVER recorded (not the string we sent — it is
 *  sanitized and capped server-side, and a client that stored its own version
 *  would look up an entrant that doesn't exist). */
export function rememberCasualIdentity(tid: string, player: string): void {
  try {
    window.localStorage.setItem(IDENTITY_KEY, JSON.stringify({ ...readIdentities(), [tid]: player }));
  } catch {
    /* private mode — identity just won't survive the reload */
  }
}

/** Entrant ids are compared case-insensitively everywhere on the server. */
export const sameEntrant = (a: string | null, b: string | null): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();
