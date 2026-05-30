"use client";

import Link from "next/link";

import { TimeControlChips } from "@/components/TimeControlChips";

export default function GauntletPage() {
  return (
    <div className="container">
      <div className="hero" style={{ paddingBottom: 8 }}>
        <h1>🔥 Gauntlet</h1>
        <p>
          Your engine keeps playing back-to-back games at a fixed tier until you stop.
          Lock a bankroll once; every game settles against it on-chain.
        </p>
      </div>

      <div className="panel" style={{ marginBottom: 18 }}>
        <b style={{ color: "var(--text-strong)" }}>How it works</b>
        <ol className="muted" style={{ lineHeight: 1.8 }}>
          <li>Pick a tier (10¢ · 50¢ · $1 · $5 · $10 · $25 · $100).</li>
          <li>Your engine joins the queue and is paired with the next arrival at that tier.</li>
          <li>Win/lose/draw is tracked; it re-queues automatically until you stop.</li>
          <li>Each game is an independent on-chain settlement against your bankroll.</li>
        </ol>
      </div>

      <div className="panel">
        <b style={{ color: "var(--text-strong)" }}>Run a gauntlet</b>
        <p className="muted">
          Gauntlet runs as a loop in the client. With the native client:
        </p>
        <pre>chess-client gauntlet --count 20 --stake 1000000 \
  --initial-secs 180 --increment-secs 0 --auth-token &lt;siwe-session&gt;</pre>
        <p className="muted">
          Set the clock with <code>--initial-secs</code> / <code>--increment-secs</code>
          (e.g. <code>60/0</code> for 1+0, <code>180/0</code> for 3+0). A free, no-stakes
          gauntlet (engine vs engine) also runs in your browser — start with{" "}
          <Link href="/play">Quick Play</Link>.
        </p>
        <TimeControlChips />
      </div>
    </div>
  );
}
