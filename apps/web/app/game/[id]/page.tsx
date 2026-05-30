"use client";

import { Chess } from "chessops/chess";
import { INITIAL_FEN, makeFen } from "chessops/fen";
import { makeSanAndPlay } from "chessops/san";
import { parseUci } from "chessops/util";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Chessboard } from "@/components/Chessboard";
import { SERVER_WS } from "@/lib/config";

type Clock = { white_ms: number; black_ms: number; increment_ms: number };
type Result = { winner: "white" | "black" | null; reason: string };

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export default function GamePage() {
  const params = useParams();
  const id = String(params.id);

  const [fen, setFen] = useState(INITIAL_FEN);
  const [moves, setMoves] = useState<string[]>([]);
  const [clock, setClock] = useState<Clock | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [status, setStatus] = useState("connecting…");

  const pos = useRef(Chess.default());

  useEffect(() => {
    const ws = new WebSocket(`${SERVER_WS}/ws/game/${id}`);
    ws.onopen = () => setStatus("watching");
    ws.onclose = () => setStatus("disconnected");
    ws.onerror = () => setStatus("connection error");
    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "game_start":
          pos.current = Chess.default();
          setFen(INITIAL_FEN);
          setMoves([]);
          setResult(null);
          if (msg.clock) setClock(msg.clock);
          break;
        case "opponent_moved": {
          const move = parseUci(msg.uci);
          if (move) {
            const san = makeSanAndPlay(pos.current, move);
            setFen(makeFen(pos.current.toSetup()));
            setMoves((m) => [...m, san]);
          }
          if (msg.clock) setClock(msg.clock);
          break;
        }
        case "clock_sync":
          if (msg.clock) setClock(msg.clock);
          break;
        case "game_over":
          setResult(msg.result);
          setStatus("finished");
          break;
      }
    };
    return () => ws.close();
  }, [id]);

  const winnerText = result
    ? result.winner
      ? `${result.winner === "white" ? "White" : "Black"} wins`
      : "Draw"
    : null;

  return (
    <div className="container">
      <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
        <div>
          <Chessboard fen={fen} />
          <div className="clocks">
            <div className="clock">⚪ {clock ? fmt(clock.white_ms) : "—"}</div>
            <div className="clock">⚫ {clock ? fmt(clock.black_ms) : "—"}</div>
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 240 }}>
          <div className="panel">
            <div className="muted">Game</div>
            <code>{id}</code>
            <div style={{ marginTop: 8 }} className="muted">
              Status: {status}
            </div>
            {result && (
              <h2 style={{ color: "var(--accent)" }}>
                {winnerText} — {result.reason}
              </h2>
            )}
          </div>

          <div className="panel">
            <div className="muted" style={{ marginBottom: 8 }}>
              Moves
            </div>
            <div className="moves">
              {moves.length === 0 && <span className="muted">waiting…</span>}
              {moves.map((san, i) =>
                i % 2 === 0 ? (
                  <span key={i}>
                    {i / 2 + 1}. {san}{" "}
                  </span>
                ) : (
                  <span key={i}>{san} </span>
                )
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
