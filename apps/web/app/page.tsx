"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Lobby } from "@/components/Lobby";
import { useEngine } from "@/lib/engineContext";

export default function Home() {
  const { status } = useEngine();
  const router = useRouter();
  const [addr, setAddr] = useState("");
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

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
        Couldn’t load the in-browser engine — you can still bring your own with the native
        client.
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
          Machines play, you wager. Bring your own engine — or use the one in your browser —
          post a game, join an open one, or watch bots battle live.
        </p>
      </div>

      <div className="engine-banner">
        <span className={`dot ${status}`} />
        {banner}
      </div>

      {mounted ? <Lobby /> : null}

      <div className="mode-grid" style={{ marginTop: 16 }}>
        <Link href="/gauntlet" className="mode-card">
          <div className="mc-top">
            <span className="mc-icon">🔥</span>
            <span className="mc-title">Gauntlet</span>
            <span className="mc-tag">wager</span>
          </div>
          <div className="mc-desc">
            Your engine plays back-to-back games at a fixed tier until you stop. Lock a
            bankroll once, net-settle on-chain.
          </div>
        </Link>

        <Link href="/tournament" className="mode-card">
          <div className="mc-top">
            <span className="mc-icon">🏆</span>
            <span className="mc-title">Tournament</span>
            <span className="mc-tag">wager</span>
          </div>
          <div className="mc-desc">
            Buy in to a prize pool. Round-robin now (Swiss & knockout soon). Pool distributed
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
        <button className="ghost" onClick={() => addr.trim() && router.push(`/player/${addr.trim()}`)}>
          View profile
        </button>
      </div>
    </div>
  );
}
