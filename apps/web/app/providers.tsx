"use client";

import { EthereumWalletConnectors } from "@dynamic-labs/ethereum";
import { DynamicContextProvider } from "@dynamic-labs/sdk-react-core";
import type { EvmNetwork } from "@dynamic-labs/types";
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

// This app settles on Base and nowhere else, so Dynamic's network set is pinned
// HERE with `overrides.evmNetworks` — an array override REPLACES whatever the
// dashboard has enabled (which today is only Ethereum mainnet, i.e. wrong).
// Without the override, the dashboard is a second source of truth this repo
// can't see or test, and it drifts: embedded wallets get provisioned pointed at
// a chain the escrow doesn't live on, and the SDK refuses `switchNetwork` calls
// to chains it wasn't told about. Keep this list agreeing with lib/wagmi.ts's
// `chains` — same rule, same testnet flag, one entry each.
//
// Module-level constants on purpose: Dynamic uses `evmNetworks` in a dependency
// array (its own docs warn it must be memoized), and these never change.
// The RPC/explorer origins are already in the CSP (next.config.mjs pins
// https://mainnet.base.org and https://sepolia.base.org in connect-src for
// wagmi's transports — same endpoints); the icon comes off Dynamic's own asset
// host, covered by img-src's `https:`.
const BASE_MAINNET: EvmNetwork = {
  chainId: 8453,
  networkId: 8453,
  name: "Base",
  vanityName: "Base",
  iconUrls: ["https://app.dynamic.xyz/assets/networks/base.svg"],
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://mainnet.base.org"],
  blockExplorerUrls: ["https://basescan.org"],
};
const BASE_SEPOLIA: EvmNetwork = {
  chainId: 84532,
  networkId: 84532,
  name: "Base Sepolia",
  vanityName: "Base Sepolia",
  isTestnet: true,
  iconUrls: ["https://app.dynamic.xyz/assets/networks/base.svg"],
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://sepolia.base.org"],
  blockExplorerUrls: ["https://sepolia.basescan.org"],
};
const EVM_NETWORKS: EvmNetwork[] =
  process.env.NEXT_PUBLIC_ENABLE_TESTNET === "1" ? [BASE_MAINNET, BASE_SEPOLIA] : [BASE_MAINNET];

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
      // Base only (see EVM_NETWORKS above). The connect flow and the
      // `ensureChain` switch inside runSignIn are what put a wallet ON Base —
      // this is what makes Base a chain the SDK will switch an embedded wallet
      // to at all, regardless of dashboard state.
      overrides: { evmNetworks: EVM_NETWORKS },
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
