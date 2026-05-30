"use client";

import { Chess } from "chessops/chess";
import { INITIAL_FEN, makeFen } from "chessops/fen";
import { makeSanAndPlay } from "chessops/san";
import { parseUci } from "chessops/util";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Chessboard } from "@/components/Chessboard";
import { SERVER_WS } from "@/lib/config";
import { shortAddr, verifyResultSig, type Verification } from "@/lib/verify";

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
  const [verified, setVerified] = useState<Verification | null>(null);
  const [status, setStatus] = useState("connecting…");

  const pos = useRef(Chess.default());

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const handle = (ev: MessageEvent) => {
      let msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      try {
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
            // Only apply a move that is legal in the current position — a stale
            // or malformed server message can't corrupt the board or throw.
            if (move && pos.current.isLegal(move)) {
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
            verifyResultSig(msg.result_hash, msg.server_sig).then(setVerified);
            break;
        }
      } catch {
        // never let one bad message kill the stream
      }
    };

    const connect = () => {
      if (cancelled) return;
      ws = new WebSocket(`${SERVER_WS}/ws/game/${id}`);
      ws.onopen = () => {
        retry = 0;
        setStatus("watching");
      };
      ws.onmessage = handle;
      ws.onerror = () => setStatus("connection error");
      ws.onclose = () => {
        if (cancelled) return;
        setStatus("reconnecting…");
        retry = Math.min(retry + 1, 6);
        timer = setTimeout(connect, 500 * 2 ** (retry - 1)); // backoff to ~16s
      };
    };
    connect();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [id]);

  const winnerText = result
    ? result.winner
      ? `${result.winner === "white" ? "White" : "Black"} wins`
      : "Draw"
    : null;

  return (
    <div className="container">
      <div className="game-wrap">
        <div>
          <Chessboard fen={fen} />
          <div className="clocks" style={{ display: "flex", gap: 12, marginTop: 12 }}>
            <div className="clock">⚪ {clock ? fmt(clock.white_ms) : "—"}</div>
            <div className="clock">⚫ {clock ? fmt(clock.black_ms) : "—"}</div>
          </div>
        </div>

        <div className="sidebar">
          <div className="panel">
            <div className="muted" style={{ fontSize: 13 }}>
              Spectating
            </div>
            <code>{id}</code>
            <div style={{ marginTop: 8 }} className="muted">
              Status: {status}
            </div>
          </div>

          {result && (
            <div className="result-banner">
              {winnerText} · {result.reason}
              {verified?.signed && (
                <div className="verified">
                  ✓ Verified — signed by oracle {shortAddr(verified.oracle)}
                </div>
              )}
            </div>
          )}

          <div className="panel">
            <div className="muted" style={{ marginBottom: 8 }}>
              Moves
            </div>
            <div className="moves">
              {moves.length === 0 && <span className="muted">waiting…</span>}
              {moves.map((san, i) =>
                i % 2 === 0 ? (
                  <span key={i}>
                    <span className="num">{i / 2 + 1}.</span>
                    {san}{" "}
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
