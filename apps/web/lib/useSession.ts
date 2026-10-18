"use client";

import { useEffect, useState } from "react";

import { adoptLegacySession } from "./authedFetch";
import { AUTH_EVENT, authAddress } from "./escrow";

/** The wallet this browser holds a SIWE session for (lowercased), or null —
 *  reactive to sign-in / sign-out and cross-tab changes. Consumers use this
 *  instead of snapshotting authAddress() into their own state, so a sign-in
 *  completed elsewhere (e.g. the header AuthButton's auto-SIWE) or a session
 *  cleared on account switch propagates immediately — no stale "sign in to
 *  stake" errors or dead pairing codes until reload.
 *
 *  The value is a marker, never a credential: the session is an httpOnly
 *  cookie this page can't read (lib/session.ts). Use it to decide what to
 *  render; use `authedFetch` to actually be signed in. */
export function useSession(): string | null {
  const [wallet, setWallet] = useState<string | null>(null);
  useEffect(() => {
    const sync = () => setWallet(authAddress());
    sync();
    // Trade any localStorage bearer an older version left behind for the
    // cookie now, rather than waiting for the first authed call — until then a
    // script on the page could still read it.
    void adoptLegacySession();
    window.addEventListener(AUTH_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(AUTH_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return wallet;
}
