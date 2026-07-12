/** Truncate an EVM address for display, e.g. `0x1234…abcd`. Returns `fallback`
 *  (default "") for a nullish/empty address. Single source for the several
 *  places that show a shortened wallet (lobby, profiles, leaderboard, oracle). */
export function shortAddress(a?: string | null, fallback = ""): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : fallback;
}
