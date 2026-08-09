"use client";

import { useDynamicContext, useIsLoggedIn } from "@dynamic-labs/sdk-react-core";
import { useCallback, useEffect, useRef, useState } from "react";

const ESCAPE_HATCH_DELAY_MS = 5_000;
const AUTO_LOGOUT_DELAY_MS = 10_000;

/** Recovers from a Dynamic session that reports logged-in but never becomes
 *  usable. Two states do this, both seen in production in Superform's v2 app
 *  (src/domains/auth/hooks/useStaleAuthRecovery.ts, ported here):
 *
 *    1. `sdkHasLoaded` stays false while `isLoggedIn` is true.
 *    2. `sdkHasLoaded` is true but `user`/`primaryWallet` never resolve, which is
 *       what a stale token looks like.
 *
 *  Neither times out on its own, so without this the header sits on its loading
 *  placeholder forever and there is no way to sign out — the control that would
 *  let you recover is the one that never renders. After 5s we surface an escape
 *  hatch, after 10s we log out for them, and if even that throws we clear
 *  Dynamic's own storage keys and reload. */
export function useStaleAuthRecovery() {
  const { sdkHasLoaded, user, primaryWallet, handleLogOut, userWithMissingInfo } =
    useDynamicContext();
  const isLoggedIn = useIsLoggedIn();

  const [showEscapeHatch, setShowEscapeHatch] = useState(false);
  const escapeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoLogoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manualLogoutRef = useRef<(() => Promise<void>) | null>(null);

  // MFA legitimately parks the session in a half-resolved state, so treating it
  // as stale would log people out in the middle of verifying.
  const isMfaInProgress =
    userWithMissingInfo?.scope?.includes("requiresAdditionalAuth") ?? false;

  const isStaleAuth =
    isLoggedIn && !isMfaInProgress && (!sdkHasLoaded || (!user && !primaryWallet));

  const clearTimers = useCallback(() => {
    if (escapeTimer.current) {
      clearTimeout(escapeTimer.current);
      escapeTimer.current = null;
    }
    if (autoLogoutTimer.current) {
      clearTimeout(autoLogoutTimer.current);
      autoLogoutTimer.current = null;
    }
  }, []);

  const forceClearAndReload = useCallback(() => {
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith("dynamic_") || k.startsWith("dyn_"))
        .forEach((k) => localStorage.removeItem(k));
    } catch {
      // localStorage can be unavailable (private mode, blocked cookies); the
      // reload below is still worth attempting.
    }
    window.location.reload();
  }, []);

  const manualLogout = useCallback(async () => {
    clearTimers();
    try {
      await handleLogOut();
    } catch {
      forceClearAndReload();
    }
  }, [handleLogOut, forceClearAndReload, clearTimers]);

  // Keep the ref current so the timers always fire the latest closure without
  // restarting on every render.
  manualLogoutRef.current = manualLogout;

  useEffect(() => {
    if (!isStaleAuth) {
      clearTimers();
      setShowEscapeHatch(false);
      return;
    }
    if (!escapeTimer.current) {
      escapeTimer.current = setTimeout(() => setShowEscapeHatch(true), ESCAPE_HATCH_DELAY_MS);
    }
    if (!autoLogoutTimer.current) {
      autoLogoutTimer.current = setTimeout(
        () => manualLogoutRef.current?.(),
        AUTO_LOGOUT_DELAY_MS,
      );
    }
    return clearTimers;
  }, [isStaleAuth, clearTimers]);

  return { isStaleAuth, showEscapeHatch, manualLogout };
}
