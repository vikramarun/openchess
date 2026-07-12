"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { GameReplay } from "@/components/GameReplay";
import { LiveSpectator } from "@/components/LiveSpectator";
import { fetchGame, isFinished, type GameDetail } from "@/lib/gameApi";

/** One URL per game. We fetch the game once to decide: a finished game is shown
 *  as a navigable replay; an in-progress one as a live spectator. */
export default function GamePage() {
  const params = useParams();
  const id = String(params.id);

  const [mode, setMode] = useState<"loading" | "live" | "replay">("loading");
  const [detail, setDetail] = useState<GameDetail | null>(null);

  useEffect(() => {
    let off = false;
    setMode("loading");
    setDetail(null);
    fetchGame(id).then((d) => {
      if (off) return;
      if (d && isFinished(d.status)) {
        setDetail(d);
        setMode("replay");
      } else {
        // In-progress, or detail unavailable (no DB / server down) — the live
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
  if (mode === "replay" && detail) return <GameReplay detail={detail} />;
  return <LiveSpectator id={id} />;
}
