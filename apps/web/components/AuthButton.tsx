"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useAccountEffect, useChainId, useSignMessage } from "wagmi";

import { authAddress, authToken, clearAuth } from "@/lib/escrow";
import { signInWithEthereum } from "@/lib/siwe";
import { useEnsureChain } from "@/lib/useEnsureChain";
import { useMounted } from "@/lib/useMounted";
import { useOnchainConfig } from "@/lib/useOnchainConfig";

/** Mount gate: the wagmi hooks live in AuthButtonInner, which only renders once
 *  the client-only WagmiProvider (app/providers.tsx) is in the tree. */
export function AuthButton() {
  if (!useMounted()) return <div style={{ width: 1 }} />;
  return <AuthButtonInner />;
}

/** One button for the whole entry flow. Connecting a wallet auto-switches to the
 *  server's expected chain and, on a wagering server, immediately prompts the
 *  SIWE signature — so there's a single "Sign in", never a separate connect +
 *  sign-in step. The session token is bound to the wallet it was issued for and
 *  cleared on disconnect / account switch. */
function AuthButtonInner() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const ensureChain = useEnsureChain();
  const { signMessageAsync } = useSignMessage();

  const { config, wagerOn } = useOnchainConfig();
  const expected = config?.chainId ?? null;
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
      await signInWithEthereum(address, expected, (a) => signMessageAsync(a));
      // The account may have switched while the signature was pending — never
      // claim signed-in for a wallet the token wasn't issued to.
      if (addressRef.current?.toLowerCase() !== signingFor) {
        clearAuth();
        return;
      }
      setSignedIn(true);
    } catch (e: any) {
      setError(e?.shortMessage ?? e?.message ?? "sign-in failed");
    } finally {
      setBusy(false);
    }
  }, [address, expected, signMessageAsync, ensureChain]);

  const ready = isConnected && !!address && expected != null;

  // Auto-complete sign-in once connected on a wagering server: runSignIn
  // switches to the expected chain (if needed) and then prompts the SIWE
  // signature, so this is the whole connect → switch → sign flow in one step.
  useEffect(() => {
    if (!ready || !wagerOn || signedIn || busy) return;
    const key = address!.toLowerCase();
    if (signTried.current === key) return;
    signTried.current = key;
    runSignIn();
  }, [ready, wagerOn, signedIn, busy, address, runSignIn]);

  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openConnectModal, mounted: rkMounted }) => {
        if (!rkMounted) return <div style={{ width: 1 }} />;

        if (!account || !chain) {
          return (
            <button className="primary" onClick={() => openConnectModal?.()}>
              Sign in
            </button>
          );
        }

        // Connected but the wagering session isn't established yet.
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

        // Signed-in user drifted to the wrong network — surface a switch control
        // (the old default ConnectButton did this; the custom chip must too).
        if (wagerOn && expected != null && chainId !== expected) {
          return (
            <button className="wrong-net" onClick={() => ensureChain(expected).catch(() => {})}>
              Wrong network — switch
            </button>
          );
        }

        // Signed in (or a casual server that needs no signature) → account chip.
        return (
          <button className="account-chip" onClick={() => openAccountModal?.()} title="Account">
            {account.ensAvatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={account.ensAvatar} alt="" className="chip-av" />
            ) : (
              <span className="chip-av chip-av-fallback">♟</span>
            )}
            <span>{account.ensName ?? account.displayName}</span>
          </button>
        );
      }}
    </ConnectButton.Custom>
  );
}
