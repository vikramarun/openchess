"use client";

import { useEffect, useState } from "react";
import { useAccount, useChainId, useSignMessage } from "wagmi";

import { fetchConfig } from "@/lib/escrow";
import { signInWithEthereum } from "@/lib/siwe";

/** Mount gate: the wagmi hooks live in SignInInner, which only renders on the
 *  client where the (client-only) WagmiProvider is present. */
export function SignIn() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return <SignInInner />;
}

function SignInInner() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { signMessageAsync } = useSignMessage();
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wagerOn, setWagerOn] = useState(false);

  useEffect(() => {
    setSignedIn(!!localStorage.getItem("chess_token"));
    fetchConfig().then((c) => setWagerOn(c.wagerEnabled));
  }, []);

  if (!isConnected || !address) return null;
  // Sign-in (SIWE) is only needed for wagered play. On a casual-only server it's
  // pure noise, so hide it unless wagering is enabled.
  if (!wagerOn) return null;
  if (signedIn) return <span className="muted">signed in ✓</span>;

  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
      {error && <span style={{ color: "#e06c6c", fontSize: 13 }}>{error}</span>}
      <button
        className="primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await signInWithEthereum(address, chainId, (a) => signMessageAsync(a));
            setSignedIn(true);
          } catch (e: any) {
            // Surface the failure instead of silently reverting the button.
            setError(e?.message ?? "sign-in failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Signing…" : "Sign in"}
      </button>
    </span>
  );
}
