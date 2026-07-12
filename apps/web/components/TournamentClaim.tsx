"use client";

import { useEffect, useState } from "react";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWriteContract,
} from "wagmi";

import { ESCROW_ABI, fetchClaimProof, fmtUsdc, tidToBytes32, type ClaimProof } from "@/lib/escrow";

const ZERO32 = `0x${"0".repeat(64)}`;

/** Collect a tournament's on-chain proceeds for the connected wallet: a Merkle
 *  payout claim for a root-settled field, or a buy-in refund for one that never
 *  settled past the timeout. Both credit the wallet's escrow bankroll (withdraw
 *  via the Bankroll panel). Renders nothing unless the wallet actually entered
 *  this tournament and has something to do — safe to drop on any finished card. */
export function TournamentClaim({
  tid,
  status,
  escrow,
  chainId: expected,
  label,
  onResolved,
  onClaimed,
}: {
  tid: string;
  status: string;
  escrow: `0x${string}`;
  chainId: number;
  /** Optional tournament name shown above the action (for the bankroll list). */
  label?: string;
  /** Reports whether this tournament actually renders an action/state, so a
   *  parent list can hide its header when nothing is claimable. */
  onResolved?: (hasAction: boolean) => void;
  onClaimed?: () => void;
}) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proof, setProof] = useState<ClaimProof | null>(null);

  const tidHex = tidToBytes32(tid);
  const enabled = !!address && isConnected;
  const poll = { query: { enabled, refetchInterval: 8000 } } as const;

  const { data: tourn, refetch: refetchTourn } = useReadContract({
    address: escrow,
    abi: ESCROW_ABI,
    functionName: "tournaments",
    args: [tidHex],
    ...poll,
  });
  const { data: claimed, refetch: refetchClaimed } = useReadContract({
    address: escrow,
    abi: ESCROW_ABI,
    functionName: "tournamentClaimed",
    args: address ? [tidHex, address] : undefined,
    ...poll,
  });
  const { data: entered } = useReadContract({
    address: escrow,
    abi: ESCROW_ABI,
    functionName: "tournamentEntered",
    args: address ? [tidHex, address] : undefined,
    query: { enabled },
  });
  const { data: timeout } = useReadContract({
    address: escrow,
    abi: ESCROW_ABI,
    functionName: "settleTimeout",
    query: { enabled },
  });

  // tournaments() → [buyIn, pool, claimedAmount, entrants, openedAt, settled, payoutRoot, exists]
  const t = tourn as
    | readonly [bigint, bigint, bigint, number, bigint, boolean, `0x${string}`, boolean]
    | undefined;
  const exists = t?.[7] ?? false;
  const settled = t?.[5] ?? false;
  const openedAt = t ? Number(t[4]) : 0;
  const buyIn = t?.[0] ?? 0n;
  const payoutRoot = t?.[6];
  const rootSet = !!payoutRoot && payoutRoot !== ZERO32;
  const hasClaimed = claimed === true;
  const hasEntered = entered === true;
  const settleTimeout = timeout != null ? Number(timeout) : null;

  // Root-settled + unclaimed → ask the server whether this wallet is a winner
  // (404 = not a winner / not root-settled, so `proof` stays null and no button).
  useEffect(() => {
    if (!address || !rootSet || hasClaimed) {
      setProof(null);
      return;
    }
    let live = true;
    fetchClaimProof(tid, address).then((p) => {
      if (live) setProof(p);
    });
    return () => {
      live = false;
    };
  }, [tid, address, rootSet, hasClaimed]);

  const now = Math.floor(Date.now() / 1000);
  const refundReady =
    !settled && settleTimeout != null && now > openedAt + settleTimeout && !hasClaimed;
  // Whether this tournament will render an action/state (vs null), reported up
  // so a "Tournament winnings" list can hide its header when nothing applies.
  const hasAction =
    enabled &&
    exists &&
    hasEntered &&
    (hasClaimed ||
      (rootSet && !!proof) ||
      refundReady ||
      (status === "abandoned" && !settled && settleTimeout != null));
  useEffect(() => {
    onResolved?.(hasAction);
  }, [hasAction, onResolved]);

  if (!enabled || !exists || !hasEntered) return null;

  const ensureChain = async () => {
    if (chainId !== expected) await switchChainAsync({ chainId: expected });
  };

  const run = async (fn: () => Promise<`0x${string}`>) => {
    setError(null);
    setBusy(true);
    try {
      await ensureChain();
      const hash = await fn();
      await publicClient!.waitForTransactionReceipt({ hash });
      refetchTourn();
      refetchClaimed();
      onClaimed?.();
    } catch (e: any) {
      setError(e?.shortMessage ?? e?.message ?? "transaction failed");
    } finally {
      setBusy(false);
    }
  };

  const doClaim = () =>
    proof &&
    address &&
    run(() =>
      writeContractAsync({
        address: escrow,
        abi: ESCROW_ABI,
        functionName: "claimTournament",
        args: [tidHex, address, proof.amount, proof.proof],
      }),
    );

  const doRefund = () =>
    address &&
    run(() =>
      writeContractAsync({
        address: escrow,
        abi: ESCROW_ABI,
        functionName: "claimRefund",
        args: [tidHex, address],
      }),
    );

  const errLine = error ? <span style={{ color: "#e06c6c", fontSize: 12 }}>{error}</span> : null;

  // The single action/state for this tournament, or null when there's nothing
  // to show (non-winner, already credited to bankroll, etc.).
  let node: React.ReactNode = null;
  if (hasClaimed) {
    node = (
      <span className="muted" style={{ fontSize: 13 }}>
        {rootSet ? "Payout claimed ✓" : "Refund claimed ✓"}
      </span>
    );
  } else if (rootSet && proof) {
    // Winner of a root-settled field → Merkle claim.
    node = (
      <button className="primary" onClick={doClaim} disabled={busy}>
        {busy ? "Claiming…" : `Claim ${fmtUsdc(proof.amount)} USDC`}
      </button>
    );
  } else if (refundReady) {
    // Never settled past the timeout → reclaim the buy-in.
    node = (
      <button className="ghost" onClick={doRefund} disabled={busy}>
        {busy ? "Refunding…" : `Claim refund · ${fmtUsdc(buyIn)} USDC`}
      </button>
    );
  } else if (status === "abandoned" && !settled && settleTimeout != null) {
    // Abandoned but the refund window hasn't opened yet — tell the entrant when.
    const left = openedAt + settleTimeout - now;
    const dur =
      left <= 0
        ? "soon"
        : left >= 86400
          ? `~${Math.ceil(left / 86400)}d`
          : left >= 3600
            ? `~${Math.ceil(left / 3600)}h`
            : `~${Math.max(1, Math.ceil(left / 60))}m`;
    node = (
      <span className="muted" style={{ fontSize: 13 }}>
        Refund available in {dur}
      </span>
    );
  }

  if (!node) return null;
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
      {label && (
        <span className="muted" style={{ fontSize: 12 }}>
          {label}
        </span>
      )}
      {node}
      {errLine}
    </span>
  );
}
