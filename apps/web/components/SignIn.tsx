"use client";

import { useEffect, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";

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
  const { signMessageAsync } = useSignMessage();
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSignedIn(!!localStorage.getItem("chess_token"));
  }, []);

  if (!isConnected || !address) return null;
  if (signedIn) return <span className="muted">signed in ✓</span>;

  return (
    <button
      className="primary"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await signInWithEthereum(address, (a) => signMessageAsync(a));
          setSignedIn(true);
        } catch (e) {
          console.error(e);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Signing…" : "Sign in"}
    </button>
  );
}
