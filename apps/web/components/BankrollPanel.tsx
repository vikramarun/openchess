"use client";

import { useState } from "react";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useReadContract,
  useWriteContract,
} from "wagmi";

import { ERC20_ABI, ESCROW_ABI, fmtUsdc, parseUsdc } from "@/lib/escrow";
import { useEnsureChain } from "@/lib/useEnsureChain";

/** Deposit / withdraw USDC into the non-custodial escrow bankroll, and show the
 *  available (unlocked) balance. Funds live in the contract — never with us. */
export function BankrollPanel({
  escrow,
  chainId: expected,
}: {
  escrow: `0x${string}`;
  chainId: number;
}) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const ensureChain = useEnsureChain();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<"" | "deposit" | "withdraw">("");
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<string>("");

  const enabled = !!address && isConnected;
  const q = { query: { enabled, refetchInterval: 8000 } } as const;

  const { data: token } = useReadContract({
    address: escrow,
    abi: ESCROW_ABI,
    functionName: "token",
    query: { enabled },
  });
  const { data: available, refetch: refetchAvail } = useReadContract({
    address: escrow,
    abi: ESCROW_ABI,
    functionName: "available",
    args: address ? [address] : undefined,
    ...q,
  });
  const { data: locked, refetch: refetchLocked } = useReadContract({
    address: escrow,
    abi: ESCROW_ABI,
    functionName: "locked",
    args: address ? [address] : undefined,
    ...q,
  });
  const { data: walletBal, refetch: refetchWallet } = useReadContract({
    address: token as `0x${string}` | undefined,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: enabled && !!token, refetchInterval: 8000 },
  });
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: token as `0x${string}` | undefined,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address && token ? [address, escrow] : undefined,
    query: { enabled: enabled && !!token },
  });

  const refetchAll = () => {
    refetchAvail();
    refetchLocked();
    refetchWallet();
    refetchAllowance();
  };

  const doDeposit = async () => {
    setError(null);
    let amt: bigint;
    try {
      amt = parseUsdc(amount);
    } catch {
      setError("enter a valid amount");
      return;
    }
    if (amt <= 0n) return setError("amount must be positive");
    setBusy("deposit");
    try {
      await ensureChain(expected);
      if (!token) throw new Error("token not loaded");
      if (((allowance as bigint) ?? 0n) < amt) {
        setStage("approving USDC…");
        const h = await writeContractAsync({
          address: token as `0x${string}`,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [escrow, amt],
        });
        await publicClient!.waitForTransactionReceipt({ hash: h });
      }
      setStage("depositing…");
      const h2 = await writeContractAsync({
        address: escrow,
        abi: ESCROW_ABI,
        functionName: "deposit",
        args: [amt],
      });
      await publicClient!.waitForTransactionReceipt({ hash: h2 });
      setAmount("");
      refetchAll();
    } catch (e: any) {
      setError(e?.shortMessage ?? e?.message ?? "deposit failed");
    } finally {
      setBusy("");
      setStage("");
    }
  };

  const doWithdraw = async () => {
    setError(null);
    let amt: bigint;
    try {
      amt = parseUsdc(amount);
    } catch {
      setError("enter a valid amount");
      return;
    }
    if (amt <= 0n) return setError("amount must be positive");
    if (amt > ((available as bigint) ?? 0n)) return setError("exceeds available balance");
    setBusy("withdraw");
    try {
      await ensureChain(expected);
      setStage("withdrawing…");
      const h = await writeContractAsync({
        address: escrow,
        abi: ESCROW_ABI,
        functionName: "withdraw",
        args: [amt],
      });
      await publicClient!.waitForTransactionReceipt({ hash: h });
      setAmount("");
      refetchAll();
    } catch (e: any) {
      setError(e?.shortMessage ?? e?.message ?? "withdraw failed");
    } finally {
      setBusy("");
      setStage("");
    }
  };

  if (!enabled) {
    return (
      <div className="panel">
        <b style={{ color: "var(--text-strong)" }}>Bankroll</b>
        <div className="muted" style={{ marginTop: 6 }}>
          Connect your wallet to deposit USDC and play for stakes.
        </div>
      </div>
    );
  }

  const wrongChain = chainId !== expected;

  return (
    <div className="panel">
      <b style={{ color: "var(--text-strong)" }}>Bankroll</b>
      <div className="bankroll-stats">
        <div className="bk">
          <span className="bk-v">{fmtUsdc(available as bigint)}</span>
          <span className="bk-l">Available (USDC)</span>
        </div>
        <div className="bk">
          <span className="bk-v">{fmtUsdc(locked as bigint)}</span>
          <span className="bk-l">Locked in games</span>
        </div>
        <div className="bk">
          <span className="bk-v">{fmtUsdc(walletBal as bigint)}</span>
          <span className="bk-l">In wallet</span>
        </div>
      </div>

      {wrongChain && (
        <div className="muted" style={{ marginTop: 8, color: "#e0a96c" }}>
          Wrong network — deposits will prompt a switch to chain {expected}.
        </div>
      )}

      <div className="bankroll-actions">
        <input
          inputMode="decimal"
          placeholder="amount in USDC"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={!!busy}
        />
        <button className="primary" onClick={doDeposit} disabled={!!busy}>
          {busy === "deposit" ? stage || "Depositing…" : "Deposit"}
        </button>
        <button className="ghost" onClick={doWithdraw} disabled={!!busy}>
          {busy === "withdraw" ? stage || "Withdrawing…" : "Withdraw"}
        </button>
      </div>
      {error && <div style={{ color: "#e06c6c", fontSize: 13, marginTop: 6 }}>{error}</div>}
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        Funds stay in the escrow contract; you can withdraw anything not locked in an active
        game.
      </div>
    </div>
  );
}
