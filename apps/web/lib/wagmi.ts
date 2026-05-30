import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { base, baseSepolia } from "wagmi/chains";

// projectId is required by WalletConnect; for the local demo a placeholder is
// fine (injected wallets like MetaMask still work). Replace for production.
export const wagmiConfig = getDefaultConfig({
  appName: "Chess Wager",
  projectId: process.env.NEXT_PUBLIC_WC_PROJECT_ID || "demo-project-id",
  chains: [base, baseSepolia],
  ssr: true,
});
