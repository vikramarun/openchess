import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  metaMaskWallet,
  rabbyWallet,
  rainbowWallet,
  safeWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { base, baseSepolia } from "wagmi/chains";

// WalletConnect requires a real projectId (from WalletConnect Cloud). Without
// one, WalletConnect pairing won't work — injected wallets (MetaMask) still do.
// In production the env var must be set; locally we warn loudly rather than
// silently shipping a non-functional WC transport.
const projectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID;
if (!projectId && typeof window !== "undefined") {
  // Warn loudly in the browser (don't throw at import — that would break SSR /
  // static prerender). Injected wallets still work without WalletConnect.
  // eslint-disable-next-line no-console
  console.warn(
    "NEXT_PUBLIC_WC_PROJECT_ID is not set, so WalletConnect pairing will not work. Set it for production.",
  );
}

// The connect-modal shortlist. RainbowKit's default "Popular" group is
// [safe, rainbow, coinbase, metaMask, walletConnect] — Rabby is absent, so a
// Rabby user saw only an "install a wallet" wall even with the extension
// already installed. Spelling the group out is the only way to add to it;
// keep the defaults in their original order and append Rabby.
const POPULAR_WALLETS = [
  safeWallet,
  rainbowWallet,
  coinbaseWallet,
  metaMaskWallet,
  rabbyWallet,
  walletConnectWallet,
];

// Built lazily on the client (see providers.tsx) so getDefaultConfig — which
// eagerly touches browser-only storage (indexedDB) — never runs during SSR /
// static prerender.
export function makeWagmiConfig() {
  return getDefaultConfig({
    appName: "Chess Wager",
    projectId: projectId || "dev-only-no-walletconnect",
    chains: [base, baseSepolia],
    wallets: [{ groupName: "Popular", wallets: POPULAR_WALLETS }],
    ssr: true,
  });
}
