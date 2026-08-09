/** Truncate an EVM address for display, e.g. `0x1234…abcd`. Returns `fallback`
 *  (default "") for a nullish/empty address. Single source for the several
 *  places that show a shortened wallet (lobby, profiles, leaderboard, oracle). */
export function shortAddress(a?: string | null, fallback = ""): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : fallback;
}

/** A lowercased EVM address. Callers interpolate route params into server API
 *  paths, so this is a validation gate and not only a display check — keep it
 *  strict, and lowercase before testing. */
const ADDR_RE = /^0x[0-9a-f]{40}$/;

export function isAddress(a?: string | null): boolean {
  return !!a && ADDR_RE.test(a);
}
