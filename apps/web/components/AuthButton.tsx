"use client";

import { DynamicUserProfile, useDynamicContext } from "@dynamic-labs/sdk-react-core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useAccountEffect } from "wagmi";

import { dynamicConfigured } from "@/lib/dynamicEnv";
import { authAddress, authToken, clearAuth } from "@/lib/escrow";
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
 *  and on a staked server we immediately prompt the SIWE signature. So there's a
 *  single "Sign in", never a separate connect + sign-in step. No chain switch is
 *  involved: SIWE doesn't need one, and the money writes each do their own. The session token is bound to the wallet it
 *  was issued for and cleared on disconnect / account switch. */
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

  // Only auto-sign once per address, so a rejected prompt doesn't loop. Reset
  // when the connected account changes.
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
      // Deliberately NO `ensureChain` here. SIWE is a `personal_sign` over a
      // text message; the `Chain ID` line carries the SERVER's expected chain
      // (`config.chainId`), which is also what the server validates against, so
      // the wallet's own network is irrelevant to whether the signature
      // verifies. This effect auto-runs on page load, so switching here would
      // fire an unsolicited network prompt at a user who only opened the site —
      // and, since a rejected switch throws, would leave someone who declines
      // unable to sign in at all (no casual attribution, no tournament join)
      // over a chain they didn't need to be on. It was harmless only while
      // `useEnsureChain` read the pinned `useChainId()` and could never fire.
      // The switch belongs on the money writes, where it is user-initiated and
      // genuinely required — and each of those calls it itself.
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
  }, [address, expected, signMessageAsync]);

  const ready = isConnected && !!address && expected != null;

  // Auto-complete sign-in once connected on a staked server. `runSignIn`
  // prompts the SIWE signature and nothing else — it deliberately does NOT
  // switch chains (see the note inside it), because this effect runs on page
  // load and a switch there is an unsolicited wallet prompt.
  useEffect(() => {
    if (!ready || !wagerOn || signedIn || busy) return;
    const key = address!.toLowerCase();
    if (signTried.current === key) return;
    signTried.current = key;
    runSignIn();
  }, [ready, wagerOn, signedIn, busy, address, runSignIn]);

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
        <button className="primary" onClick={() => setShowAuthFlow(true)}>
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
          <button className="primary" disabled={busy || expected == null} onClick={runSignIn}>
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
          open; it renders nothing until then. Also where logging out lives, and
          a Dynamic logout disconnects wagmi, which fires clearAuth above. */}
      <DynamicUserProfile />
    </>
  );
}
