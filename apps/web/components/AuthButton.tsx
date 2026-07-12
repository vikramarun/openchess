"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useAccountEffect, useChainId, useSignMessage, useSwitchChain } from "wagmi";

import { authAddress, authToken, clearAuth, fetchConfig } from "@/lib/escrow";
import { signInWithEthereum } from "@/lib/siwe";

/** Mount gate: the wagmi hooks live in AuthButtonInner, which only renders once
 *  the client-only WagmiProvider (app/providers.tsx) is in the tree. */
export function AuthButton() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div style={{ width: 1 }} />;
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
  const { switchChainAsync } = useSwitchChain();
  const { signMessageAsync } = useSignMessage();

  const [expected, setExpected] = useState<number | null>(null);
  const [wagerOn, setWagerOn] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only auto-switch / auto-sign once per address, so a rejected prompt doesn't
  // loop. Reset when the connected account changes.
  const switchTried = useRef<string | null>(null);
  const signTried = useRef<string | null>(null);

  useEffect(() => {
    fetchConfig().then((c) => {
      setExpected(c.chainId);
      setWagerOn(c.wagerEnabled);
    });
  }, []);

  // Recompute sign-in state from storage on account change, dropping a token
  // that belongs to a different wallet.
  useEffect(() => {
    const key = address?.toLowerCase() ?? null;
    if (key && authAddress() && authAddress() !== key) clearAuth();
    setSignedIn(!!authToken() && !!key && authAddress() === key);
    switchTried.current = null;
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
    setError(null);
    setBusy(true);
    try {
      if (chainId !== expected) await switchChainAsync({ chainId: expected });
      await signInWithEthereum(address, expected, (a) => signMessageAsync(a));
      setSignedIn(true);
    } catch (e: any) {
      setError(e?.shortMessage ?? e?.message ?? "sign-in failed");
    } finally {
      setBusy(false);
    }
  }, [address, chainId, expected, signMessageAsync, switchChainAsync]);

  const ready = isConnected && !!address && expected != null;

  // Auto-switch to the expected chain while completing sign-in.
  useEffect(() => {
    if (!ready || !wagerOn || signedIn) return;
    if (chainId === expected) return;
    const key = address!.toLowerCase();
    if (switchTried.current === key) return;
    switchTried.current = key;
    switchChainAsync({ chainId: expected! }).catch(() => {});
  }, [ready, wagerOn, signedIn, chainId, expected, address, switchChainAsync]);

  // Auto-prompt the SIWE signature once the chain is right.
  useEffect(() => {
    if (!ready || !wagerOn || signedIn || busy) return;
    if (chainId !== expected) return;
    const key = address!.toLowerCase();
    if (signTried.current === key) return;
    signTried.current = key;
    runSignIn();
  }, [ready, wagerOn, signedIn, busy, chainId, expected, address, runSignIn]);

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
