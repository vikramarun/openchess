"use client";

import { useEffect, useState } from "react";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";

import { ESCROW_ABI, fetchClaimProof, fmtUsdc, tidToBytes32, type ClaimProof } from "@/lib/escrow";
import { useEnsureChain } from "@/lib/useEnsureChain";

const ZERO32 = `0x${"0".repeat(64)}`;

/** Collect a tournament's onchain proceeds for the connected wallet: a Merkle
 *  payout claim for a root-settled field, or an entry refund for one that never
 *  settled past the timeout. Both credit the wallet's escrow balance (withdraw
 *  via the Balance panel). Renders nothing unless the wallet actually entered
 *  this tournament and has something to do — safe to drop on any finished card. */
export function TournamentClaim({
  tid,
  status,
  escrow,
  chainId: expected,
  label,
  onResolved,
}: {
  tid: string;
  status: string;
  escrow: `0x${string}`;
  chainId: number;
  /** Optional tournament name shown above the action (for the balance list). */
  label?: string;
  /** Reports whether this tournament actually renders a claimable action, so a
   *  parent list can hide its header when nothing is claimable. */
  onResolved?: (hasAction: boolean) => void;
}) {
  const { address, isConnected } = useAccount();
  const ensureChain = useEnsureChain();
  // Pin the receipt-reading client to the settlement chain: after ensureChain
  // switches, the connected chain's client would otherwise be stale/undefined.
  const publicClient = usePublicClient({ chainId: expected });
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
  // A sponsor is not an entrant, so none of the reads above see them. Read the
  // chain rather than trusting the local record that surfaced this tournament:
  // it is a hint about what to ask, never the authority on what is owed.
  const { data: sponsored, refetch: refetchSponsored } = useReadContract({
    address: escrow,
    abi: ESCROW_ABI,
    functionName: "sponsorship",
    args: address ? [tidHex, address] : undefined,
    ...poll,
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
  // A free-entry (sponsor-funded) tournament has no entry to give back, and the
  // contract refuses `claimRefund` on one outright — so offering the button
  // would be a promise that reverts. The sponsor reclaims their own pool with
  // `refundSponsorship`; an entrant here is owed nothing.
  const refundable = buyIn > 0n;
  const refundReady =
    refundable && !settled && settleTimeout != null && now > openedAt + settleTimeout && !hasClaimed;

  // A root-settled winner is authorized by their Merkle PROOF, not by an onchain
  // entry: a free-entry (sponsor-funded) event never calls `enterTournament` for
  // its players (nothing to lock), so `hasEntered` is false for them — gating the
  // claim on it would strand every free-event prize behind a hand-written
  // contract call. `claimTournament` itself checks only the proof. So a wallet
  // with a proof may act even without an entry; the entry gate still guards the
  // refund/pending branches, which genuinely need a locked buy-in to return.
  const canClaim = rootSet && !!proof;

  // Single source of truth for what this tournament shows — both the rendered
  // node and the parent's header gate derive from it (no duplicated conditions).
  const kind: "claimed" | "claim" | "refund" | "pending" | null =
    !enabled || !exists || (!hasEntered && !canClaim)
      ? null
      : hasClaimed
        ? "claimed"
        : canClaim
          ? "claim"
          : refundReady
            ? "refund"
            : // `paused` counts alongside `abandoned`: the round stopped, the
              // entry is still locked, and the countdown to `claimRefund` runs
              // exactly the same way. A paused tournament nobody resumes is only
              // marked abandoned by a restart, so without this its entrants see
              // nothing at all.
              refundable &&
                (status === "abandoned" || status === "paused") &&
                !settled &&
                settleTimeout != null
              ? "pending"
              : null;

  // A sponsorship reclaim is INDEPENDENT of the entrant actions above: the same
  // wallet can be both (fund the pool, then play in it), and a sponsor who never
  // entered is filtered out by every `hasEntered` check. So it is computed and
  // rendered alongside `kind` rather than folded into it.
  const mySponsorship = (sponsored as bigint | undefined) ?? 0n;
  const sponsorRefundReady =
    enabled &&
    mySponsorship > 0n &&
    !settled &&
    settleTimeout != null &&
    now > openedAt + settleTimeout;

  // Already-claimed is informational only, so it doesn't count toward showing
  // the parent's "Payouts & refunds" header.
  const hasAction = (kind != null && kind !== "claimed") || sponsorRefundReady;
  useEffect(() => {
    onResolved?.(hasAction);
  }, [hasAction, onResolved]);

  if (kind == null && !sponsorRefundReady) return null;

  const run = async (fn: () => Promise<`0x${string}`>) => {
    setError(null);
    setBusy(true);
    try {
      await ensureChain(expected);
      const hash = await fn();
      // waitForTransactionReceipt RESOLVES for a reverted tx (it only rejects on
      // timeout/RPC error), so check the status — otherwise a reverted claim or
      // refund would silently refetch and look like it worked.
      const receipt = await publicClient!.waitForTransactionReceipt({ hash });
      if (receipt.status === "reverted") throw new Error("The transaction reverted onchain.");
      refetchTourn();
      refetchClaimed();
      refetchSponsored();
    } catch (e: any) {
      setError(e?.shortMessage ?? e?.message ?? "Transaction failed.");
    } finally {
      setBusy(false);
    }
  };

  const doClaim = () =>
    proof &&
    address &&
    run(() =>
      writeContractAsync({
        chainId: expected,
        account: address,
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
        chainId: expected,
        account: address,
        address: escrow,
        abi: ESCROW_ABI,
        functionName: "claimRefund",
        args: [tidHex, address],
      }),
    );

  const doSponsorRefund = () =>
    address &&
    run(() =>
      writeContractAsync({
        chainId: expected,
        account: address,
        address: escrow,
        abi: ESCROW_ABI,
        functionName: "refundSponsorship",
        args: [tidHex, address],
      }),
    );

  const errLine = error ? <span style={{ color: "#e06c6c", fontSize: 12 }}>{error}</span> : null;

  const sponsorNode = sponsorRefundReady ? (
    <button className="ghost" onClick={doSponsorRefund} disabled={busy}>
      {busy ? "Reclaiming…" : `Reclaim sponsorship · ${fmtUsdc(mySponsorship)} USDC`}
    </button>
  ) : null;

  // The entrant action/state, built from `kind` above. Stays null for a wallet
  // that only sponsored — it never entered, so none of these apply and falling
  // through to the "pending" branch would promise it a refund it isn't owed.
  let node: React.ReactNode = null;
  if (kind === "claimed") {
    node = (
      <span className="muted" style={{ fontSize: 13 }}>
        {rootSet ? "Payout claimed ✓" : "Refund claimed ✓"}
      </span>
    );
  } else if (kind === "claim") {
    // Winner of a root-settled field → Merkle claim (proof is set when kind==="claim").
    node = (
      <button className="primary" onClick={doClaim} disabled={busy}>
        {busy ? "Claiming…" : `Claim ${fmtUsdc(proof!.amount)} USDC`}
      </button>
    );
  } else if (kind === "refund") {
    // Never settled past the timeout → reclaim the entry.
    node = (
      <button className="ghost" onClick={doRefund} disabled={busy}>
        {busy ? "Refunding…" : `Claim refund · ${fmtUsdc(buyIn)} USDC`}
      </button>
    );
  } else if (kind === "pending") {
    // abandoned but the refund window hasn't opened yet — say when.
    const left = openedAt + settleTimeout! - now;
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

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
      {label && (
        <span className="muted" style={{ fontSize: 12 }}>
          {label}
        </span>
      )}
      {node}
      {sponsorNode}
      {errLine}
    </span>
  );
}
