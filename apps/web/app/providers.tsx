"use client";

import "@rainbow-me/rainbowkit/styles.css";
import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { WagmiProvider } from "wagmi";

import { makeWagmiConfig } from "@/lib/wagmi";
import { EngineProvider } from "@/lib/engineContext";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // The wallet stack (wagmi/RainbowKit) + the in-browser engine (Web Worker)
  // touch browser-only APIs, so we mount client-side only. The wagmi config is
  // built here (client) so its eager indexedDB access never runs during SSR.
  const [wagmiConfig] = useState(() => (typeof window !== "undefined" ? makeWagmiConfig() : null));
  if (!mounted || !wagmiConfig) return <>{children}</>;

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={darkTheme()}>
          <EngineProvider>{children}</EngineProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
