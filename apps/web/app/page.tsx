"use client";

import Link from "next/link";

import { useEngine } from "@/lib/engineContext";

export default function Home() {
  const { status } = useEngine();

  const banner =
    status === "ready" ? (
      <span>
        Your engine is <b>ready</b> — Stockfish,{" "}
        <span className="free">running in your browser for free</span>. No download, no
        server cost.
      </span>
    ) : status === "loading" ? (
      <span>Loading Stockfish in your browser…</span>
    ) : status === "error" ? (
      <span>
        Couldn’t load the in-browser engine — you can still bring your own with the
        native client.
      </span>
    ) : (
      <span>Preparing your engine…</span>
    );

  return (
    <div className="container">
      <div className="hero">
        <h1>
          <span className="king">♞</span> OpenChess
        </h1>
        <p>
          Machines play. You wager. Bring your own engine — or use the one running in
          your browser right now — and stake USDC on Base, settled non-custodially.
        </p>
      </div>

      <div className="engine-banner">
        <span className={`dot ${status}`} />
        {banner}
      </div>

      <div className="mode-grid">
        <Link href="/play" className="mode-card">
          <div className="mc-top">
            <span className="mc-icon">♟</span>
            <span className="mc-title">Quick Play</span>
            <span className="mc-tag">free</span>
          </div>
          <div className="mc-desc">
            Watch two engines battle, right here in your browser. Zero setup — proves the
            whole stack with no download and no opponent needed.
          </div>
        </Link>

        <Link href="/park" className="mode-card">
          <div className="mc-top">
            <span className="mc-icon">🅿️</span>
            <span className="mc-title">Park / Patzer</span>
            <span className="mc-tag">wager</span>
          </div>
          <div className="mc-desc">
            Post a game at a price. Someone accepts, both stake, the winner takes the pot
            (minus a small rake).
          </div>
        </Link>

        <Link href="/gauntlet" className="mode-card">
          <div className="mc-top">
            <span className="mc-icon">🔥</span>
            <span className="mc-title">Gauntlet</span>
            <span className="mc-tag">wager</span>
          </div>
          <div className="mc-desc">
            Your engine plays back-to-back games at a fixed tier (10¢ … $100) until you
            stop. Lock a bankroll once, net-settle on-chain.
          </div>
        </Link>

        <Link href="/tournament" className="mode-card">
          <div className="mc-top">
            <span className="mc-icon">🏆</span>
            <span className="mc-title">Tournament</span>
            <span className="mc-tag">wager</span>
          </div>
          <div className="mc-desc">
            Buy in to a prize pool. Round-robin (Swiss & knockout soon). Pool distributed
            on-chain by final standings.
          </div>
        </Link>
      </div>

      <p className="muted" style={{ textAlign: "center", marginTop: 18, fontSize: 13 }}>
        Quick Play is fully in-browser. Wager modes are in <b>beta</b> — staked play runs
        through the native client today; in-browser wagering is coming.
      </p>
    </div>
  );
}
