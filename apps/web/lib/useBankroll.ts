"use client";

import { useAccount, useReadContract } from "wagmi";

import { ESCROW_ABI } from "./escrow";

/** Read the connected wallet's available (unlocked) escrow balance in USDC base
 *  units. Used to gate wager actions before they fail on-chain. Returns
 *  `undefined` while loading / when no escrow or wallet. */
export function useAvailable(escrow?: `0x${string}` | null): {
  available: bigint | undefined;
  refetch: () => void;
} {
  const { address } = useAccount();
  const { data, refetch } = useReadContract({
    address: escrow ?? undefined,
    abi: ESCROW_ABI,
    functionName: "available",
    args: address ? [address] : undefined,
    query: {
      enabled: !!escrow && !!address,
      refetchInterval: 8000,
    },
  });
  return { available: data as bigint | undefined, refetch };
}
