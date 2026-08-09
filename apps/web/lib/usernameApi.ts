"use client";

// Talking to the username routes. The rules themselves are in `lib/username.ts`
// (pure, testable, and server-safe enough to be imported by the profile route's
// metadata); this half is the transport.

import { SERVER_HTTP } from "./config";
import { authedFetch } from "./authedFetch";
import { usernameFailure, type UsernameErrorBody } from "./username";

/** Fired after the signed-in wallet's username changes.
 *
 *  Same shape and reason as `AVATAR_EVENT`: the handle renders in the header's
 *  account chip and in the profile head, which never meet in the React tree, so
 *  without a signal the header shows the old name until a reload. */
export const USERNAME_EVENT = "chess:username";

/** Claim or change the signed-in wallet's username.
 *
 *  The wallet comes from the SIWE session — there is no address in the body, the
 *  same rule `uploadAvatar` and the money paths follow. Resolves with the
 *  STORED name, which may differ in case from what was sent (the server is
 *  authoritative about display case, and a case-only edit is free). */
export async function setUsername(name: string): Promise<string> {
  const res = await authedFetch(`${SERVER_HTTP}/profile/username`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: name }),
  });
  if (!res.ok) {
    // Defensive: the per-IP throttle layer answers in plain text, not JSON, so
    // a body parse must never be what turns a 429 into an unhandled crash.
    const body = (await res.json().catch(() => null)) as UsernameErrorBody | null;
    throw new Error(usernameFailure(res.status, body));
  }
  const out = (await res.json().catch(() => null)) as { username?: string } | null;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(USERNAME_EVENT));
  return out?.username ?? name;
}

/** Whether a username is free.
 *
 *  Reuses `GET /players/{ident}`, which already answers this: 404 = nobody holds
 *  it, 200 = somebody does. No dedicated endpoint, and it inherits the read
 *  throttle the profile route already carries.
 *
 *  ADVISORY ONLY. Somebody can claim the name between this probe and the submit,
 *  so the 409 branch in `setUsername` is live code — do not delete it as
 *  unreachable because this said the name was free. */
export async function checkAvailable(name: string, signal?: AbortSignal): Promise<boolean> {
  const res = await fetch(`${SERVER_HTTP}/players/${encodeURIComponent(name)}`, { signal });
  return res.status === 404;
}

/** One prefix-search hit from `GET /players/search`. */
export type PlayerHit = {
  username: string;
  address: string;
  rating: number;
  avatar_updated_at: string | null;
};

/** Players whose username starts with `q`.
 *
 *  A plain `fetch`, not `authedFetch`: this is a public read and has to work
 *  signed out. Returns `[]` on any failure — a typeahead that throws
 *  mid-keystroke is worse than one that shows nothing, and the server takes the
 *  same view (it answers `[]` rather than 400 for a query it won't run). */
export async function searchPlayers(q: string, signal?: AbortSignal): Promise<PlayerHit[]> {
  try {
    const res = await fetch(`${SERVER_HTTP}/players/search?q=${encodeURIComponent(q)}`, { signal });
    if (!res.ok) return [];
    const hits = await res.json();
    return Array.isArray(hits) ? (hits as PlayerHit[]) : [];
  } catch {
    return [];
  }
}
