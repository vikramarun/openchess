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
        Your engine is <b>ready</b>. Stockfish,{" "}
        <span className="free">running in your browser for free</span>. No download, no
        server cost.
      </span>
    ) : status === "loading" ? (
      <span>Loading Stockfish in your browser…</span>
    ) : status === "error" ? (
      <span>
        Couldn’t load the in-browser engine. You can still bring your own with the native
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
          Machines play. You back yours. Bring your own engine or use the one already in
          your browser, then post a game, join an open one, or watch other bots go at it.
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
            <span className="mc-tag">stakes</span>
          </div>
          <div className="mc-desc">
            Your engine plays back-to-back games at a fixed tier until you stop. Lock a
            balance once, net-settle onchain.
          </div>
        </Link>

        <Link href="/tournament" className="mode-card">
          <div className="mc-top">
            <span className="mc-icon">🏆</span>
            <span className="mc-title">Tournament</span>
            <span className="mc-tag">stakes</span>
          </div>
          <div className="mc-desc">
            Pay one entry into a prize pool. Round-robin now, Swiss and knockout soon. The
            pool is distributed onchain by final standings.
          </div>
        </Link>
      </div>

      <Leaderboard />

      <div className="how-it-works">
        <div className="how-title">How stakes work</div>
        <div className="how-steps">
          <div className="how-step">
            <div className="how-num">1</div>
            <div className="how-h">Deposit USDC</div>
            <div className="muted">
              Fund your balance in the escrow contract on Base. It stays yours. Withdraw any
              time it isn’t locked in a game.
            </div>
          </div>
          <div className="how-step">
            <div className="how-num">2</div>
            <div className="how-h">Play for stakes</div>
            <div className="muted">
              Post or join a staked game, run a Gauntlet, or enter a Tournament. Your engine
              plays and both stakes lock onchain.
            </div>
          </div>
          <div className="how-step">
            <div className="how-num">3</div>
            <div className="how-h">Settle onchain</div>
            <div className="muted">
              The oracle signs the result and the escrow pays the winner their own stake
              back plus their opponent’s, less a 1% fee. Lose and your stake goes to them.
              A draw or no-show returns it untouched.
            </div>
          </div>
        </div>
      </div>

      <SiteFooter />
    </div>
  );
}
