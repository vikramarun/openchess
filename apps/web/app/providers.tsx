"use client";

import { EthereumWalletConnectors } from "@dynamic-labs/ethereum";
import { DynamicContextProvider } from "@dynamic-labs/sdk-react-core";
import { DynamicWagmiConnector } from "@dynamic-labs/wagmi-connector";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { WagmiProvider } from "wagmi";

import { wagmiConfig } from "@/lib/wagmi";
import { DYNAMIC_ENV_ID, dynamicConfigured } from "@/lib/dynamicEnv";
import { EngineProvider } from "@/lib/engineContext";

// Dynamic replaces RainbowKit as the connect layer, which is what lets someone
// sign in with Google or email instead of arriving with a wallet already
// installed. Those logins provision an embedded MPC wallet — an ordinary EOA
// whose signatures are indistinguishable from MetaMask's, so lib/siwe.ts and the
// server's ecrecover check work on it unchanged.

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!dynamicConfigured) {
      // eslint-disable-next-line no-console
      console.warn(
        "NEXT_PUBLIC_DYNAMIC_ENV_ID is not set, so sign-in is disabled. Set it for production.",
      );
    }
  }, []);

  const settings = useMemo(
    () => ({
      environmentId: DYNAMIC_ENV_ID ?? "",
      walletConnectors: [EthereumWalletConnectors],
      // Namespaces Dynamic's localStorage per environment, so moving a browser
      // between the sandbox and live environment ids doesn't leave one env
      // reading the other's half-written session.
      localStorageSuffix: DYNAMIC_ENV_ID?.split("-")[0],
      // External wallets connect without Dynamic asking for its own signature,
      // so the only thing a MetaMask user ever signs is our SIWE message — one
      // prompt, not two. Email/Google are unaffected: they inherently run
      // Dynamic's full auth, since that's the only way an embedded wallet can
      // exist.
      initialAuthenticationMode: "connect-only" as const,
      // Popup, not redirect: the OAuth navigation then happens in a top-level
      // context this page's CSP doesn't govern, so no Google origins need to be
      // allowlisted in next.config.mjs.
      social: { strategy: "popup" as const },
    }),
    [],
  );

  // The wallet stack and the in-browser engine (Web Worker) touch browser-only
  // APIs, and DynamicContextProvider is a common source of Next hydration
  // mismatches, so the whole tree mounts client-side only. Components that call
  // wagmi or Dynamic hooks gate on lib/useMounted.ts for the same reason.
  if (!mounted) return <>{children}</>;

  // No environment id → no Dynamic layer at all. DynamicContextProvider throws
  // on an empty environmentId, and DynamicWagmiConnector needs its context, so
  // both are skipped rather than fed a placeholder. wagmi still mounts, so
  // read-only on-chain data keeps working; AuthButton and WalletMenu check
  // `dynamicConfigured` before calling any Dynamic hook.
  if (!dynamicConfigured) {
    return (
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <EngineProvider>{children}</EngineProvider>
        </QueryClientProvider>
      </WagmiProvider>
    );
  }

  return (
    <DynamicContextProvider theme="dark" settings={settings}>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <DynamicWagmiConnector>
            <EngineProvider>{children}</EngineProvider>
          </DynamicWagmiConnector>
        </QueryClientProvider>
      </WagmiProvider>
    </DynamicContextProvider>
  );
}
