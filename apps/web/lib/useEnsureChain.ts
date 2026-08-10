"use client";

import { useCallback } from "react";
import { useAccount, useSwitchChain } from "wagmi";

/** Returns a function that switches the wallet to `expected` if it isn't already
 *  there — the one place the "be on the right chain before a write" step lives
 *  (bankroll deposit/withdraw, tournament claim/refund, sponsorship). NOT
 *  sign-in: SIWE is a `personal_sign` whose chain id is the server's, so it
 *  needs no switch — and prompting for one on page load is user-hostile.
 *
 *  **Reads the chain from `useAccount()`, never `useChainId()`.** wagmi only
 *  syncs a connector's chain into `config.state.chainId` when that chain is in
 *  the configured list, and production configures `[base]` alone — so
 *  `useChainId()` reports 8453 for a wallet parked on Ethereum and this helper
 *  would decide there was nothing to switch. `useAccount().chainId` is the
 *  connection's own chain, unfiltered, so the comparison is against reality.
 *  That matters twice over now that every write asserts its chain: without it
 *  the write throws ChainMismatchError and nothing in the UI can clear it (an
 *  embedded wallet has no network switcher of its own).
 *
 *  When the chain is unknown (disconnected), don't guess — skip the switch and
 *  let the write's own assertion be the backstop, rather than firing a spurious
 *  wallet prompt. */
export function useEnsureChain(): (expected: number) => Promise<void> {
  const { chainId: connected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  return useCallback(
    async (expected: number) => {
      if (connected != null && connected !== expected) {
        await switchChainAsync({ chainId: expected });
      }
    },
    [connected, switchChainAsync],
  );
}
