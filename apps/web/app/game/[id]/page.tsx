"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { GameReplay } from "@/components/GameReplay";
import { LiveSpectator } from "@/components/LiveSpectator";
import { isFinished, lookupGame, type GameDetail } from "@/lib/gameApi";

/** One URL per game. We fetch the game once to decide: a finished game is shown
 *  as a navigable replay; an in-progress one as a live spectator. */
export default function GamePage() {
  const params = useParams();
  const id = String(params.id);

  const [mode, setMode] = useState<"loading" | "live" | "replay" | "missing">("loading");
  const [detail, setDetail] = useState<GameDetail | null>(null);

  useEffect(() => {
    let off = false;
    setMode("loading");
    setDetail(null);
    lookupGame(id).then((g) => {
      if (off) return;
      if (g.detail && isFinished(g.detail.status)) {
        setDetail(g.detail);
        setMode("replay");
      } else if (g.missing) {
        // A definitive 404: a mistyped share link, or a game that was never
        // recorded. Without this state the page fell through to the live
        // spectator, which shows a blank board "reconnecting…" for a minute
        // before giving up — on an id that never existed.
        setMode("missing");
      } else {
        // In-progress, or detail unavailable (server unreachable) — the live
        // spectator's own WS status will surface any connection problem.
        setMode("live");
      }
    });
    return () => {
      off = true;
    };
  }, [id]);

  if (mode === "loading") {
    return (
      <div className="container">
        <div className="muted">Loading game…</div>
      </div>
    );
  }
  if (mode === "missing") {
    return (
      <div className="container">
        <div className="panel" style={{ marginTop: 16 }}>
          <b style={{ color: "var(--text-strong)" }}>Game not found</b>
          <div className="muted" style={{ marginTop: 8 }}>
            There’s no game with this id. The link may be mistyped, or the game was never
            recorded.
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
            <Link href="/" className="ghost">
              Back to lobby
            </Link>
            {/* Escape hatch for the rare live room whose row never landed. */}
            <button className="ghost" onClick={() => setMode("live")}>
              Try watching live anyway
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (mode === "replay" && detail) return <GameReplay detail={detail} />;
  return <LiveSpectator id={id} />;
}
