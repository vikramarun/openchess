"use client";

import { Chess } from "chessops/chess";
import { INITIAL_FEN, makeFen } from "chessops/fen";
import { makeSanAndPlay } from "chessops/san";
import { parseUci } from "chessops/util";
import { useEffect, useRef, useState } from "react";

import { Chessboard } from "@/components/Chessboard";
import { PlayerBar } from "@/components/PlayerBar";
import { ensureBookLoaded } from "@/lib/browserBot";
import { lastMoveFromUci, material, sideToMoveFromFen } from "@/lib/board";
import { SERVER_WS } from "@/lib/config";
import { BrowserEngine } from "@/lib/engine";
import { playSeat } from "@/lib/play";
import { fmtUsdc, payoutForStake } from "@/lib/escrow";
import { shortAddr, verifyResultSig, type Verification } from "@/lib/verify";

type Clock = { white_ms: number; black_ms: number };
type Result = { winner: "white" | "black" | null; reason: string };
type Opponent = { name: string; declared_engine: string | null };

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
  const [lastUci, setLastUci] = useState<string | null>(null);
  const [inCheck, setInCheck] = useState<"white" | "black" | null>(null);
  const [clock, setClock] = useState<Clock | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [opponent, setOpponent] = useState<Opponent | null>(null);
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
    let specTimer: ReturnType<typeof setTimeout> | undefined;
    let specRetry = 0;
    let finished = false;

    const onSpecMessage = (ev: MessageEvent) => {
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
            setLastUci(null);
            setInCheck(null);
            if (m.clock) setClock(m.clock);
            break;
          case "opponent_moved": {
            const mv = parseUci(m.uci);
            if (mv && pos.current.isLegal(mv)) {
              const san = makeSanAndPlay(pos.current, mv);
              setFen(makeFen(pos.current.toSetup()));
              setMoves((x) => [...x, san]);
              setLastUci(m.uci);
              setInCheck(pos.current.isCheck() ? pos.current.turn : null);
            }
            if (m.clock) setClock(m.clock);
            break;
          }
          case "clock_sync":
            if (m.clock) setClock(m.clock);
            break;
          case "game_over":
            finished = true; // stop reconnecting — the game is over
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

    // The spectator socket renders the live board. Reconnect with backoff so a
    // dropped connection mid-wager shows "reconnecting…" and recovers, rather
    // than silently freezing the board while money is on the line.
    const connectSpectator = () => {
      if (cancelled || finished) return;
      spectator = new WebSocket(`${SERVER_WS}/ws/game/${gameId}`);
      spectator.onopen = () => {
        specRetry = 0;
        if (!finished) setStatus("playing");
      };
      spectator.onmessage = onSpecMessage;
      spectator.onclose = () => {
        if (cancelled || finished) return;
        setStatus("reconnecting…");
        specRetry = Math.min(specRetry + 1, 6);
        specTimer = setTimeout(connectSpectator, 500 * 2 ** (specRetry - 1)); // backoff to ~16s
      };
    };

    const run = async () => {
      engine = new BrowserEngine();
      await engine.whenReady();
      if (cancelled) return;
      // Warm the uploaded book so it's ready before the first move.
      await ensureBookLoaded();

      connectSpectator();

      // Drive only our seat; the fixed movetime is a fallback — playSeat uses
      // the authoritative clock from your_turn when present.
      seat = playSeat(
        gameId,
        token,
        engine,
        400,
        {
          onEvent: (m) => {
            if (m?.type === "game_start" && m.opponent) setOpponent(m.opponent);
          },
        },
        cancelledFn,
      );
    };

    run().catch(() => {
      if (!cancelled) setStatus("failed to start");
    });

    return () => {
      cancelled = true;
      if (specTimer) clearTimeout(specTimer);
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

  const oppColor = color === "white" ? "black" : "white";
  const live = !result && status === "playing";
  const turn = sideToMoveFromFen(fen);
  const mat = material(fen);
  const myClock = clock ? (color === "white" ? clock.white_ms : clock.black_ms) : null;
  const oppClock = clock ? (color === "white" ? clock.black_ms : clock.white_ms) : null;
  const myCaptured = color === "white" ? mat.whiteCaptured : mat.blackCaptured;
  const oppCaptured = color === "white" ? mat.blackCaptured : mat.whiteCaptured;
  const myEdge = color === "white" ? mat.advantage : -mat.advantage;

  return (
    <div className="game-wrap">
      <div className="board-col">
        <PlayerBar
          color={oppColor}
          name={opponent?.name ?? "Opponent"}
          engine={opponent?.declared_engine}
          clockMs={oppClock}
          active={live && turn === oppColor}
          captured={oppCaptured}
          edge={-myEdge}
        />
        <Chessboard fen={fen} orientation={color} lastMove={lastMoveFromUci(lastUci)} check={inCheck} />
        <PlayerBar
          color={color}
          name="You"
          clockMs={myClock}
          active={live && turn === color}
          captured={myCaptured}
          edge={myEdge}
        />
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
            <div className="stake-callout" style={{ marginTop: 10 }}>
              <div>
                Stake <b>{fmtUsdc(stake)} USDC</b> · win nets{" "}
                <b>{fmtUsdc(payoutForStake(stake))} USDC</b>
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
                Winner takes both stakes minus a 1% fee; a draw returns your stake. Non-custodial —
                settled on-chain.
              </div>
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
