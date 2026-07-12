"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";

import { TournamentClaim } from "@/components/TournamentClaim";
import { fetchClaimableTournaments } from "@/lib/tournaments";

type Candidate = { id: string; name: string; status: string };

/** Tournament payouts / refunds, surfaced alongside the bankroll (they credit
 *  the same escrow balance) instead of scattered across the tournament page.
 *  Discovers the connected wallet's finished buy-in tournaments and renders a
 *  claim / refund per one that has something to collect. Mounted only inside the
 *  open wallet popover, so the discovery fetch is lazy. */
export function ClaimWinnings({ escrow, chainId }: { escrow: `0x${string}`; chainId: number }) {
  const { address, isConnected } = useAccount();
  const [items, setItems] = useState<Candidate[]>([]);
  // Which candidates actually rendered an action — used to hide the header when
  // nothing is claimable (e.g. small fields were credited to bankroll directly).
  const [resolved, setResolved] = useState<Record<string, boolean>>({});

  const onResolved = useCallback((id: string, has: boolean) => {
    setResolved((prev) => (prev[id] === has ? prev : { ...prev, [id]: has }));
  }, []);

  useEffect(() => {
    // Reset the resolved map on every account change so a prior wallet's
    // claimable state can't keep the header visible for the new one.
    setResolved({});
    if (!isConnected || !address) {
      setItems([]);
      return;
    }
    let live = true;
    (async () => {
      try {
        // Server-filtered to this wallet's finished buy-in tournaments;
        // TournamentClaim decides per one whether there's anything to collect.
        const rows = await fetchClaimableTournaments(address);
        if (live) {
          setItems(rows.map((t) => ({ id: t.tournament_id, name: t.name, status: t.status })));
        }
      } catch {
        if (live) setItems([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [address, isConnected]);

  if (!isConnected || !address || items.length === 0) return null;

  // Keep the panel mounted (children need to run their on-chain reads) but hide
  // it until at least one tournament resolves to something claimable.
  const anyClaimable = Object.values(resolved).some(Boolean);

  return (
    <div
      className="panel"
      style={{
        marginTop: 4,
        borderTop: "1px solid var(--border)",
        borderRadius: 0,
        ...(anyClaimable ? {} : { display: "none" }),
      }}
    >
      <b style={{ color: "var(--text-strong)" }}>Tournament winnings</b>
      <div style={{ display: "grid", gap: 10, marginTop: 8 }}>
        {items.map((t) => (
          <TournamentClaim
            key={t.id}
            tid={t.id}
            status={t.status}
            label={t.name}
            escrow={escrow}
            chainId={chainId}
            onResolved={(has) => onResolved(t.id, has)}
          />
        ))}
      </div>
    </div>
  );
}
