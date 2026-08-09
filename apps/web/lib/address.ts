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

/** A type predicate, not just a boolean: callers guard with it and then
 *  interpolate the value into a URL, so it has to narrow away null/undefined
 *  the way the hand-written `!addr || !ADDR_RE.test(addr)` checks it replaced
 *  used to. */
export function isAddress(a?: string | null): a is string {
  return !!a && ADDR_RE.test(a);
}

/** A username's SHAPE: 3–20 of `[A-Za-z0-9_]`. Mirrors the server's grammar
 *  (`crates/server/src/username.rs`), which is the enforcer — this copy exists
 *  so the browser can gate a route and give instant feedback without a round
 *  trip, the same contract `AVATAR_MAX_BYTES` has with the upload limit. */
export const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

/** Whether `s` could be a username, for routing and for validating a lookup
 *  before it is interpolated into a URL.
 *
 *  Two things to keep. It rejects a leading `0x`, because `/player/[ident]`
 *  resolves EITHER form and a name that looks like an address is unresolvable
 *  ambiguity there (and a lookalike squat next to a real wallet). And it
 *  deliberately does NOT consult the reserved-word list that `validateUsername`
 *  uses: a name the server issued before a word was added to that list must
 *  still resolve, or the route 404s a live profile that the server is happily
 *  serving. Keep the two predicates separate — collapsing them into one breaks
 *  routing rather than validation, which is the harder failure to spot.
 *
 *  Lives here beside `isAddress` on purpose: this module has no imports, so a
 *  Server Component (`app/player/[ident]/layout.tsx`) can call it. The rest of
 *  the username rules live in `lib/username.ts`, which cannot. */
export function isUsernameShape(s?: string | null): s is string {
  return !!s && USERNAME_RE.test(s) && !/^0x/i.test(s);
}
