"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useEffect, useState } from "react";

export function WalletButton() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // Render nothing until mounted so ConnectButton only appears once the
  // client-only WagmiProvider (see app/providers.tsx) is in the tree.
  if (!mounted) return <div style={{ width: 1 }} />;
  return <ConnectButton showBalance={false} chainStatus="icon" />;
}
