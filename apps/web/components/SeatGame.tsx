"use client";

import { useEffect, useRef, useState } from "react";

import { Chessboard } from "@/components/Chessboard";
import { PlayerBar } from "@/components/PlayerBar";
import { ensureBookLoaded } from "@/lib/browserBot";
import { lastMoveFromUci, material, sideToMoveFromFen } from "@/lib/board";
import { SERVER_WS } from "@/lib/config";
import { BrowserEngine } from "@/lib/engine";
import { playSeat } from "@/lib/play";
import { connectSpectator } from "@/lib/spectatorSocket";
import { contractUrl, fmtUsdc, profitForStake } from "@/lib/escrow";
import { fetchGame } from "@/lib/gameApi";
import { useOnchainConfig } from "@/lib/useOnchainConfig";
import { useSpectatorBoard } from "@/lib/useSpectatorBoard";
import { shortAddr } from "@/lib/verify";

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
  const { fen, moves, lastUci, inCheck, clock, result, verified, applyFrame } = useSpectatorBoard();
  const [opponent, setOpponent] = useState<Opponent | null>(null);
  const [status, setStatus] = useState("loading engine…");
  const [settleStatus, setSettleStatus] = useState<string | null>(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  useEffect(() => {
    let cancelled = false;
    const cancelledFn = () => cancelled;
    let engine: BrowserEngine | null = null;
    let spectator: { close: () => void } | null = null;
    let seat: { close: () => void } | null = null;
    let finished = false;

    const run = async () => {
      engine = new BrowserEngine();
      await engine.whenReady();
      if (cancelled) return;
      // Warm the uploaded book so it's ready before the first move.
      await ensureBookLoaded();

      // The spectator socket renders the live board (shared reducer); it
      // reconnects with backoff so a dropped connection mid-wager shows
      // "reconnecting…" and recovers rather than freezing the board while money
      // is on the line.
      spectator = connectSpectator({
        url: `${SERVER_WS}/ws/game/${gameId}`,
        onFrame: (data) =>
          applyFrame(data, (winner) => {
            finished = true; // stop reconnecting — the game is over
            setStatus("finished");
            onResultRef.current?.(winner);
          }),
        onStatus: setStatus,
        liveStatus: "playing",
        isFinished: () => finished,
        isCancelled: () => cancelled,
      });

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
      spectator?.close();
      seat?.close();
      engine?.dispose();
    };
  }, [gameId, token, applyFrame]);

  // Once a wagered game ends, poll the game's settlement status so the banner can
  // confirm "Settled ✓" (or surface a failure) instead of leaving the user
  // staring at "settling…". Bounded; the durable outbox usually settles within a
  // few seconds.
  useEffect(() => {
    if (!result || !stake) return;
    let off = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      fetchGame(gameId).then((d) => {
        if (off) return;
        const s = d?.settlement_status ?? null;
        if (s) setSettleStatus(s);
        if (s === "settled" || s === "failed") return; // terminal
        if (++tries < 20) timer = setTimeout(poll, 3000); // ~60s
      });
    };
    poll();
    return () => {
      off = true;
      if (timer) clearTimeout(timer);
    };
  }, [result, stake, gameId]);

  const winnerText = result
    ? result.winner
      ? `${result.winner === "white" ? "White" : "Black"} wins`
      : "Draw"
    : null;
  const youWon = result && result.winner === color;
  const youLost = result && result.winner && result.winner !== color;

  const { config } = useOnchainConfig();
  const escrowUrl = config?.escrow ? contractUrl(config.chainId, config.escrow) : null;
  const settledText = youWon
    ? `you won +${fmtUsdc(profitForStake(stake ?? 0))} USDC`
    : youLost
      ? `you lost ${fmtUsdc(stake)} USDC`
      : "draw — your stake was returned";

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
                Stake <b>{fmtUsdc(stake)} USDC</b> · win{" "}
                <b>+{fmtUsdc(profitForStake(stake))} USDC</b>
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
                Win to take your opponent’s stake, less a 1% fee; a draw or no-show returns your
                stake. Non-custodial — settled on-chain.
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
              <div style={{ fontSize: 13, marginTop: 6 }}>
                {settleStatus === "settled" ? (
                  <span style={{ color: youWon ? "var(--accent)" : "var(--text)" }}>
                    Settled on-chain ✓ — {settledText}
                  </span>
                ) : settleStatus === "failed" ? (
                  <span className="muted">
                    Settlement delayed — your funds are safe and recoverable on-chain after the
                    settle window.{" "}
                    {escrowUrl && (
                      <a href={escrowUrl} target="_blank" rel="noopener noreferrer">
                        View escrow ↗
                      </a>
                    )}
                  </span>
                ) : (
                  <span className="muted">
                    Settling on-chain — your bankroll updates once the oracle posts the result.
                  </span>
                )}
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
