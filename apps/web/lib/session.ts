// How a request presents the SIWE session to the game server.
//
// The session is an httpOnly cookie the server sets (crates/server/src/auth.rs),
// so no script on this page can read it — an XSS can no longer lift a session
// and stake its wallet's escrow balance from somewhere else. That means this
// file never holds a credential. What the browser keeps in localStorage is only
// a MARKER (`openchess.addr`, the wallet the session was issued for), which is
// what the UI keys "signed in" off.
//
// The cookie is SameSite=Strict on the API host, so it only rides along when
// the API is on the same SITE as this page (api.openchess.ai beside
// openchess.ai). From a cross-site API it is a third-party cookie, Safari drops
// it, and sign-in fails loudly (lib/siwe.ts checks) — see SECURITY.md.

import { SERVER_HTTP } from "./config";
import { clearKey, readMigrated } from "./storage";

/** Sent with every request the page means to be signed in. The server honours
 *  the cookie only alongside it (CSRF: a cross-site form can't add a custom
 *  header), and treats it as "I am presenting a credential", so a cookie that
 *  expired or never stuck is a 401 the client self-heals on rather than a
 *  silent downgrade to anonymous. Must match `auth::SESSION_HEADER`. */
export const SESSION_HEADER = "x-openchess-session";

/** Request options that present the cookie session: `credentials: "include"`
 *  (a cross-origin fetch sends no cookies otherwise) plus the session header.
 *  Never a bearer — the page has no token to send. */
export function withSession(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set(SESSION_HEADER, "1");
  return { ...init, headers, credentials: "include" };
}

/** A bearer token left in localStorage by a version of the app that stored
 *  sessions there (current or pre-namespace key; `readMigrated` adopts the
 *  latter). Nothing writes one any more: `adoptLegacySession` trades it for the
 *  cookie once and deletes it. Read only for that migration. */
export function legacyBearer(): string | null {
  return readMigrated("token");
}

/** End the session on the server — the page can't delete an httpOnly cookie,
 *  and before this a sign-out left the session live for the rest of its 24h.
 *  Fire-and-forget: a sign-out must never wait on, or fail because of, the
 *  network. `keepalive` lets it finish if the sign-out is followed by a
 *  navigation or a reload.
 *
 *  Only ever revokes the session the request carries, and the server sends no
 *  clearing `Set-Cookie`, so a sign-in racing this (an account switch) keeps
 *  its new cookie. */
export function revokeSession(): void {
  if (typeof window === "undefined" || typeof fetch !== "function") return;
  const bearer = legacyBearer();
  const init = bearer
    ? { method: "POST", headers: { authorization: `Bearer ${bearer}` } }
    : withSession({ method: "POST" });
  try {
    fetch(`${SERVER_HTTP}/auth/logout`, { ...init, keepalive: true }).catch(() => {});
  } catch {
    /* a sign-out never throws */
  }
}

/** Drop the legacy bearer from storage (both key names). */
export function forgetLegacyBearer(): void {
  clearKey("token");
}
