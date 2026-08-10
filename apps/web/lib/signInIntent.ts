"use client";

import { useSyncExternalStore } from "react";

/** Has the user asked to sign in, THIS page-load?
 *
 *  This exists to keep wallet prompts behind a user gesture. Dynamic restores an
 *  external wallet's connection silently on load (an `eth_accounts` read, no
 *  popup) — but our SIWE session dies far more often than the connection does
 *  (24h TTL, every server redeploy voids it, `authedFetch` drops it on a 401),
 *  so "connected, no token" is the NORMAL state for a returning visitor. The
 *  header's auto-complete effect used to answer that state by calling
 *  `runSignIn()` on mount, which fires a `personal_sign` popup out of the wallet
 *  extension the moment the page loads, before the user has clicked anything.
 *
 *  The rule now: the auto-complete effect only runs once one of the explicit
 *  Sign in controls (header AuthButton, the SignInGate wall) has been clicked in
 *  this page's lifetime. A click flows straight into connect → chain switch →
 *  SIWE with no second click needed; a load without one shows "Finish sign-in"
 *  and prompts nothing.
 *
 *  Deliberately a module-level value and NOT persisted: a fresh page-load must
 *  start with no intent, because "the user clicked sign-in yesterday" is exactly
 *  the kind of stale consent that turns back into a popup-on-load.
 *
 *  It is a monotonically increasing counter rather than a boolean so each click
 *  is distinguishable: a rejected signature must not loop (same count, same
 *  address ⇒ one attempt), while clicking Sign in again is a real retry (new
 *  count ⇒ new attempt). */
let intentCount = 0;

const INTENT_EVENT = "openchess:sign-in-intent";

/** Record an explicit sign-in gesture. Call from click handlers ONLY.
 *
 *  Returns the new count so a handler that ALSO starts the sign-in itself can
 *  claim this gesture's attempt key up front — without that, the auto-complete
 *  effect (which skips while the sign-in is busy) would find the gesture
 *  unclaimed after a rejected signature and fire a second prompt. */
export function markSignInIntent(): number {
  intentCount += 1;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(INTENT_EVENT));
  return intentCount;
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(INTENT_EVENT, cb);
  return () => window.removeEventListener(INTENT_EVENT, cb);
}

const getSnapshot = () => intentCount;
// The server never has a gesture — and localStorage isn't involved, so this is
// honest rather than a hydration dodge.
const getServerSnapshot = () => 0;

/** Reactive view of the counter: 0 = no gesture yet this page-load. */
export function useSignInIntent(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
