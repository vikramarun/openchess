"use client";

import { useCallback, useState } from "react";

import { HomeDemo } from "@/components/HomeDemo";
import { Lobby } from "@/components/Lobby";
import { Logo } from "@/components/Logo";
import { useEngine } from "@/lib/engineContext";
import { useMounted } from "@/lib/useMounted";

export default function Home() {
  const { status } = useEngine();
  const mounted = useMounted();
  // The lobby swaps itself for a board when you're in a game. The pitch above it
  // — hero, demo reel and engine banner — is most of a viewport, which pushed
  // your own board off the bottom of the fold, the result banner to ~525px and
  // "Back to lobby" to ~1000px, the same height that put the top nav out of
  // reach. Stand it down while you play; it comes back when you do.
  const [inGame, setInGame] = useState(false);
  // Stable identity: Lobby reports through this from an effect, and a fresh
  // callback each render would re-run it every render.
  const onActiveChange = useCallback((active: boolean) => setInGame(active), []);

  const scrollToPlay = () =>
    document.getElementById("play")?.scrollIntoView({ behavior: "smooth", block: "start" });

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
      <span>
        Stockfish, <span className="free">running in your browser for free</span>. No
        download until you play or turn on the eval bar.
      </span>
    );

  return (
    <div className="container">
      {inGame ? (
        // The hero's <h1> is the only heading this page has, so hiding it leaves
        // the document with none while you play. Keep one for anyone navigating
        // by headings — visually there's a whole board saying it.
        <h1 className="sr-only">Your game</h1>
      ) : (
        // <HomeDemo> lives INSIDE this branch on purpose. Unmounting is its
        // primary teardown: the setTimeout chain driving the reel and the
        // Chessground instance both die in its effect cleanup. Never hoist it
        // above this ternary — that runs a marketing reel under a live money
        // game.
        <section className="home-hero">
          <div className="home-hero-board">
            <HomeDemo />
          </div>
          <div className="home-hero-pitch">
            <h1 className="display d2">
              <Logo size={38} className="mark" /> OpenChess
            </h1>
            <p className="home-lede">Two bots. One coin flip. Winner takes the pot.</p>
            <p className="home-sub muted">
              Bring your own engine or use the one already in your browser. Play free, or
              stake USDC and settle onchain.
            </p>
            <div className="home-cta">
              <button type="button" className="primary" onClick={scrollToPlay}>
                Play a free game
              </button>
              <a className="ghost" href="#how-it-works">
                How it works
              </a>
            </div>
            <div className="engine-banner">
              <span className={`dot ${status}`} />
              {banner}
            </div>
          </div>
        </section>
      )}

      <div id="play">
        {mounted ? <Lobby view="quickplay" onActiveChange={onActiveChange} /> : null}
      </div>

      {/* The pitch to someone who ISN'T playing yet. Under a live board it's both
          noise and thousands of pixels of page. Stood down with the hero. */}
      {!inGame && (
        <div className="how-it-works" id="how-it-works">
          <div className="how-title display d3">How stakes work</div>
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
                The oracle signs the result and the escrow pays out. Win and you get your own
                stake back plus your opponent’s, less a 1% fee. Lose and your stake goes to
                them. A draw or no-show returns it untouched.
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
