"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";

import { BankrollPanel } from "@/components/BankrollPanel";
import { ClaimWinnings } from "@/components/ClaimWinnings";
import { fetchConfig, fmtUsdc, type OnchainConfig } from "@/lib/escrow";
import { useAvailable } from "@/lib/useBankroll";
import { useMounted } from "@/lib/useMounted";

/** Mount gate: the wagmi hook lives in WalletMenuInner so it only runs once the
 *  client-only WagmiProvider (app/providers.tsx) is in the tree. */
export function WalletMenu() {
  if (!useMounted()) return null;
  return <WalletMenuInner />;
}

/** Top-right bankroll widget: a balance pill you refill. Clicking it opens the
 *  deposit / withdraw popover (the existing BankrollPanel). Only shown on a
 *  wagering server once a wallet is connected — the funds live in escrow. */
function WalletMenuInner() {
  const { isConnected } = useAccount();
  const [config, setConfig] = useState<OnchainConfig | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchConfig().then(setConfig);
  }, []);

  // Close the popover on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // The pill only needs a slow background refresh; an open BankrollPanel shares
  // the same query key and drives faster polling while it's on screen.
  const { available } = useAvailable(config?.escrow, { refetchInterval: 30000 });

  const wagerOn = !!config?.wagerEnabled && !!config?.escrow;
  if (!isConnected || !wagerOn || !config?.escrow) return null;

  return (
    <div className="wallet-menu" ref={ref}>
      <button
        className="wallet-pill"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Bankroll — deposit or withdraw USDC"
      >
        <span className="wp-coin">◈</span>
        <span className="wp-amt">{available != null ? fmtUsdc(available) : "—"}</span>
        <span className="muted" style={{ fontSize: 12 }}>
          USDC
        </span>
        <span className="wp-caret">▾</span>
      </button>
      {open && (
        <div className="wallet-pop">
          <BankrollPanel escrow={config.escrow} chainId={config.chainId} />
          <ClaimWinnings escrow={config.escrow} chainId={config.chainId} />
        </div>
      )}
    </div>
  );
}
