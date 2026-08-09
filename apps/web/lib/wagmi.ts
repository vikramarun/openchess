import { createConfig, http } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";

// Connectors come from Dynamic, not from here: DynamicWagmiConnector
// (app/providers.tsx) pushes the connected wallet into wagmi's state, so every
// existing useAccount/useReadContract/useWriteContract call site keeps working
// against both external wallets and Dynamic's embedded MPC wallets. This config
// therefore declares only chains + transports.
//
// Two things that will silently break if changed:
//
//   * `multiInjectedProviderDiscovery: false` is required. Dynamic implements
//     EIP-6963 discovery itself, so leaving wagmi's on lists every injected
//     wallet twice.
//   * The chain list below and the networks enabled in the Dynamic dashboard are
//     two separate sources of truth that must agree. Dynamic no longer syncs its
//     dashboard networks into wagmi, so a chain enabled in only one of the two
//     produces a wallet that connects but can't transact (or vice versa).
//
// The connect-modal wallet shortlist also lives in the dashboard now, rather than
// in this file. Keep Rabby enabled there: RainbowKit's default group omitted it,
// and a Rabby user with the extension already installed saw an "install a wallet"
// wall. Filter/enable wallets by connector KEY, never by name — the name is
// display text that Dynamic can localise or rename.
export const wagmiConfig = createConfig({
  // Mainnet only unless a build opts in: a production visitor whose wallet sits
  // on Base Sepolia should meet the wrong-network guard, not a first-class chain
  // offer. The manual web check in scripts/test-sepolia-tournament.sh documents
  // setting the flag.
  chains: process.env.NEXT_PUBLIC_ENABLE_TESTNET === "1" ? [base, baseSepolia] : [base],
  ssr: true,
  multiInjectedProviderDiscovery: false,
  transports: {
    [base.id]: http(),
    [baseSepolia.id]: http(),
  },
});
