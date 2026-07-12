"use client";

import { useCallback } from "react";
import { useChainId, useSwitchChain } from "wagmi";

/** Returns a function that switches the wallet to `expected` if it isn't already
 *  there — the one place the "be on the right chain before a write" step lives
 *  (bankroll deposit/withdraw, SIWE sign-in, tournament claim/refund). */
export function useEnsureChain(): (expected: number) => Promise<void> {
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  return useCallback(
    async (expected: number) => {
      if (chainId !== expected) await switchChainAsync({ chainId: expected });
    },
    [chainId, switchChainAsync],
  );
}
