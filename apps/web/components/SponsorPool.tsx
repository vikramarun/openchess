"use client";

import { useState } from "react";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";

import { ESCROW_ABI, fmtUsdc, parseUsdc, tidToBytes32 } from "@/lib/escrow";
import { rememberSponsorship } from "@/lib/sponsorships";
import { useAvailable } from "@/lib/useBankroll";
import { useEnsureChain } from "@/lib/useEnsureChain";

/** Fund a tournament's prize pool.
 *
 *  The money comes from the sponsor's own **escrow bankroll**, not from their
 *  wallet — `sponsorTournament` moves an unlocked balance that is already inside
 *  the contract, so a sponsor with USDC in their wallet and nothing deposited
 *  has to deposit first. That is the one thing worth being explicit about here,
 *  because the transaction reverts with `InsufficientUnlocked` and the wallet
 *  gives no hint why.
 *
 *  Sent by the browser, never the server: it is the caller's own money, so it
 *  needs no oracle. The server learns the new pool by polling the chain, which
 *  is why the figure on the page can lag a sponsorship by a few seconds.
 */
export function SponsorPool({
  tid,
  escrow,
  chainId: expected,
  onFunded,
}: {
  tid: string;
  escrow: `0x${string}`;
  chainId: number;
  /** Fired after the receipt lands, so the page can re-poll the pool. */
  onFunded?: () => void;
}) {
  const { address, isConnected } = useAccount();
  const ensureChain = useEnsureChain();
  const publicClient = usePublicClient({ chainId: expected });
  const { writeContractAsync } = useWriteContract();
  const { available, refetch: refetchAvailable } = useAvailable(escrow);

  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const tidHex = tidToBytes32(tid);
  const { data: mine, refetch: refetchMine } = useReadContract({
    address: escrow,
    abi: ESCROW_ABI,
    functionName: "sponsorship",
    args: address ? [tidHex, address] : undefined,
    query: { enabled: !!address && isConnected },
  });
  const already = (mine as bigint | undefined) ?? 0n;

  if (!isConnected || !address) {
    return (
      <span className="muted" style={{ fontSize: 13 }}>
        Sign in to sponsor this pool.
      </span>
    );
  }

  const submit = async () => {
    setError(null);
    setDone(null);
    let base: bigint;
    try {
      base = parseUsdc(amount);
    } catch {
      return setError("Enter an amount in USDC.");
    }
    if (base <= 0n) return setError("Enter an amount above zero.");
    // Checked here as well as onchain so the sponsor gets a sentence instead of
    // a bare revert — and so we can name the actual cause, which is almost
    // always "the money is in your wallet, not your balance".
    if (available != null && base > available)
      return setError(
        `That's more than your available balance (${fmtUsdc(available)} USDC). Deposit first from the wallet menu.`,
      );

    setBusy(true);
    try {
      await ensureChain(expected);
      const hash = await writeContractAsync({
        address: escrow,
        abi: ESCROW_ABI,
        functionName: "sponsorTournament",
        args: [tidHex, base],
      });
      await publicClient!.waitForTransactionReceipt({ hash });
      // Recorded only after the receipt: a listed sponsorship that never landed
      // would offer a reclaim button for money that was never moved.
      rememberSponsorship(address, tid);
      setDone(`Added ${fmtUsdc(base)} USDC to the pool.`);
      setAmount("");
      refetchMine();
      refetchAvailable();
      onFunded?.();
    } catch (e: any) {
      setError(e?.shortMessage ?? e?.message ?? "Transaction failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="offer-form" style={{ margin: 0 }}>
        <label className="of-field">
          <span className="muted">Sponsor the pool (USDC)</span>
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="100"
            style={{ width: 140 }}
          />
        </label>
        <button className="primary" onClick={submit} disabled={busy || !amount.trim()}>
          {busy ? "Funding…" : "Add to pool"}
        </button>
      </div>
      <span className="muted" style={{ fontSize: 12 }}>
        {already > 0n ? `You've put in ${fmtUsdc(already)} USDC. ` : ""}
        Comes from your escrow balance
        {available != null ? ` (${fmtUsdc(available)} USDC available)` : ""}. Sponsorship can&apos;t
        be taken back once the field is playing for it — if the tournament never settles, you
        reclaim it after the timeout.
      </span>
      {error && <span style={{ color: "#e06c6c", fontSize: 12 }}>{error}</span>}
      {done && <span style={{ color: "var(--accent)", fontSize: 12 }}>{done}</span>}
    </div>
  );
}
