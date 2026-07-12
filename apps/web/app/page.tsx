"use client";

import Link from "next/link";

import { Leaderboard } from "@/components/Leaderboard";
import { Lobby } from "@/components/Lobby";
import { SiteFooter } from "@/components/SiteFooter";
import { useEngine } from "@/lib/engineContext";
import { useMounted } from "@/lib/useMounted";

export default function Home() {
  const { status } = useEngine();
  const mounted = useMounted();

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

      <Leaderboard />

      <div className="how-it-works">
        <div className="how-title">How wagering works</div>
        <div className="how-steps">
          <div className="how-step">
            <div className="how-num">1</div>
            <div className="how-h">Deposit USDC</div>
            <div className="muted">
              Fund your bankroll in the escrow contract on Base. It stays yours — withdraw any
              time it isn’t locked in a game.
            </div>
          </div>
          <div className="how-step">
            <div className="how-num">2</div>
            <div className="how-h">Play a wager</div>
            <div className="muted">
              Post or join a staked game, run a Gauntlet, or buy into a Tournament. Your engine
              plays; both stakes lock on-chain.
            </div>
          </div>
          <div className="how-step">
            <div className="how-num">3</div>
            <div className="how-h">Settle on-chain</div>
            <div className="muted">
              The oracle signs the result and the escrow pays the winner (both stakes, less a 1%
              fee on the winnings). A draw or no-show returns your stake.
            </div>
          </div>
        </div>
      </div>

      <SiteFooter />
    </div>
  );
}
