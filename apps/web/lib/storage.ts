// Every localStorage key this app owns, in one place.
//
// The names are namespaced `openchess.*` so they're identifiable in devtools
// and can't collide with anything else on the origin. Four keys predate that
// convention (`chess_token`, `chess_addr`, `bot_uci_options`,
// `browser_bot_config`); `readMigrated` moves a returning visitor's value to
// the new name on first read rather than silently abandoning it — which for
// the auth pair would have signed out every signed-in user on deploy.
//
// Not listed here: the opening book, which lives in IndexedDB (see
// lib/browserBot.ts), not localStorage.

export const KEYS = {
  /** SIWE session token. */
  token: "openchess.token",
  /** Wallet the stored session was issued for (lowercased). */
  addr: "openchess.addr",
  /** UCI option overrides relayed to a connected agent. */
  botOptions: "openchess.botOptions",
  /** In-browser bot config (name, book depth, repertoire, time policy). */
  browserBot: "openchess.browserBot",
  /** Board/piece theme + display prefs. */
  board: "openchess.board",
  /** Eval-bar on/off. */
  evalBar: "openchess.evalBar",
  /** Skip the pre-game confirm popup. */
  autoAccept: "openchess.autoAccept",
  /** Per-tournament casual display name. */
  tournamentIdentity: "openchess.tournamentIdentity",
  /** Tournaments this browser has sponsored, per wallet — the only way to
   *  rediscover a sponsorship, since the server never sees one. */
  sponsored: "openchess.sponsored",
} as const;

/** Pre-namespace names, kept only so `readMigrated` can rescue their values.
 *  Nothing writes these. */
const LEGACY: Partial<Record<keyof typeof KEYS, string>> = {
  token: "chess_token",
  addr: "chess_addr",
  botOptions: "bot_uci_options",
  browserBot: "browser_bot_config",
};

/** Read a key, adopting (and clearing) its pre-namespace value on first read.
 *
 *  Deliberately migrates on READ rather than in a one-shot startup pass: the
 *  reader is the only place that knows the value still matters, and a startup
 *  sweep would have to run before any consumer — including the pre-paint theme
 *  bootstrap, which is inline in <head> and reads storage directly.
 *
 *  Returns null when neither name is present, so callers keep their own
 *  defaults. Safe on the server (returns null) and with storage disabled. */
export function readMigrated(key: keyof typeof KEYS): string | null {
  if (typeof window === "undefined") return null;
  try {
    const current = window.localStorage.getItem(KEYS[key]);
    if (current !== null) return current;
    const legacy = LEGACY[key];
    if (!legacy) return null;
    const old = window.localStorage.getItem(legacy);
    if (old === null) return null;
    // Adopt, then drop the old name: a half-migrated pair (new token, legacy
    // address) is what would strand a session as "signed in as nobody".
    window.localStorage.setItem(KEYS[key], old);
    window.localStorage.removeItem(legacy);
    return old;
  } catch {
    // Private mode / storage disabled — callers fall back to their defaults.
    return null;
  }
}

/** Write, ignoring a storage failure (private mode): a preference that can't
 *  persist still applies for the session. */
export function writeKey(key: keyof typeof KEYS, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEYS[key], value);
  } catch {
    /* ignore */
  }
}

/** Remove a key under both its current and legacy names — a sign-out must not
 *  leave the pre-namespace copy behind for `readMigrated` to resurrect. */
export function clearKey(key: keyof typeof KEYS) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEYS[key]);
    const legacy = LEGACY[key];
    if (legacy) window.localStorage.removeItem(legacy);
  } catch {
    /* ignore */
  }
}
