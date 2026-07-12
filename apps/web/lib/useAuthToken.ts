"use client";

import { useEffect, useState } from "react";

import { AUTH_EVENT, authToken } from "./escrow";

/** The current SIWE session token, reactive to sign-in / sign-out and cross-tab
 *  changes. Consumers use this instead of snapshotting authToken() into their
 *  own state, so a sign-in completed elsewhere (e.g. the header AuthButton's
 *  auto-SIWE) or a session cleared on account switch propagates immediately —
 *  no stale "sign in to stake" errors or dead pairing codes until reload. */
export function useAuthToken(): string | null {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    const sync = () => setToken(authToken());
    sync();
    window.addEventListener(AUTH_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(AUTH_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return token;
}
