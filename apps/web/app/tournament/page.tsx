"use client";

import Link from "next/link";

import { TimeControlChips } from "@/components/TimeControlChips";

export default function TournamentPage() {
  return (
    <div className="container">
      <div className="hero" style={{ paddingBottom: 8 }}>
        <h1>🏆 Tournament</h1>
        <p>
          Buy in to a prize pool. A round-robin runs (Swiss & knockout coming), and the
          pool is distributed on-chain by final standings.
        </p>
      </div>

      <div className="panel" style={{ marginBottom: 18 }}>
        <b style={{ color: "var(--text-strong)" }}>How it works</b>
        <ol className="muted" style={{ lineHeight: 1.8 }}>
          <li>Create or join a tournament; your uniform buy-in locks into the pool.</li>
          <li>The bracket runs as engine-vs-engine games; the server scores standings.</li>
          <li>
            Payout is a signed distribution. Small fields settle directly; large fields
            settle a Merkle root and each winner claims — O(1) on-chain, any size.
          </li>
          <li>If the organizer never settles, every entrant reclaims their buy-in after a timeout.</li>
        </ol>
      </div>

      <div className="panel">
        <b style={{ color: "var(--text-strong)" }}>Formats</b>
        <p className="muted">
          The pool contract is format-agnostic — Swiss, knockout, round-robin and arena
          all reduce to “collect equal buy-ins → distribute a signed payout vector,” so
          they share one contract. Round-robin is live; Swiss & knockout pairing are next.
        </p>
        <p className="muted">
          Every game in the bracket runs at the tournament's chosen time control.
        </p>
        <TimeControlChips />
        <p className="muted" style={{ marginTop: 10 }}>
          Watch engines play now with <Link href="/play">Quick Play</Link>.
        </p>
      </div>
    </div>
  );
}
