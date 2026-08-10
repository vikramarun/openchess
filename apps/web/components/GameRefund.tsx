"use client";

import { useEffect, useState } from "react";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";

import { ESCROW_ABI, fmtUsdc, gameIdToBytes32 } from "@/lib/escrow";
import { useEnsureChain } from "@/lib/useEnsureChain";

/** Reclaim a stake from a wagered game the server never settled.
 *
 *  The escrow always had `claimTimeout` — it refunds BOTH seats once
 *  `settleTimeout` passes with no settlement — but nothing surfaced it, so a
 *  stuck stake meant hand-writing a contract call on a block explorer. That is
 *  the one path where a player couldn't recover their own money in-app.
 *
 *  The server only supplies candidates; this component asks the chain, which is
 *  the authority on whether the game exists, is already settled, and whether the
 *  window has actually opened. Renders nothing when there's nothing to do. */
export function GameRefund({
  escrow,
  chainId: expected,
  gameId,
  onResolved,
}: {
  escrow: `0x${string}`;
  /** Chain the escrow lives on; the wallet is switched to it before writing. */
  chainId: number;
  gameId: string;
  /** Reports whether this game rendered an action, so the parent can hide its
   *  header when none of its candidates turned out to be claimable. */
  onResolved?: (hasAction: boolean) => void;
}) {
  const { address, isConnected } = useAccount();
  const ensureChain = useEnsureChain();
  // Pin to the settlement chain: after ensureChain switches, the connected
  // chain's client would otherwise be stale/undefined.
  const publicClient = usePublicClient({ chainId: expected });
  const { writeContractAsync } = useWriteContract();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const idHex = gameIdToBytes32(gameId);
  const enabled = !!address && isConnected;
  const poll = { query: { enabled, refetchInterval: 8000 } } as const;

  const { data: game, refetch } = useReadContract({
    address: escrow,
    abi: ESCROW_ABI,
    functionName: "games",
    args: [idHex],
    chainId: expected,
    ...poll,
  });
  const { data: settleTimeout } = useReadContract({
    address: escrow,
    abi: ESCROW_ABI,
    functionName: "settleTimeout",
    chainId: expected,
    ...poll,
  });

  // games() → [white, black, stake, feeBps, openedAt, settled, exists]
  const g = game as
    | readonly [`0x${string}`, `0x${string}`, bigint, number, bigint, boolean, boolean]
    | undefined;
  const stake = g?.[2] ?? 0n;
  const openedAt = g ? Number(g[4]) : 0;
  const settled = g?.[5] ?? false;
  const exists = g?.[6] ?? false;

  const now = Math.floor(Date.now() / 1000);
  const windowOpensAt = openedAt + Number(settleTimeout ?? 0n);
  const ready = exists && !settled && settleTimeout != null && now > windowOpensAt;
  // Escrow open, not settled, but the timeout hasn't elapsed — tell the player
  // when rather than showing nothing, so a missing stake isn't a mystery.
  const pending = exists && !settled && settleTimeout != null && now <= windowOpensAt;

  // A successful refund sets `settled` onchain, which clears BOTH `ready` and
  // `pending` — so without this the row unmounts the moment it succeeds, and
  // `onResolved(false)` lets the parent hide the whole "Payouts & refunds" panel
  // if this was the only item. The user approves a 25 USDC refund, the tx
  // confirms, and the button plus the panel simply vanish with no confirmation,
  // which reads as failure. Keep the row for this session so it can say so.
  const [justRefunded, setJustRefunded] = useState(false);
  const hasAction = ready || pending || justRefunded;
  useEffect(() => {
    onResolved?.(hasAction);
  }, [hasAction, onResolved]);

  if (!hasAction) return null;

  const doRefund = async () => {
    setError(null);
    setBusy(true);
    try {
      await ensureChain(expected);
      const hash = await writeContractAsync({
        chainId: expected,
        account: address,
        address: escrow,
        abi: ESCROW_ABI,
        functionName: "claimTimeout",
        args: [idHex],
      });
      // waitForTransactionReceipt RESOLVES for a reverted tx, so check the
      // status — a reverted claim otherwise refetches and looks like success.
      const receipt = await publicClient!.waitForTransactionReceipt({ hash });
      if (receipt.status === "reverted") throw new Error("The refund reverted onchain.");
      setJustRefunded(true); // keep the row alive to confirm what landed
      refetch();
    } catch (e: any) {
      setError(e?.shortMessage ?? e?.message ?? "Transaction failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {ready ? (
        <button className="ghost" onClick={doRefund} disabled={busy}>
          {busy ? "Refunding…" : `Refund unsettled game · ${fmtUsdc(stake)} USDC`}
        </button>
      ) : justRefunded ? (
        // `settled` is now true onchain, so neither branch below applies — this
        // is the confirmation of the refund the user just took.
        <span className="muted" style={{ fontSize: 13 }}>
          {`Refunded ${fmtUsdc(stake)} USDC ✓`}
        </span>
      ) : (
        <span className="muted" style={{ fontSize: 13 }}>
          {`Unsettled game · ${fmtUsdc(stake)} USDC · refundable in ${hoursUntil(windowOpensAt)}`}
        </span>
      )}
      {error ? <span style={{ color: "#e06c6c", fontSize: 12 }}>{error}</span> : null}
    </div>
  );
}

/** Coarse "in about N hours/minutes" for the pending line. */
function hoursUntil(ts: number): string {
  const secs = Math.max(0, ts - Math.floor(Date.now() / 1000));
  if (secs >= 3600) {
    const h = Math.ceil(secs / 3600);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const m = Math.max(1, Math.ceil(secs / 60));
  return `${m} minute${m === 1 ? "" : "s"}`;
}
