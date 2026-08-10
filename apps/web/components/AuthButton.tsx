"use client";

import { DynamicUserProfile, useDynamicContext } from "@dynamic-labs/sdk-react-core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useAccountEffect } from "wagmi";

import { dynamicConfigured } from "@/lib/dynamicEnv";
import { authAddress, authToken, clearAuth } from "@/lib/escrow";
import { markSignInIntent, useSignInIntent } from "@/lib/signInIntent";
import { useAuthToken } from "@/lib/useAuthToken";
import { signInWithEthereum } from "@/lib/siwe";
import { playerLabel } from "@/lib/playerLabel";
import { usePlayerCard } from "@/lib/usePlayerCard";
import { useDynamicSigner } from "@/lib/useDynamicSigner";
import { useEnsureChain } from "@/lib/useEnsureChain";
import { useMounted } from "@/lib/useMounted";
import { useOnchainConfig } from "@/lib/useOnchainConfig";
import { useStaleAuthRecovery } from "@/lib/useStaleAuthRecovery";

/** Mount gate: the wagmi + Dynamic hooks live in AuthButtonInner, which only
 *  renders once the client-only provider tree (app/providers.tsx) is mounted.
 *
 *  It also gates on `dynamicConfigured`, because without an environment id
 *  providers.tsx omits DynamicContextProvider entirely and every Dynamic hook
 *  below would then read an undefined context and throw. */
export function AuthButton() {
  const mounted = useMounted();
  if (!mounted || !dynamicConfigured) return <div style={{ width: 1 }} />;
  return <AuthButtonInner />;
}

/** One button for the whole entry flow. Signing in opens Dynamic's modal — email
 *  and Google provision an embedded wallet, external wallets connect as before —
 *  and on a staked server the same click flows on into the Base chain switch and
 *  the SIWE signature. So there's a single "Sign in", never a separate connect +
 *  sign-in step. Every wallet prompt in that chain is downstream of the click:
 *  nothing here may prompt on page load (see lib/signInIntent.ts — a silently
 *  restored connection with no session shows "Finish sign-in" and waits). The
 *  session token is bound to the wallet it was issued for and cleared on
 *  disconnect / account switch. */
