"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { SERVER_HTTP } from "@/lib/config";

type Offer = {
  offer_id: string;
  poster_addr: string | null;
  stake: string | null;
  initial_secs: number;
  increment_secs: number;
};

export default function ParkPage() {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const r = await fetch(`${SERVER_HTTP}/park/offers`);
        if (r.ok && live) setOffers(await r.json());
      } catch {
        if (live) setErr("server unreachable");
      }
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="container">
      <div className="hero" style={{ paddingBottom: 8 }}>
        <h1>🅿️ Park / Patzer</h1>
        <p>
          Post a game at a price. Someone accepts, both stake, the winner takes the pot
          minus a small rake — settled non-custodially on Base.
        </p>
      </div>

      <div className="panel" style={{ marginBottom: 18 }}>
        <b style={{ color: "var(--text-strong)" }}>How it works</b>
        <ol className="muted" style={{ lineHeight: 1.8 }}>
          <li>Connect a wallet and deposit USDC into the escrow once.</li>
          <li>Post an offer at a stake + time control (your seat is bound to your wallet).</li>
          <li>An opponent accepts and stakes; both engines play; the server is the authority.</li>
          <li>The signed result settles on-chain — winner takes the pot.</li>
        </ol>
        <p className="muted">
          Staked play runs through the <Link href="/play">native client</Link> or your
          browser engine once a wallet is connected. Try <Link href="/play">Quick Play</Link>{" "}
          first — it’s free and needs no setup.
        </p>
      </div>

      <div className="panel">
        <b style={{ color: "var(--text-strong)" }}>Open offers</b>
        {err && <div style={{ color: "var(--danger)" }}>{err}</div>}
        {offers.length === 0 ? (
          <div className="muted" style={{ marginTop: 8 }}>
            No open offers right now.
          </div>
        ) : (
          <table style={{ width: "100%", marginTop: 10, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--muted)", fontSize: 13 }}>
                <th>Poster</th>
                <th>Stake</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {offers.map((o) => (
                <tr key={o.offer_id} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ padding: "8px 0" }}>
                    {o.poster_addr ? `${o.poster_addr.slice(0, 8)}…` : "casual"}
                  </td>
                  <td>{o.stake ? `${o.stake} (base units)` : "—"}</td>
                  <td>
                    {o.initial_secs}+{o.increment_secs}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
