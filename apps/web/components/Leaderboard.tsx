"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { PlayerSearch } from "@/components/PlayerSearch";
import { playerLabel } from "@/lib/playerLabel";
import { SERVER_HTTP } from "@/lib/config";

type Entry = {
  rank: number;
  address: string;
  rating: number;
  games: number;
  /** Absent from a server that predates usernames, and for a wallet that has
   *  never claimed one — hence the address fallback everywhere below. */
  username?: string | null;
};

/** The lookup box, mounted with the board rather than only on /profile.
 *
 *  This is the real "look people up" surface: it's on the homepage, it's
 *  indexable, and it sits beside the list of people you'd want to look up —
 *  whereas /profile is `disallow`ed in robots.txt and invisible to anyone not
 *  already signed in and poking at settings. Deliberately NOT in the header:
 *  that row already carries brand, five links and two pills, and it is the one
 *  component with hard CSS constraints (`pnpm test:layout`). */
function FindPlayer() {
  return (
    <div style={{ marginBottom: 12 }}>
      <PlayerSearch placeholder="Find a player…" />
    </div>
  );
}

/** Lobby leaderboard: the ranked ladder, best Elo first.
 *
 *  Ranked only — a wallet needs at least one finished RANKED game (staked, or a
 *  buy-in tournament) to appear, and the games count beside a rating counts the
 *  same set. Casual Elo is deliberately absent: free games are free to farm, and
 *  this board is what people read before staking money. Renders nothing until
 *  the server answers (out of the way on an offline lobby); an answered-but-
 *  empty ladder shows an invite instead of vanishing, because ranked starts
 *  empty by design. */
export function Leaderboard() {
  const [rows, setRows] = useState<Entry[] | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`${SERVER_HTTP}/leaderboard`)
      .then((r) => r.json())
      .then((d) => {
        if (live && Array.isArray(d)) setRows(d);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (rows === null) return null;

  if (rows.length === 0) {
    return (
      <div className="panel" style={{ marginTop: 16 }}>
        <div style={{ fontWeight: 700, color: "var(--text-strong)", marginBottom: 10 }}>
          🏅 Top bots
        </div>
        <FindPlayer />
        <div className="muted">
          No ranked players yet — play for a USDC stake or enter a buy-in tournament to
          put your bot on the ladder.
        </div>
      </div>
    );
  }

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div style={{ fontWeight: 700, color: "var(--text-strong)", marginBottom: 10 }}>
        🏅 Top bots
      </div>
      <FindPlayer />
      <table className="history-table">
        <thead>
          <tr>
            <th style={{ width: 40 }}>#</th>
            <th>Player</th>
            <th style={{ textAlign: "right" }}>Rating</th>
            <th style={{ textAlign: "right" }}>Games</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.address}>
              <td className="muted">{e.rank}</td>
              <td>
                <Link
                  href={`/player/${e.username || e.address}`}
                  style={{ color: "var(--text)", fontWeight: 600 }}
                >
                  {playerLabel({ username: e.username, address: e.address })}
                </Link>
              </td>
              <td style={{ textAlign: "right", fontWeight: 700 }}>{e.rating}</td>
              <td className="muted" style={{ textAlign: "right" }}>
                {e.games}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
