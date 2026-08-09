// Verify the casual/ranked split on the profile. Two mistakes here are silent
// and wrong in the same direction: classifying a buy-in tournament game by its
// (absent) stake files a paid, ranked game under casual, and reading the split
// off a server that predates it would show three identical views — or, worse,
// three empty ones — the day the web app deploys ahead of the server, which is
// the normal order here.
import {
  bucketOf,
  gamesQuery,
  hasBuckets,
  pickStats,
  winRate,
  type GameItem,
  type Profile,
} from "../lib/profileFilter";

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`,
  );
}

const game = (o: Partial<GameItem>): GameItem => ({
  game_id: "g1",
  mode: "park",
  white: "0xa",
  black: "0xb",
  result: "white",
  reason: "checkmate",
  stake: null,
  moves: 40,
  finished_at: "2026-08-09T00:00:00Z",
  ...o,
});

const bucket = (o: Partial<Profile>) => ({ games: 0, wins: 0, losses: 0, draws: 0, net: "0", ...o });

const profile = (o: Partial<Profile>): Profile => ({
  address: "0xa",
  rating: 1500,
  games: 0,
  wins: 0,
  losses: 0,
  draws: 0,
  net: "0",
  avatar_updated_at: null,
  ...o,
});

// --- the case this exists for: ranked is not "has a stake" ---
check("a buy-in tournament game is ranked with no stake", bucketOf(game({ mode: "tournament", stake: null, rated: true })), "ranked");
check("a staked game is ranked", bucketOf(game({ stake: "1000000", rated: true })), "ranked");
check("a free game is casual", bucketOf(game({ stake: null, rated: false })), "casual");

// --- old server: no `rated` on the wire, fall back to the stake ---
check("legacy staked → ranked", bucketOf(game({ stake: "1000000" })), "ranked");
check("legacy free → casual", bucketOf(game({ stake: null })), "casual");
check("legacy zero stake → casual", bucketOf(game({ stake: "0" })), "casual");

// --- the buckets ---
const split = profile({
  rating: 1610,
  casual_rating: 1480,
  games: 5,
  wins: 3,
  losses: 1,
  draws: 1,
  net: "2500000",
  casual: bucket({ games: 3, wins: 2, draws: 1, net: "0" }),
  ranked: bucket({ games: 2, wins: 1, losses: 1, net: "2500000" }),
});
check("all reads the flat fields", pickStats(split, "all").games, 5);
check("casual reads its own bucket", pickStats(split, "casual").games, 3);
check("ranked reads its own bucket", pickStats(split, "ranked").wins, 1);
check("the two buckets sum to all", pickStats(split, "casual").games + pickStats(split, "ranked").games, pickStats(split, "all").games);
check("casual stakes nothing", pickStats(split, "casual").net, "0");

// --- both ratings ride on the profile; the header renders them side by side ---
check("ranked Elo", split.rating, 1610);
check("casual Elo", split.casual_rating, 1480);

// --- old server: every view degrades to the single record it used to show ---
const legacy = profile({ rating: 1520, games: 4, wins: 2, losses: 2, net: "0" });
check("no buckets → no switcher", hasBuckets(legacy), false);
check("split response → switcher", hasBuckets(split), true);
check("null profile → no switcher", hasBuckets(null), false);
for (const b of ["all", "casual", "ranked"] as const) {
  check(`legacy ${b} falls back to the combined record`, pickStats(legacy, b).games, 4);
}
check("legacy sends no casual Elo, so the tile is hidden", legacy.casual_rating, undefined);

// --- win rate ---
check("win rate rounds", winRate(bucket({ games: 3, wins: 2 })), 67);
check("no games is 0%, not NaN", winRate(bucket({ games: 0, wins: 0 })), 0);

// --- the history query: never send `?filter=` for All ---
check("all sends no param", gamesQuery("all"), "");
check("casual filters", gamesQuery("casual"), "?filter=casual");
check("ranked filters", gamesQuery("ranked"), "?filter=ranked");

console.log(failed === 0 ? "\nall profile-split tests passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
