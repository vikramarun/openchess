import { SERVER_HTTP } from "./config";
import { DEFAULT_PAYOUT, type PayoutSpec } from "./payouts";

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
  /** 1-based position in the payout order. Never shared between equal scores —
   *  the pool is paid out by position (by the tournament's own `payout`
   *  structure), so showing a shared rank would promise money the contract
   *  won't send. */
  rank: number;
  /** Another entrant finished on this exact score, so this row's position — and
   *  its share of the pool — came from the tiebreak rather than from play. */
  tied: boolean;
  bot: boolean;
};

export type Tournament = {
  id: string;
  name: string;
  buy_in: string | null;
  status: string;
  players: string[];
  /** From `fetchTournament` this is every pairing the schedule has produced.
   *  From `fetchTournaments` (the lobby list) it is ONLY the round in progress
   *  — a 128-entrant field is 8128 pairings and the lobby is polled every 3s by
   *  every client. The lobby only needs the current round anyway: that is what
   *  tells it a board should be open. Don't build a crosstable from the list. */
  games: TournamentGame[];
  standings: Standing[];
  current_round: number;
  total_rounds: number;
  initial_secs: number;
  increment_secs: number;
  organizer: string | null;
  /** How the pool is divided: basis points per finishing place, best first. */
  payout: PayoutSpec;
  /** What each `standings` row would take if the event ended now, in USDC base
   *  units, INDEX-ALIGNED with `standings`. Empty when there is no pool (and on
   *  a server that predates the field). Computed server-side by the same
   *  function that settles, so this is the table that actually pays. */
  prizes: string[];
  /** The prize pool in USDC base units — entries plus sponsorship. `null` when
   *  there is no pool. A free event is `buy_in: "0"` with a pool here. */
  pool: string | null;
  age_secs: number;
};

/** What kind of tournament this is.
 *
 *  `buy_in` carries two facts at once: whether there is an onchain prize pool
 *  (non-null) and what entry costs (its value, which may be `"0"` for a
 *  sponsor-funded free event). Never branch on `buy_in` directly — `"0"` is a
 *  TRUTHY string, so `t.buy_in ? … : "casual"` renders a free event as a
 *  0 USDC entry, and tags it Ranked when it is not. */
export type TournamentKind = "casual" | "free" | "buyin";

export function kindOf(t: Pick<Tournament, "buy_in">): TournamentKind {
  // Empty/whitespace is checked before BigInt because `BigInt("")` is `0n`
  // rather than a throw — so a blank field would otherwise classify as a
  // *funded free event* and advertise a prize pool that doesn't exist.
  if (t.buy_in == null || t.buy_in.trim() === "") return "casual";
  try {
    return BigInt(t.buy_in) > 0n ? "buyin" : "free";
  } catch {
    return "casual"; // unparseable: treat as no pool rather than throw in a render
  }
}

/** Only a paid entry moves ranked Elo — the server's `tournament_ladder` rule.
 *  A free event pays real USDC but risks nothing, so it counts as casual. */
export const isRanked = (t: Pick<Tournament, "buy_in">): boolean => kindOf(t) === "buyin";

/** Is there prize money at all (whoever funded it)? */
export const hasPrizePool = (t: Pick<Tournament, "buy_in">): boolean => kindOf(t) !== "casual";

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
      : players.map((player, i) => ({
          player,
          score: 0,
          played: 0,
          rank: i + 1,
          tied: players.length > 1,
          bot: false,
        })),
    current_round: view.current_round ?? 0,
    total_rounds: view.total_rounds ?? 0,
    initial_secs: view.initial_secs ?? 0,
    increment_secs: view.increment_secs ?? 0,
    organizer: view.organizer ?? null,
    // A server that predates creator-defined structures paid the old hardcoded
    // 65/25/10, which is what this default is — so the label a pre-deploy client
    // shows is still the truth about how that tournament settles.
    payout:
      view.payout && Array.isArray(view.payout.bps) && view.payout.bps.length > 0
        ? view.payout
        : DEFAULT_PAYOUT,
    // Never synthesized: an invented prize column would be a number the contract
    // has no intention of sending. Absent means "don't show one".
    prizes: Array.isArray(view.prizes) ? view.prizes : [],
    pool: view.pool ?? null,
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
