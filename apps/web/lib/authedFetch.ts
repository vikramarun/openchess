"use client";

import { authToken, clearAuth } from "./escrow";

/** `fetch` with the stored SIWE session attached, self-healing when it expires.
 *
 *  Sessions live in the server's process memory with a 24h TTL, so **every**
 *  restart — every deploy — voids them while the browser still holds the token.
 *  The server rejects a stale bearer with 401 rather than quietly treating the
 *  caller as anonymous, and it has to: an authenticated poster showing up as
 *  anonymous is what broke the bot self-match guards.
 *
 *  Unhandled, that surfaced as a dead-end `Couldn't post the game (401)` that
 *  nothing but a manual sign-out could clear — and it would have hit every
 *  returning user the day after a deploy, which is exactly when a launch is
 *  trying to bring people back.
 *
 *  Dropping the dead token here makes it self-healing: `clearAuth` fires the
 *  auth event, `useAuthToken` re-renders as signed-out, and the sign-in button
 *  reappears without a reload. Callers still get the 401 so they can say what
 *  happened rather than failing silently. */
export async function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = authToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  // Only when we actually presented a credential. A 401 with no token means the
  // route requires sign-in — the user was never signed in, so there is nothing
  // to clear and clearing would fire a pointless auth event.
  if (res.status === 401 && token) clearAuth();
  return res;
}

/** Message for a rejected session, so every caller says the same thing and it
 *  points at the fix instead of showing a bare status code. */
export const SESSION_EXPIRED = "Your session expired — sign in again to continue.";
