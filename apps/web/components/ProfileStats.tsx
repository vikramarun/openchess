"use client";

import { useEffect, useState } from "react";

import { shortAddress } from "@/lib/address";
import { SERVER_HTTP } from "@/lib/config";
import { fmtUsdc, fmtUsdcSigned } from "@/lib/escrow";

type Profile = {
  address: string;
  rating: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  net: string;
};
type GameItem = {
  game_id: string;
  mode: string;
  white: string | null;
  black: string | null;
  result: string | null;
  reason: string | null;
  stake: string | null;
  moves: number;
  finished_at: string | null;
};

function outcome(g: GameItem, me: string): "win" | "loss" | "draw" | "-" {
  if (g.result === "draw") return "draw";
  const iWhite = g.white?.toLowerCase() === me;
  const iBlack = g.black?.toLowerCase() === me;
  if ((iWhite && g.result === "white") || (iBlack && g.result === "black")) return "win";
  if (iWhite || iBlack) return "loss";
  return "-";
}

/** Public rating + record + game history for a wallet. Rendered by the public
 *  /player/[address] page and by the signed-in /profile hub. */
export function ProfileStats({ address }: { address: string }) {
  const me = address.toLowerCase();
  const [p, setP] = useState<Profile | null>(null);
  const [games, setGames] = useState<GameItem[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [pr, gr] = await Promise.all([
          fetch(`${SERVER_HTTP}/players/${me}`).then((r) => r.json()),
          fetch(`${SERVER_HTTP}/players/${me}/games`).then((r) => r.json()),
        ]);
        if (live) {
          setP(pr);
          setGames(Array.isArray(gr) ? gr : []);
        }
      } catch {
        if (live) setErr("could not load profile — is the server running?");
      }
    })();
    return () => {
      live = false;
    };
  }, [me]);

  const winRate = p && p.games > 0 ? Math.round((p.wins / p.games) * 100) : 0;
  const netClass = p && Number(p.net) > 0 ? "pos" : p && Number(p.net) < 0 ? "neg" : "";

  return (
    <>
      <div className="profile-head">
        <div className="avatar">♟</div>
        <div>
          <div className="who">{shortAddress(me)}</div>
          <div className="muted" style={{ fontSize: 13, wordBreak: "break-all" }}>
            {me}
          </div>
        </div>
        <div style={{ marginLeft: "auto", textAlign: "right" }}>
          <div className="stat" style={{ minWidth: 120 }}>
            <div className="v">{p ? p.rating : "…"}</div>
            <div className="l">Rating (Elo)</div>
          </div>
        </div>
      </div>

      {err && <div className="panel" style={{ color: "var(--danger)" }}>{err}</div>}

      <div className="stat-grid">
        <div className="stat">
          <div className="v">{p ? p.games : "…"}</div>
          <div className="l">Games</div>
        </div>
        <div className="stat">
          <div className="v">{p ? `${winRate}%` : "…"}</div>
          <div className="l">Win rate</div>
        </div>
        <div className="stat">
          <div className="v">
            {p ? (
              <span>
                <span style={{ color: "var(--accent)" }}>{p.wins}</span> /{" "}
                <span style={{ color: "var(--danger)" }}>{p.losses}</span> / {p.draws}
              </span>
            ) : (
              "…"
            )}
          </div>
          <div className="l">W / L / D</div>
        </div>
        <div className="stat">
          <div className={`v ${netClass}`}>{p ? fmtUsdcSigned(p.net) : "…"}</div>
          <div className="l">Net winnings (USDC)</div>
        </div>
      </div>

      <div className="panel">
        <div style={{ fontWeight: 700, color: "var(--text-strong)", marginBottom: 10 }}>
          Game History
        </div>
        {games.length === 0 ? (
          <div className="muted">No finished games yet.</div>
        ) : (
          <table className="history-table">
            <thead>
              <tr>
                <th>Mode</th>
                <th>Opponent</th>
                <th>Result</th>
                <th>Stake</th>
                <th>Moves</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {games.map((g) => {
                const oc = outcome(g, me);
                const opp = g.white?.toLowerCase() === me ? g.black : g.white;
                return (
                  <tr key={g.game_id}>
                    <td>{g.mode}</td>
                    <td>{shortAddress(opp, "—")}</td>
                    <td>
                      <span className={`pill ${oc}`}>
                        {oc === "win" ? "W" : oc === "loss" ? "L" : oc === "draw" ? "½" : "-"}
                      </span>{" "}
                      <span className="muted">{g.reason}</span>
                    </td>
                    <td>{g.stake ? fmtUsdc(g.stake) : "—"}</td>
                    <td>{g.moves}</td>
                    <td className="muted">
                      {g.finished_at ? new Date(g.finished_at).toLocaleDateString() : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
