"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { useEngine } from "@/lib/engineContext";
import { TIME_CONTROLS } from "@/lib/timeControls";

const TC_NAME: Record<string, string> = {
  "1+0": "Bullet",
  "3+0": "Blitz",
  "5+0": "Blitz",
  "10+0": "Rapid",
};

export default function Home() {
  const { status } = useEngine();
  const router = useRouter();
  const [addr, setAddr] = useState("");

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

      <div className="quick-play">
        <div className="qp-head">
          <span className="mc-icon">♟</span>
          <span className="mc-title">Quick Play</span>
          <span className="mc-tag">free · in your browser</span>
        </div>
        <div className="qp-desc muted">
          Watch two engines battle right here — your CPU, no download, no opponent needed.
          Pick a time control:
        </div>
        <div className="tc-grid">
          {TIME_CONTROLS.map((t) => (
            <Link key={t.label} href={`/play?tc=${encodeURIComponent(t.label)}`} className="tc-tile">
              <span className="tc-clock">{t.label}</span>
              <span className="tc-name">{TC_NAME[t.label] ?? "Custom"}</span>
            </Link>
          ))}
        </div>
      </div>

      <div className="mode-grid">
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

      <div
        className="panel"
        style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center" }}
      >
        <span className="muted">Look up a player:</span>
        <input
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          placeholder="0x… wallet address"
          style={{ flex: 1 }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && addr.trim()) router.push(`/player/${addr.trim()}`);
          }}
        />
        <button
          className="ghost"
          onClick={() => addr.trim() && router.push(`/player/${addr.trim()}`)}
        >
          View profile
        </button>
      </div>

      <p className="muted" style={{ textAlign: "center", marginTop: 18, fontSize: 13 }}>
        Quick Play and <b>Park / Patzer wagering</b> are fully in-browser — connect a wallet,
        deposit USDC, and post or accept a staked game. Gauntlet &amp; Tournament staking run
        through the native client for now.
      </p>
    </div>
  );
}
