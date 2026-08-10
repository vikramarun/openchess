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
  // Mainnet only unless a build opts in. One consequence to keep in mind:
  // wagmi only tracks a connector's chain if it is in THIS list, so with
  // `[base]` alone `useChainId()` always reports 8453 even for a wallet parked
  // elsewhere. Anything comparing against it therefore can't detect a wrong
  // network — which is why `useEnsureChain` and the two "wrong network"
  // controls read `useAccount().chainId` (the connection's own chain, which is
  // NOT filtered by this list) instead. Don't switch them back.
  //
  // The backstop is at each write: every `writeContractAsync` passes
  // `chainId`, so viem checks the wallet's LIVE chain at send time and throws a
  // clean ChainMismatchError rather than silently transmitting on the wrong
  // chain (which then hangs a Base-pinned receipt wait forever). Keep that
  // param on any new write. The manual web check in
  // scripts/test-sepolia-tournament.sh documents setting the testnet flag.
  chains: process.env.NEXT_PUBLIC_ENABLE_TESTNET === "1" ? [base, baseSepolia] : [base],
  ssr: true,
  multiInjectedProviderDiscovery: false,
  transports: {
    [base.id]: http(),
    [baseSepolia.id]: http(),
  },
});
