"use client";

import { useDynamicContext, useIsLoggedIn } from "@dynamic-labs/sdk-react-core";
import { useCallback, useEffect, useRef, useState } from "react";

import { clearAuth } from "./escrow";

const ESCAPE_HATCH_DELAY_MS = 5_000;
// Deliberately generous. `isLoggedIn` can read true off hydrated user/wallet
// state before the SDK finishes its settings/session round-trips, which on a
// slow mobile connection is indistinguishable from a genuine wedge — and this
// timer LOGS THE USER OUT (redo email OTP). The 5s manual escape hatch already
// covers anyone actually stuck; the auto-logout is only for people who don't
// click it, so it can afford to wait long enough not to guillotine a session
// that was one round-trip from recovering.
const AUTO_LOGOUT_DELAY_MS = 30_000;

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
 *  hatch, after 30s (see AUTO_LOGOUT_DELAY_MS) we log out for them, and if even
 *  that throws we clear Dynamic's own storage keys plus our session and reload. */
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
      // Drop our own SIWE session too. Leaving it behind reloads into a header
      // showing "Sign in" (no wallet) while authed consumers still hold a live
      // token bound to the wallet we just cleared — a split-brain state.
      clearAuth();
    } catch {
      // localStorage can be unavailable (private mode, blocked cookies); the
      // reload below is still worth attempting.
    }
    window.location.reload();
  }, []);

  // NOTE: this must stay on plain `clearAuth`, never lib/escrow's explicit
  // sign-out announcer — the 30s auto-logout timer below invokes this same
  // function with no user behind it, and the explicit-sign-out event retracts
  // RequireSignIn's admission latch (unmounting whatever lives under it). The
  // escape-hatch BUTTON's onClick in AuthButton is where the announcement
  // belongs; test:gate greps this file to keep it out of here.
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

  // `showEscapeHatch` is only ever true while stale — the effect above clears it
  // the moment the session recovers — so it doubles as the "is this wedged"
  // signal and callers need nothing else.
  return { showEscapeHatch, manualLogout };
}