function AuthButtonInner() {
  // `useAccount().chainId` is the connector's REAL chain; `useChainId()` is
  // pinned to the configured list (prod: `[base]` only) and so can never report
  // a wrong network — which made the switch control below unreachable. See
  // useEnsureChain.
  const { address, isConnected, chainId } = useAccount();
  const ensureChain = useEnsureChain();
  const signMessageAsync = useDynamicSigner();
  const { setShowAuthFlow, setShowDynamicUserProfile, sdkHasLoaded } = useDynamicContext();
  const { showEscapeHatch, manualLogout } = useStaleAuthRecovery();

  const { config, wagerOn } = useOnchainConfig();
  const expected = config?.chainId ?? null;
  // The photo and handle this wallet set here, if any — one request for both,
  // since they come off the same `/players/{addr}` row. Both are what the user
  // chose *on this site*, which matters more now than it did: an email/Google
  // user has no ENS name or avatar to fall back on, so without a username the
  // chip has only the pawn glyph and a hex address to show them.
  const { photo, username } = usePlayerCard(address);
  // Derive sign-in from the reactive session token, NOT a local snapshot. The
  // token can be cleared out from under this component by authedFetch's 401
  // self-heal (a server redeploy voids every session) via `clearAuth()`, which
  // fires AUTH_EVENT — `useAuthToken` re-reads on it. A local `signedIn` state
  // set only on sign-in/disconnect would stay stuck "signed in" after such a
  // clear, so the chip would keep showing an account while every authed action
  // 401s, with no in-app way to re-sign. Reading the token here means the header
  // drops back to "Finish sign-in" the instant the session goes away.
  const authTok = useAuthToken();
  const signedIn = !!authTok && !!address && authAddress() === address.toLowerCase();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // How many times a Sign in control has been clicked this page-load (0 =
  // never). The auto-complete effect below is armed by this and by nothing
  // else — it is what keeps every wallet prompt behind a user gesture.
  const signInIntent = useSignInIntent();
  // Only auto-sign once per (gesture, address), so a rejected prompt doesn't
  // loop but clicking Sign in again is a real retry. Reset when the connected
  // account changes.
  const signTried = useRef<string | null>(null);
  // Latest connected address, readable from inside async callbacks.
  const addressRef = useRef(address);

  // On account change, drop a token that belongs to a different wallet OR a
  // legacy token with no bound address (pre-address-binding sessions) — both
  // force a clean re-sign for this wallet. `clearAuth` fires AUTH_EVENT, so the
  // derived `signedIn` above updates on its own; no local state to reset here.
  useEffect(() => {
    addressRef.current = address;
    const key = address?.toLowerCase() ?? null;
    if (key && authToken() && authAddress() !== key) clearAuth();
    signTried.current = null;
    setError(null);
  }, [address]);

  useAccountEffect({
    onDisconnect() {
      clearAuth(); // fires AUTH_EVENT → derived `signedIn` clears
    },
  });

  const runSignIn = useCallback(async () => {
    if (!address || expected == null) return;
    const signingFor = address.toLowerCase();
    setError(null);
    setBusy(true);
    try {
      // Bring the wallet to Base as part of sign-in. This is safe to do here
      // ONLY because runSignIn is now strictly downstream of a user gesture
      // (the intent gate on the auto-complete effect below, or a direct button
      // click) — the old version of this function auto-ran on page load, which
      // is why the switch used to be banned from it.
      //
      // Best-effort, not a precondition: SIWE is a `personal_sign` whose
      // `Chain ID` line carries the SERVER's expected chain, so the signature
      // verifies whatever network the wallet is on. A declined switch must not
      // cost the sign-in itself (no casual attribution, no tournament join,
      // over a chain a free player never needed) — the "Wrong network" nag
      // stays available, and every money write re-runs `ensureChain` itself
      // before it sends.
      //
      // Ordering matters: switch FIRST, then sign. `signMessageAsync` is
      // useDynamicSigner (built from primaryWallet.getWalletClient(), account
      // passed explicitly) precisely because wagmi's signer can throw
      // "Connector not connected" when asked to sign right after a switch.
      await ensureChain(expected).catch(() => {});
      await signInWithEthereum(address, expected, signMessageAsync);
      // The account may have switched while the signature was pending — never
      // keep a session for a wallet the token wasn't issued to. On success,
      // `signInWithEthereum` already called `setAuth` (which fires AUTH_EVENT),
      // so the derived `signedIn` flips true without a local setter.
      if (addressRef.current?.toLowerCase() !== signingFor) {
        clearAuth();
        return;
      }
    } catch (e: any) {
      // Dynamic swallows some connector-level failures, so log the raw error as
      // well as showing the short form — otherwise a wallet that silently
      // declines looks identical to one that never got the request.
      // eslint-disable-next-line no-console
      console.error("[auth] sign-in failed", e);
      setError(e?.shortMessage ?? e?.message ?? "sign-in failed");
    } finally {
      setBusy(false);
    }
  }, [address, expected, ensureChain, signMessageAsync]);

  const ready = isConnected && !!address && expected != null;

  // Complete sign-in once connected on a staked server — but ONLY downstream
  // of a Sign in click (`signInIntent`, lib/signInIntent.ts). This effect used
  // to run unconditionally, and that was the popup-on-load bug: Dynamic
  // restores an external wallet's connection silently, our SIWE session dies
  // daily (24h TTL, voided by every server redeploy, dropped by authedFetch on
  // a 401), so "connected, no token" is the normal returning-visitor state —
  // and this effect answered it by firing a `personal_sign` prompt out of the
  // wallet extension on every page load, before any click. Now that state just
  // renders the "Finish sign-in" button. The intent gate is also what makes
  // the chain switch inside `runSignIn` acceptable: everything this effect
  // triggers is part of a flow the user started.
  useEffect(() => {
    if (!signInIntent) return; // no gesture this page-load → never prompt
    if (!ready || !wagerOn || signedIn || busy) return;
    const key = `${signInIntent}:${address!.toLowerCase()}`;
    if (signTried.current === key) return;
    signTried.current = key;
    runSignIn();
  }, [signInIntent, ready, wagerOn, signedIn, busy, address, runSignIn]);

  // Dynamic says we're logged in but the session never became usable. This is
  // checked before `sdkHasLoaded` because it covers BOTH stuck states the hook
  // detects, and only one of them has the SDK still loading — in the other the
  // SDK is up but the user/wallet never resolve, which would otherwise render a
  // "Sign in" button that reopens the same broken session. `showEscapeHatch`
  // already implies staleness (the hook clears it as soon as the session
  // recovers), so it needs no second condition.
  if (showEscapeHatch) {
    return (
      <button className="wrong-net" onClick={() => manualLogout()}>
        Stuck? Sign out
      </button>
    );
  }

  // Dynamic is still booting. Nothing to show yet, and the branch above is what
  // stops this placeholder from being the whole header forever.
  if (!sdkHasLoaded) return <div style={{ width: 1 }} />;

  function control() {
    if (!isConnected || !address) {
      return (
        <button
          className="primary"
          onClick={() => {
            // The gesture that authorizes wallet prompts for the rest of this
            // page-load: connect (Dynamic's modal) → chain switch → SIWE all
            // flow from this one click, with no further clicks required.
            markSignInIntent();
            setShowAuthFlow(true);
          }}
        >
          Sign in
        </button>
      );
    }

    // Connected but the signed-in session isn't established yet.
    //
    // `config == null` counts as needing one, to agree with `useAuthState`,
    // which reads unknown config as the production truth (wagering on, session
    // required) and puts a sign-in wall on every gated route. Without that
    // clause the two disagree for exactly as long as `/config` is unreachable —
    // a hand-deployed server restart — and the visitor gets an account chip in
    // the header while the page under it says "Sign in to play". The button is
    // disabled until the config lands, because `runSignIn` needs a chain id for
    // the SIWE message and would otherwise be a control that does nothing.
    const needsSession = wagerOn || config == null;
    if (needsSession && !signedIn) {
      return (
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          {error && <span className="auth-err">{error}</span>}
          <button
            className="primary"
            disabled={busy || expected == null}
            onClick={() => {
              // A direct click IS the gesture — mark it so an account switch
              // later in this flow can auto-complete like the modal path does.
              // This handler starts the sign-in itself, so it must also CLAIM
              // the gesture's attempt key: the auto-complete effect skips while
              // `busy`, and an unclaimed key after a rejected signature would
              // make that effect fire a second prompt the user just declined.
              const gesture = markSignInIntent();
              signTried.current = `${gesture}:${address!.toLowerCase()}`;
              runSignIn();
            }}
          >
            {busy ? "Signing…" : expected == null ? "Connecting…" : "Finish sign-in"}
          </button>
        </span>
      );
    }

    // Signed in (or a casual server that needs no signature) → account chip.
    //
    // A wrong network is shown BESIDE the chip, never instead of it. This is the
    // only `setShowDynamicUserProfile` call site in the app, so it is the only
    // route to sign out, to the Dynamic profile, and to embedded-wallet export —
    // and below 1100px the header is the only place those exist at all.
    // Replacing it stranded anyone who declined the switch prompt with no way
    // out. The nag is advisory anyway: escrow reads go through wagmi's pinned
    // chain, and every write calls `ensureChain` itself before it sends.
    const wrongChain = wagerOn && expected != null && chainId != null && chainId !== expected;
    return (
      <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
        {wrongChain && (
          <button
            className="wrong-net"
            onClick={() => ensureChain(expected!).catch(() => {})}
            title={`Switch your wallet to chain ${expected}`}
          >
            Wrong network
          </button>
        )}
        <button
          className="account-chip"
          onClick={() => setShowDynamicUserProfile(true)}
          title="Account"
        >
          {photo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photo} alt="" className="chip-av" />
          ) : (
            <span className="chip-av chip-av-fallback">♟</span>
          )}
          <span>{playerLabel({ username, address })}</span>
        </button>
      </span>
    );
  }

  return (
    <>
      {control()}
      {/* Must be in the tree for setShowDynamicUserProfile to have anything to
          open; it renders nothing until then. Also where logging out lives: a
          Dynamic logout disconnects wagmi, which fires clearAuth above — and
          that alone is what signs the visitor out of gated pages, because
          RequireSignIn re-walls on any auth loss once no live board holds it
          open (lib/liveSeat.ts). No explicit-vs-passive classification exists
          here on purpose: this widget's logout is indistinguishable from a
          wallet-side disconnect at our layer, and the board's own hold is what
          keeps a mid-game disconnect from forfeiting a stake. */}
      <DynamicUserProfile />
    </>
  );
}
