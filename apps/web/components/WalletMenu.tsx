"use client";

import { useDynamicContext, useOpenFundingOptions } from "@dynamic-labs/sdk-react-core";
import { useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";

import { BankrollPanel } from "@/components/BankrollPanel";
import { ClaimWinnings } from "@/components/ClaimWinnings";
import { dynamicConfigured } from "@/lib/dynamicEnv";
import { fmtUsdc } from "@/lib/escrow";
import { useAvailable } from "@/lib/useBankroll";
import { useMounted } from "@/lib/useMounted";
import { useOnchainConfig } from "@/lib/useOnchainConfig";

/** Mount gate: the wagmi hook lives in WalletMenuInner so it only runs once the
 *  client-only WagmiProvider (app/providers.tsx) is in the tree. */
export function WalletMenu() {
  if (!useMounted()) return null;
  return <WalletMenuInner />;
}

/** Separate component so WalletMenuInner itself calls no Dynamic hooks: when
 *  there's no environment id the provider is absent from the tree entirely, and
 *  a hook reading its undefined context would throw. */
function AddFunds({ closeMenu }: { closeMenu: () => void }) {
  const { primaryWallet } = useDynamicContext();
  const { openFundingOptions } = useOpenFundingOptions();

  // Someone who signed in with Google or email arrives with an empty wallet and
  // no obvious way to fill it, so they get Dynamic's funding sheet (card onramp,
  // transfer from an exchange or another wallet). An external-wallet user
  // already has their own route to USDC, so for them this is just noise.
  if (!primaryWallet?.connector?.isEmbeddedWallet) return null;

  return (
    <button
      className="fund-btn"
      onClick={() => {
        // Close the popover first: the funding sheet is Dynamic's own modal, and
        // leaving this open behind it stacks two overlays.
        closeMenu();
        openFundingOptions();
      }}
    >
      Add funds
    </button>
  );
}

/** Top-right balance widget: a balance pill you refill. Clicking it opens the
 *  deposit / withdraw popover (the existing BankrollPanel). Only shown on a
 *  staked server once a wallet is connected — the funds live in escrow. */
function WalletMenuInner() {
  const { isConnected } = useAccount();
  const { config, wagerOn } = useOnchainConfig();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  if (!isConnected || !wagerOn || !config?.escrow) return null;

  return (
    <div className="wallet-menu" ref={ref}>
      <button
        className="wallet-pill"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Balance: deposit or withdraw USDC"
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
          {dynamicConfigured && <AddFunds closeMenu={() => setOpen(false)} />}
          <BankrollPanel escrow={config.escrow} chainId={config.chainId} />
          <ClaimWinnings escrow={config.escrow} chainId={config.chainId} />
        </div>
      )}
    </div>
  );
}
