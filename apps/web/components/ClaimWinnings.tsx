"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";

import { GameRefund } from "@/components/GameRefund";
import { TournamentClaim } from "@/components/TournamentClaim";
import { fetchUnsettledGames, type UnsettledGame } from "@/lib/gameApi";
import { fetchClaimableTournaments } from "@/lib/tournaments";

type Candidate = { id: string; name: string; status: string };

/** Everything the connected wallet can collect from the escrow, surfaced next
 *  to the bankroll (it all credits the same balance) instead of scattered across
 *  the app: tournament payouts/refunds, and refunds for wagered games that were
 *  never settled. Each child decides whether it has anything to show, so this
 *  renders nothing in the common case. Mounted only inside the open wallet
 *  popover, so the discovery fetches are lazy. */
export function ClaimWinnings({ escrow, chainId }: { escrow: `0x${string}`; chainId: number }) {
  const { address, isConnected } = useAccount();
  const [items, setItems] = useState<Candidate[]>([]);
  const [games, setGames] = useState<UnsettledGame[]>([]);
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
      setGames([]);
      return;
    }
    let live = true;
    (async () => {
      // Both server-filtered to this wallet; the child components decide per
      // item whether there is actually anything to collect. Settled
      // independently so a failure on one list doesn't blank the other.
      const [tourns, unsettled] = await Promise.allSettled([
        fetchClaimableTournaments(address),
        fetchUnsettledGames(address),
      ]);
      if (!live) return;
      setItems(
        tourns.status === "fulfilled"
          ? tourns.value.map((t) => ({ id: t.tournament_id, name: t.name, status: t.status }))
          : [],
      );
      setGames(unsettled.status === "fulfilled" ? unsettled.value : []);
    })();
    return () => {
      live = false;
    };
  }, [address, isConnected]);

  if (!isConnected || !address || (items.length === 0 && games.length === 0)) return null;

  // Keep the panel mounted (children need to run their onchain reads) but hide
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
      <b style={{ color: "var(--text-strong)" }}>Payouts &amp; refunds</b>
      <div style={{ display: "grid", gap: 10, marginTop: 8 }}>
        {games.map((g) => (
          <GameRefund
            key={g.game_id}
            gameId={g.game_id}
            escrow={escrow}
            chainId={chainId}
            onResolved={(has) => onResolved(`game:${g.game_id}`, has)}
          />
        ))}
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
