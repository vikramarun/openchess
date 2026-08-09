"use client";

import { DynamicUserProfile, useDynamicContext } from "@dynamic-labs/sdk-react-core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useAccountEffect, useChainId } from "wagmi";

import { shortAddress } from "@/lib/address";
import { dynamicConfigured } from "@/lib/dynamicEnv";
import { authAddress, authToken, clearAuth } from "@/lib/escrow";
import { signInWithEthereum } from "@/lib/siwe";
import { useAvatar } from "@/lib/useAvatar";
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
 *  then we auto-switch to the server's expected chain and, on a staked server,
 *  immediately prompt the SIWE signature. So there's a single "Sign in", never a
 *  separate connect + sign-in step. The session token is bound to the wallet it
 *  was issued for and cleared on disconnect / account switch. */
function AuthButtonInner() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const ensureChain = useEnsureChain();
  const signMessageAsync = useDynamicSigner();
  const { setShowAuthFlow, setShowDynamicUserProfile, sdkHasLoaded } = useDynamicContext();
  const { showEscapeHatch, manualLogout } = useStaleAuthRecovery();

  const { config, wagerOn } = useOnchainConfig();
  const expected = config?.chainId ?? null;
  // The photo this wallet uploaded, if any. An email/Google user has no ENS name
  // or avatar to fall back on, so this and the pawn glyph are the only two
  // states the chip has.
  const photo = useAvatar(address);
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only auto-sign once per address, so a rejected prompt doesn't loop. Reset
  // when the connected account changes.
  const signTried = useRef<string | null>(null);
  // Latest connected address, readable from inside async callbacks.
  const addressRef = useRef(address);

  // Recompute sign-in state from storage on account change. Drop a token that
  // belongs to a different wallet OR a legacy token with no bound address
  // (pre-address-binding sessions) — both force a clean re-sign for this wallet.
  useEffect(() => {
    addressRef.current = address;
    const key = address?.toLowerCase() ?? null;
    if (key && authToken() && authAddress() !== key) clearAuth();
    setSignedIn(!!authToken() && !!key && authAddress() === key);
    signTried.current = null;
    setError(null);
  }, [address]);

  useAccountEffect({
    onDisconnect() {
      clearAuth();
      setSignedIn(false);
    },
  });

  const runSignIn = useCallback(async () => {
    if (!address || expected == null) return;
    const signingFor = address.toLowerCase();
    setError(null);
    setBusy(true);
    try {
      await ensureChain(expected);
      await signInWithEthereum(address, expected, signMessageAsync);
      // The account may have switched while the signature was pending — never
      // claim signed-in for a wallet the token wasn't issued to.
      if (addressRef.current?.toLowerCase() !== signingFor) {
        clearAuth();
        return;
      }
      setSignedIn(true);
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
  }, [address, expected, signMessageAsync, ensureChain]);

  const ready = isConnected && !!address && expected != null;

  // Auto-complete sign-in once connected on a staked server: runSignIn
  // switches to the expected chain (if needed) and then prompts the SIWE
  // signature, so this is the whole connect → switch → sign flow in one step.
  useEffect(() => {
    if (!ready || !wagerOn || signedIn || busy) return;
    const key = address!.toLowerCase();
    if (signTried.current === key) return;
    signTried.current = key;
    runSignIn();
  }, [ready, wagerOn, signedIn, busy, address, runSignIn]);

  // Dynamic is still booting. If it wedges here (see useStaleAuthRecovery) the
  // placeholder below would be the whole header forever, so the escape hatch
  // replaces it rather than sitting alongside.
  if (!sdkHasLoaded) {
    if (showEscapeHatch) {
      return (
        <button className="wrong-net" onClick={() => manualLogout()}>
          Stuck? Sign out
        </button>
      );
    }
    return <div style={{ width: 1 }} />;
  }

  function control() {
    if (!isConnected || !address) {
      return (
        <button className="primary" onClick={() => setShowAuthFlow(true)}>
          Sign in
        </button>
      );
    }

    // Connected but the signed-in session isn't established yet.
    if (wagerOn && !signedIn) {
      return (
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          {error && <span className="auth-err">{error}</span>}
          <button className="primary" disabled={busy} onClick={runSignIn}>
            {busy ? "Signing…" : "Finish sign-in"}
          </button>
        </span>
      );
    }

    // Signed-in user drifted to the wrong network — surface a switch control.
    if (wagerOn && expected != null && chainId !== expected) {
      return (
        <button className="wrong-net" onClick={() => ensureChain(expected).catch(() => {})}>
          Wrong network, switch
        </button>
      );
    }

    // Signed in (or a casual server that needs no signature) → account chip.
    return (
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
        <span>{shortAddress(address)}</span>
      </button>
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
