"use client";

import { useEffect, useRef, useState } from "react";

import { Chessboard } from "@/components/Chessboard";
import { CoinFlip } from "@/components/CoinFlip";
import { PlayerBar } from "@/components/PlayerBar";
import { material, sideToMoveFromFen } from "@/lib/board";
import {
  DEMO_COIN,
  DEMO_END,
  DEMO_FRAMES,
  DEMO_STAKE,
  DEMO_START,
  beatMs,
  nextBeat,
  type DemoState,
} from "@/lib/demoReel";
import { fmtUsdc, profitForStake } from "@/lib/escrow";

/** The landing page's opening act: a coin toss, a game that ends in mate, and
 *  the winner getting paid.
 *
 *  It imports NOTHING from lib/engine, lib/useEval or lib/engineContext, and
 *  scripts/demoReel.test.ts asserts that it stays that way. The eval bar here is
 *  driven by canned numbers rather than a search, which is what lets a real
 *  <EvalBar> render on a cold mobile load without the 7 MB wasm behind it.
 *
 *  Three things stop it running when it shouldn't:
 *    - a real game — app/page.tsx renders this inside the `!inGame` branch, so
 *      starting one unmounts it and the effect cleanup below kills the timer and
 *      destroys the Chessground instance;
 *    - a hidden tab;
 *    - being scrolled off screen.
 *  On return it restarts from the coin rather than resuming: for a reel that is
 *  the better viewing, and it removes a whole class of resume-state bugs.
 *
 *  `onFinishedChange` reports when the game is over, because the result card
 *  renders in the pitch column next to the board rather than inside this
 *  component — see `DemoResult` below. */
export function HomeDemo({ onFinishedChange }: { onFinishedChange?: (done: boolean) => void }) {
  const [state, setState] = useState<DemoState>(DEMO_START);
  const [visible, setVisible] = useState(true);
  const [inView, setInView] = useState(true);
  const [reduced, setReduced] = useState(false);
  const host = useRef<HTMLElement>(null);

  // Read in an effect, never in a state initializer: the initial state has to
  // match the server render, which knows nothing about the viewer's settings.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const sync = () => setVisible(!document.hidden);
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  useEffect(() => {
    const el = host.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => setInView(entries[0]?.isIntersecting ?? true), {
      threshold: 0.25,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const running = visible && inView;

  // One self-rescheduling setTimeout, one handle. Not setInterval — a fixed
  // cadence can't give a sacrifice a longer beat than a book move, and it drifts
  // under load. Not requestAnimationFrame — chessground already owns the
  // per-frame piece interpolation, this needs 33 discrete ticks, and rAF is
  // throttled to 0Hz in a background tab, which stalls a state machine instead
  // of tearing it down.
  useEffect(() => {
    if (!running) return;
    if (reduced) {
      setState(DEMO_END);
      return;
    }

    let alive = true;
    let handle: number | undefined;
    const step = (s: DemoState) => {
      if (!alive) return;
      setState(s);
      const ms = beatMs(s);
      if (!Number.isFinite(ms)) return;
      handle = window.setTimeout(() => {
        const n = nextBeat(s);
        if (n) step(n);
      }, ms);
    };
    step(DEMO_START);
    return () => {
      alive = false;
      window.clearTimeout(handle);
    };
  }, [running, reduced]);

  const frame = DEMO_FRAMES[state.ply];
  const playing = state.phase === "play";
  const finished = state.phase === "result" || state.phase === "hold";
  const turn = sideToMoveFromFen(frame.fen);
  const mat = material(frame.fen);

  useEffect(() => {
    onFinishedChange?.(finished);
  }, [finished, onFinishedChange]);

  return (
    <section className="demo" ref={host} aria-label="Demo: how a staked bot game plays out">
      <PlayerBar
        color="black"
        name="House Bot"
        engine="Stockfish"
        clockMs={frame.blackMs}
        active={playing && turn === "black"}
        captured={mat.blackCaptured}
        edge={-mat.advantage}
      />

      <div className="demo-board">
        <Chessboard
          // Remounts under reduced motion so the new instance is CONSTRUCTED at
          // the final position. Child effects run before parent effects, so
          // without this Chessground builds at the start position first and then
          // animates all 33 plies at once when the state jumps to the end —
          // precisely what reduced motion asks us not to do.
          key={reduced ? "static" : "reel"}
          fen={frame.fen}
          orientation="white"
          lastMove={frame.lastMove}
          check={frame.check}
          showEval
          evalScore={frame.score}
        />
        {(state.phase === "coin" || state.phase === "call") && (
          <CoinFlip lands={DEMO_COIN} called={state.phase === "call"} />
        )}
      </div>

      <PlayerBar
        color="white"
        name="Your bot"
        engine="Stockfish"
        clockMs={frame.whiteMs}
        active={playing && turn === "white"}
        captured={mat.whiteCaptured}
        edge={mat.advantage}
      />
    </section>
  );
}

/** The result, for the slot beside the board.
 *
 *  Split out of `HomeDemo` because it renders in the pitch column rather than
 *  under the board, and the two are different grid children — `finished` comes
 *  back up through `onFinishedChange` rather than either of them owning the
 *  other. Same reason `Lobby` reports through `onActiveChange`.
 *
 *  Always rendered, hidden until it is due: that is what reserves its height.
 *  It appears ~28s in, CLS accumulates over a page's whole lifetime, and a fixed
 *  min-height is a guess that under-reserves at some viewport. */
export function DemoResult({ finished }: { finished: boolean }) {
  return (
    <div className={`demo-payout${finished ? " on" : ""}`}>
      <div className="demo-payout-top">
        <span className="demo-payout-head">Doubled up!</span>
        <span className="demo-payout-amt">+{fmtUsdc(profitForStake(DEMO_STAKE))} USDC</span>
      </div>
      <div className="demo-payout-math">
        {/* The figure above is the real `profitForStake`, so it already carries
            the 1% fee even though this line doesn't spell it out — which is why
            it can't be a hardcoded string. fmtUsdc also trims trailing zeros, so
            the stake reads "5" and needs its unit. */}
        You won the pot! Your {fmtUsdc(DEMO_STAKE)} USDC stake back, plus theirs.
      </div>
    </div>
  );
}
