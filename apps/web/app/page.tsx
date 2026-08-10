"use client";

import { useCallback, useState } from "react";

import { DemoResult, HomeDemo } from "@/components/HomeDemo";
import { Lobby } from "@/components/Lobby";
import { Logo } from "@/components/Logo";
import { RequireSignIn } from "@/components/SignInGate";
import { useMounted } from "@/lib/useMounted";

export default function Home() {
  const mounted = useMounted();
  // The lobby swaps itself for a board when you're in a game. The pitch above it
  // — hero and demo reel — is most of a viewport, which pushed your own board off
  // the bottom of the fold, the result banner to ~525px and "Back to lobby" to
  // ~1000px, the same height that put the top nav out of reach. Stand it down
  // while you play; it comes back when you do.
  const [inGame, setInGame] = useState(false);
  // The reel's board and its result sit in different columns of .home-hero, so
  // the phase travels up here rather than one of them nesting the other.
  const [demoDone, setDemoDone] = useState(false);
  // Stable identity: both children report through these from an effect, and a
  // fresh callback each render would re-run it every render.
  const onActiveChange = useCallback((active: boolean) => {
    setInGame(active);
    // Entering a game unmounts the hero (and its DemoResult). Clear the finished
    // flag now so that when the hero REMOUNTS after the game, it doesn't paint a
    // stale "Doubled up! +X USDC" card for a frame before HomeDemo re-reports —
    // which is especially jarring right after a real, possibly lost, staked game.
    if (active) setDemoDone(false);
  }, []);
  const onFinishedChange = useCallback((done: boolean) => setDemoDone(done), []);

  const scrollToPlay = () =>
    document.getElementById("play")?.scrollIntoView({ behavior: "smooth", block: "start" });

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
            <HomeDemo onFinishedChange={onFinishedChange} />
          </div>
          <div className="home-hero-pitch">
            <h1 className="display d2">
              <Logo size={38} className="mark" /> OpenChess
            </h1>
            <p className="home-lede">Two bots. One winner. May the best engine win.</p>
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
            {/* The result lands here, in the slot the engine-status banner used
                to hold. Rendered from the first paint and hidden until it is
                due, so it reserves its own height instead of shoving the page
                down ~28 seconds after it looked settled. */}
            <DemoResult finished={demoDone} />
          </div>
        </section>
      )}

      {/* The PAGE stays public — the hero, the reel and "How stakes work" are
          the pitch, and a wall in front of them would be a wall in front of the
          only thing that explains the product. It is the Play card that needs an
          account: everything it can start seats a real player, lands in a
          history and moves an Elo. */}
      <div id="play">
        {mounted ? (
          <RequireSignIn
            title="Sign in to play"
            lede="Post a challenge, take the House Bot's seat, or stake USDC — all of it is bound to your account, so your games and your rating are yours."
          >
            <Lobby view="quickplay" onActiveChange={onActiveChange} />
          </RequireSignIn>
        ) : null}
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
          {/* What the engine-status banner in the hero used to say, reduced to
              the part that is a selling point rather than a status readout. */}
          <p className="how-note muted">
            The engine is Stockfish,{" "}
            <span className="free">running in your browser for free</span>, entirely
            customizable to you.
          </p>
        </div>
      )}
    </div>
  );
}
