/** Splitting a profile into its two ladders.
 *
 *  A game is RANKED when money was on it — a USDC stake, or a pairing in a
 *  tournament that charged a buy-in — and CASUAL otherwise. The two move
 *  independent Elo ratings, so the profile shows them apart.
 *
 *  All of it is pure and lives here rather than in the component for two
 *  reasons. It has to be testable without a DOM (`pnpm test:profile`), and it
 *  has to degrade: the server that serves the buckets is deployed separately
 *  from this app (`./scripts/deploy-server.sh`, never the Vercel merge), so
 *  there is a guaranteed window where a new page talks to an old server. Every
 *  function below answers correctly when the new fields simply aren't there. */

export type Bucket = "all" | "casual" | "ranked";

/** The order the switcher shows them in, All first. */
export const BUCKETS: { id: Bucket; label: string }[] = [
  { id: "all", label: "All" },
  { id: "casual", label: "Casual" },
  { id: "ranked", label: "Ranked" },
];

export type StatBucket = {
  games: number;
  wins: number;
  losses: number;
  draws: number;
  /** Net USDC in base units, signed. Always "0" for casual — free games stake nothing. */
  net: string;
};

export type Profile = StatBucket & {
  address: string;
  /** Ranked Elo. */
  rating: number;
  /** Casual Elo. Absent from a server that predates the split. */
  casual_rating?: number;
  avatar_updated_at: string | null;
  casual?: StatBucket;
  ranked?: StatBucket;
};

export type GameItem = {
  game_id: string;
  mode: string;
  white: string | null;
  black: string | null;
  result: string | null;
  reason: string | null;
  stake: string | null;
  /** Absent from a server that predates the split — see `bucketOf`. */
  rated?: boolean;
  moves: number;
  finished_at: string | null;
};

const ZERO: StatBucket = { games: 0, wins: 0, losses: 0, draws: 0, net: "0" };

/** Which ladder a game counted for.
 *
 *  Prefers the server's own flag and only falls back to the stake, because the
 *  two disagree on exactly the case this split exists for: a buy-in tournament
 *  game is ranked while carrying no stake of its own. The fallback is for an
 *  old server, where that flag doesn't exist and a stake is the best guess
 *  available. */
export function bucketOf(g: { rated?: boolean; stake: string | null }): "casual" | "ranked" {
  const ranked = g.rated ?? (g.stake != null && g.stake !== "0");
  return ranked ? "ranked" : "casual";
}

/** Does this response actually carry the split? False for an old server, which
 *  is what hides the switcher rather than showing three identical views. */
export function hasBuckets(p: Profile | null): boolean {
  return Boolean(p && p.casual && p.ranked);
}

/** The record for one bucket.
 *
 *  `all` reads the flat top-level fields, which predate the split and still
 *  mean "both ladders combined" — so an old server, which has nothing else,
 *  lands on exactly the numbers it always showed. */
export function pickStats(p: Profile | null, bucket: Bucket): StatBucket {
  if (!p) return ZERO;
  const flat: StatBucket = {
    games: p.games,
    wins: p.wins,
    losses: p.losses,
    draws: p.draws,
    net: p.net,
  };
  if (bucket === "all") return flat;
  return p[bucket] ?? flat;
}

/** Win percentage, rounded. Zero games is 0%, never NaN. */
export function winRate(s: StatBucket): number {
  return s.games > 0 ? Math.round((s.wins / s.games) * 100) : 0;
}

/** Query string for the history fetch. Empty for "all" so a server that
 *  predates the parameter is never sent one. */
export function gamesQuery(bucket: Bucket): string {
  return bucket === "all" ? "" : `?filter=${bucket}`;
}
