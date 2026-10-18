"use client";

import { SERVER_HTTP } from "./config";
import { authAddress, clearAuth } from "./escrow";
import { forgetLegacyBearer, legacyBearer, withSession } from "./session";

/** `fetch` presenting the SIWE session, self-healing when it expires.
 *
 *  The session is an httpOnly cookie (lib/session.ts); this attaches it
 *  (`credentials: "include"` + the session header) whenever the page believes
 *  it is signed in, and sends nothing otherwise.
 *
 *  Sessions live in the server's process memory with a 24h TTL, so **every**
 *  restart — every deploy — voids them while the browser still believes it is
 *  signed in. The server rejects a dead session with 401 rather than quietly
 *  treating the caller as anonymous, and it has to: an authenticated poster
 *  showing up as anonymous is what broke the bot self-match guards.
 *
 *  Unhandled, that surfaced as a dead-end `Couldn't post the game (401)` that
 *  nothing but a manual sign-out could clear — and it would have hit every
 *  returning user the day after a deploy, which is exactly when a launch is
 *  trying to bring people back.
 *
 *  Dropping the dead session here makes it self-healing: `clearAuth` fires the
 *  auth event, `useSession` re-renders as signed-out, and the sign-in button
 *  reappears without a reload. Callers still get the 401 so they can say what
 *  happened rather than failing silently. */
export async function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  // A bearer an older version left in localStorage is traded for the cookie
  // first; until that succeeds it is still what this browser authenticates
  // with, so a returning visitor is never signed out by the migration.
  await adoptLegacySession();
  const bearer = legacyBearer();
  const signedIn = !!bearer || !!authAddress();
  let req: RequestInit = init;
  if (bearer) {
    // Build through the Headers API rather than object spread: spreading a
    // `Headers` instance (or an array of pairs) yields `{}` and silently drops
    // every caller-supplied header.
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${bearer}`);
    req = { ...init, headers };
  } else if (signedIn) {
    req = withSession(init);
  }
  const res = await fetch(url, req);
  // Only when we actually presented a credential. A 401 with none means the
  // route requires sign-in — the user was never signed in, so there is nothing
  // to clear and clearing would fire a pointless auth event.
  if (res.status === 401 && signedIn) clearAuth();
  return res;
}

let adopting: Promise<void> | null = null;

/** Move a localStorage bearer (what every version before the cookie stored)
 *  into the httpOnly cookie, then delete it — once, deduplicated across
 *  concurrent callers. A no-op for everyone without one.
 *
 *  The constraint is that nobody gets signed out by it:
 *  - adopted, and `/auth/me` confirms the cookie actually came back → the
 *    bearer is deleted and the cookie carries the same session;
 *  - adopted but the cookie didn't stick (a cross-site API, blocked cookies) →
 *    the bearer is KEPT and stays in use; deleting it would sign them out;
 *  - 401 → the session was dead anyway, so it is cleared exactly as any other
 *    401 is (that is today's deploy-day behaviour, not a new sign-out);
 *  - anything else (offline, 5xx, a server too old to have the route) → kept,
 *    and the next authed call tries again.
 *  Until it succeeds the bearer is still readable by script, which is the hole
 *  this closes; `useSession` runs it on mount so that window is one page load. */
export function adoptLegacySession(): Promise<void> {
  if (adopting) return adopting;
  const bearer = legacyBearer();
  if (!bearer) return Promise.resolve();
  adopting = (async () => {
    try {
      // A bearer with no wallet bound to it predates address binding and was
      // never treated as signed in; there is nothing to keep.
      if (!authAddress()) return forgetLegacyBearer();
      const r = await fetch(`${SERVER_HTTP}/auth/cookie`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}` },
        credentials: "include",
      });
      if (r.status === 401) return clearAuth();
      if (!r.ok) return;
      const me = await fetch(`${SERVER_HTTP}/auth/me`, withSession());
      if (me.ok) forgetLegacyBearer();
    } catch {
      /* offline: keep the bearer, retry on the next authed call */
    }
  })().finally(() => {
    // Here, not in the body's `finally`: a body that never awaits finishes
    // before `adopting` is assigned, and would clear it too early to matter
    // and leave a settled promise cached forever.
    adopting = null;
  });
  return adopting;
}

/** Message for a rejected session, so every caller says the same thing and it
 *  points at the fix instead of showing a bare status code. */
export const SESSION_EXPIRED = "Your session expired. Sign in again to continue.";
