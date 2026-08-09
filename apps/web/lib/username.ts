// The username rules the editor enforces, and what to say when the server
// refuses one.
//
// The SHAPE check and the regex live in `lib/address.ts` beside `isAddress`,
// because a Server Component (`app/player/[ident]/layout.tsx`) has to call them
// and this module imports one that cannot be reached from the server. Everything
// here is still pure — no DOM, no fetch — so `pnpm test:username` imports it
// statically instead of stubbing globals.
//
// The server is the enforcer (`crates/server/src/username.rs` +
// `users_username_lower_uidx`). This mirror exists to answer instantly while
// someone types.

import { SESSION_EXPIRED } from "./authedFetch";
import { isUsernameShape, USERNAME_RE } from "./address";

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;
/** Days between allowed changes. Claiming a name starts the clock too. */
export const USERNAME_COOLDOWN_DAYS = 7;

/** Names nobody may hold.
 *
 *  Hand-synced with `RESERVED` in `crates/server/src/username.rs`. Divergence
 *  fails SOFT and in the safe direction: a word only here refuses a name the
 *  server would allow, and a word only there is caught at submit and rendered
 *  from the server's own answer. Neither lets a reserved name through. */
const RESERVED = new Set([
  "admin",
  "administrator",
  "moderator",
  "mod",
  "staff",
  "official",
  "system",
  "support",
  "oracle",
  "root",
  "openchess",
  "house",
  "housebot",
  "anonymous",
  "null",
  "undefined",
  "none",
  "me",
  "search",
]);

export type UsernameCheck = { ok: true } | { ok: false; error: string };

/** Validate a username for the editor: shape, then `0x`, then reserved.
 *
 *  Ordered so the most useful message wins — a two-character string with a dash
 *  in it is told about the length first, because that is the thing they have to
 *  fix before the charset even matters.
 *
 *  Note this is STRICTER than `isUsernameShape`, which routing uses. See the
 *  comment on that function for why the two must not be merged. */
export function validateUsername(s: string): UsernameCheck {
  if (s.length < USERNAME_MIN || s.length > USERNAME_MAX) {
    return { ok: false, error: `Usernames are ${USERNAME_MIN}–${USERNAME_MAX} characters.` };
  }
  if (!USERNAME_RE.test(s)) {
    return {
      ok: false,
      error: "Letters, numbers and underscores only — no spaces or punctuation.",
    };
  }
  if (!isUsernameShape(s)) {
    return {
      ok: false,
      error: "A username can’t start with 0x — that’s how wallet addresses are written.",
    };
  }
  if (RESERVED.has(s.toLowerCase())) return { ok: false, error: "That username is reserved." };
  return { ok: true };
}

/** Whole days from `now` until `iso`, rounded up, never negative. */
export function daysUntil(iso: string, now: number = Date.now()): number {
  const ms = new Date(iso).getTime() - now;
  return ms <= 0 ? 0 : Math.ceil(ms / 86_400_000);
}

/** How long until this wallet may rename again.
 *
 *  Deliberately locale-free. `toLocaleDateString` inside a pure module makes the
 *  `tsx` harness flaky — its only comparator is `JSON.stringify` equality, and
 *  Node's ICU data varies. The component appends the absolute date for the user;
 *  this is the part that has to be assertable. */
export function cooldownMessage(iso: string, now: number = Date.now()): string {
  const d = daysUntil(iso, now);
  if (d === 0) return "You can change your username again today.";
  if (d === 1) return "You can change your username again tomorrow.";
  return `You can change your username again in ${d} days.`;
}

/** The error body `PUT /profile/username` returns alongside a refusal.
 *
 *  `reason` narrows an `invalid`: "length" | "charset" | "reserved" |
 *  "address_shape" (`UsernameError::code` server-side). */
export type UsernameErrorBody = {
  error?: string;
  reason?: string;
  next_change_at?: string | null;
};

/** What to tell the user when a username write is refused.
 *
 *  Keyed on the body's `error` code FIRST and the status second, and that
 *  ordering is the point. The server answers a cooldown with 403 rather than 429
 *  precisely because this router already has two different 429s (the per-IP
 *  layer's plain-text one and the per-wallet bucket's) — but a bare 403 with no
 *  body is still not a cooldown, and must not be reported as one. Reading the
 *  code makes that impossible rather than merely unlikely. */
export function usernameFailure(
  status: number,
  body?: UsernameErrorBody | null,
  now: number = Date.now(),
): string {
  if (body?.error === "cooldown" && body.next_change_at) {
    return cooldownMessage(body.next_change_at, now);
  }
  if (body?.error === "taken" || status === 409) return "That username is already taken.";
  if (body?.reason === "reserved") return "That username is reserved.";
  if (body?.error === "invalid" || status === 400 || status === 422) {
    return `That username isn’t allowed. Use ${USERNAME_MIN}–${USERNAME_MAX} letters, numbers or underscores.`;
  }
  if (status === 401) return SESSION_EXPIRED;
  if (status === 429) return "Too many tries. Wait a moment and try again.";
  if (status === 503) return "The server can’t change usernames right now.";
  return `Couldn’t save your username (${status}).`;
}
