"use client";

import { Chess } from "chessops/chess";
import { INITIAL_FEN, makeFen } from "chessops/fen";
import { makeSanAndPlay } from "chessops/san";
import { parseUci } from "chessops/util";
import { useEffect, useRef, useState } from "react";

import { Chessboard } from "@/components/Chessboard";
import { SERVER_WS } from "@/lib/config";
import { BrowserEngine } from "@/lib/engine";
import { playSeat } from "@/lib/play";
import { fmtUsdc } from "@/lib/escrow";
import { shortAddr, verifyResultSig, type Verification } from "@/lib/verify";

type Clock = { white_ms: number; black_ms: number };
type Result = { winner: "white" | "black" | null; reason: string };

function fmt(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Play ONE seat of a server game in the browser (the opponent runs theirs).
 *  Renders the live board from a spectator socket; drives the user's seat with
 *  an in-browser Stockfish. Used by the wager modes. */
export function SeatGame({
  gameId,
  token,
  color,
  stake,
  onDone,
  onResult,
  subtitle,
}: {
  gameId: string;
  token: string;
  color: "white" | "black";
  stake?: string | null;
  onDone?: () => void;
  /** Fires once when the game ends — used by gauntlet/tournament to advance. */
  onResult?: (winner: "white" | "black" | null) => void;
  subtitle?: string;
}) {
  const [fen, setFen] = useState(INITIAL_FEN);
  const [moves, setMoves] = useState<string[]>([]);
  const [clock, setClock] = useState<Clock | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [verified, setVerified] = useState<Verification | null>(null);
  const [status, setStatus] = useState("loading engine…");
  const pos = useRef(Chess.default());
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  useEffect(() => {
    let cancelled = false;
    const cancelledFn = () => cancelled;
    let engine: BrowserEngine | null = null;
    let spectator: WebSocket | null = null;
    let seat: { close: () => void } | null = null;

    const run = async () => {
      engine = new BrowserEngine();
      await engine.whenReady();
      if (cancelled) return;

      spectator = new WebSocket(`${SERVER_WS}/ws/game/${gameId}`);
      spectator.onopen = () => setStatus("playing");
      spectator.onmessage = (ev) => {
        let m: any;
        try {
          m = JSON.parse(ev.data);
        } catch {
          return;
        }
        try {
          switch (m.type) {
            case "game_start":
              pos.current = Chess.default();
              setFen(INITIAL_FEN);
              setMoves([]);
              if (m.clock) setClock(m.clock);
              break;
            case "opponent_moved": {
              const mv = parseUci(m.uci);
              if (mv && pos.current.isLegal(mv)) {
                const san = makeSanAndPlay(pos.current, mv);
                setFen(makeFen(pos.current.toSetup()));
                setMoves((x) => [...x, san]);
              }
              if (m.clock) setClock(m.clock);
              break;
            }
            case "clock_sync":
              if (m.clock) setClock(m.clock);
              break;
            case "game_over":
              setResult(m.result);
              setStatus("finished");
              verifyResultSig(m.result_hash, m.server_sig).then(setVerified);
              onResultRef.current?.(m.result?.winner ?? null);
              break;
          }
        } catch {
          /* ignore one bad frame */
        }
      };

      // Drive only our seat; the fixed movetime is a fallback — playSeat uses
      // the authoritative clock from your_turn when present.
      seat = playSeat(gameId, token, engine, 400, {}, cancelledFn);
    };

    run().catch(() => {
      if (!cancelled) setStatus("failed to start");
    });

    return () => {
      cancelled = true;
      spectator?.close();
      seat?.close();
      engine?.dispose();
    };
  }, [gameId, token]);

  const winnerText = result
    ? result.winner
      ? `${result.winner === "white" ? "White" : "Black"} wins`
      : "Draw"
    : null;
  const youWon = result && result.winner === color;
  const youLost = result && result.winner && result.winner !== color;

  return (
    <div className="game-wrap">
      <div>
        <Chessboard fen={fen} orientation={color} />
        <div className="clocks" style={{ display: "flex", gap: 12, marginTop: 12 }}>
          <div className="clock">⚪ {clock ? fmt(clock.white_ms) : "—"}</div>
          <div className="clock">⚫ {clock ? fmt(clock.black_ms) : "—"}</div>
        </div>
      </div>

      <div className="sidebar">
        <div className="panel">
          <div style={{ fontWeight: 700, color: "var(--text-strong)", marginBottom: 4 }}>
            {subtitle ?? `Your game · ${color === "white" ? "White" : "Black"}`}
          </div>
          <div className="muted" style={{ fontSize: 14 }}>
            Your engine plays your seat in your browser; your opponent runs theirs.
          </div>
          {stake && (
            <div className="muted" style={{ marginTop: 6 }}>
              Stake: <b style={{ color: "var(--text-strong)" }}>{fmtUsdc(stake)} USDC</b>
            </div>
          )}
          <div className="muted" style={{ marginTop: 8 }}>
            Status: {status}
          </div>
        </div>

        {result && (
          <div className={`result-banner ${youWon ? "won" : youLost ? "lost" : ""}`}>
            {youWon ? "You win" : youLost ? "You lose" : winnerText} · {result.reason}
            {stake && (
              <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                Settling on-chain — your bankroll updates once the oracle posts the result.
              </div>
            )}
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
            {moves.length === 0 && <span className="muted">…</span>}
            {moves.map((san, i) =>
              i % 2 === 0 ? (
                <span key={i}>
                  <span className="num">{i / 2 + 1}.</span>
                  {san}{" "}
                </span>
              ) : (
                <span key={i}>{san} </span>
              ),
            )}
          </div>
        </div>

        {result && onDone && (
          <button className="primary" onClick={onDone}>
            Back to lobby
          </button>
        )}
      </div>
    </div>
  );
}
