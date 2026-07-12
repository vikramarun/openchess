"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { SERVER_HTTP } from "@/lib/config";

type Entry = {
  rank: number;
  address: string;
  rating: number;
  games: number;
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Lobby leaderboard: top-rated bots by Elo. Renders nothing until there's at
 *  least one rated player (or if the server is unreachable), so it stays out of
 *  the way on an empty/offline lobby. */
export function Leaderboard() {
  const [rows, setRows] = useState<Entry[]>([]);

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

  if (rows.length === 0) return null;

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div style={{ fontWeight: 700, color: "var(--text-strong)", marginBottom: 10 }}>
        🏅 Top bots
      </div>
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
                  href={`/player/${e.address}`}
                  style={{ color: "var(--text)", fontWeight: 600 }}
                >
                  {short(e.address)}
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
