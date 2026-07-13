"use client";

import { Chess } from "chessops/chess";
import { INITIAL_FEN, makeFen } from "chessops/fen";
import { makeSanAndPlay } from "chessops/san";
import { parseUci } from "chessops/util";
import { useCallback, useRef, useState } from "react";

import { verifyResultSig, type Verification } from "@/lib/verify";

export type SpectatorClock = { white_ms: number; black_ms: number; increment_ms?: number };
export type SpectatorResult = { winner: "white" | "black" | null; reason: string };

/** Board state + the WS-frame reducer shared by the wager view (SeatGame) and
 *  the spectator page (LiveSpectator). This owns the move-application logic (the
 *  legality-guarded game_start/opponent_moved/clock_sync/game_over switch) so it
 *  lives in ONE place — a divergence there is a real board-corruption risk. Each
 *  caller keeps its own socket, status, and terminal `finished` flag (their
 *  lifecycles genuinely differ: SeatGame also drives an engine seat), and feeds
 *  frames in via `applyFrame`. game_over is signalled back through `onGameOver`
 *  so the caller can stop reconnecting / advance its mode. */
export function useSpectatorBoard() {
  const [fen, setFen] = useState(INITIAL_FEN);
  const [moves, setMoves] = useState<string[]>([]);
  const [lastUci, setLastUci] = useState<string | null>(null);
  const [inCheck, setInCheck] = useState<"white" | "black" | null>(null);
  const [clock, setClock] = useState<SpectatorClock | null>(null);
  const [result, setResult] = useState<SpectatorResult | null>(null);
  const [verified, setVerified] = useState<Verification | null>(null);
  const pos = useRef(Chess.default());

  // Stable identity (only stable setters + the pos ref are captured), so a caller
  // can pass it straight to connectSpectator without churning its effect.
  const applyFrame = useCallback(
    (data: string, onGameOver?: (winner: "white" | "black" | null) => void) => {
      let m: any;
      try {
        m = JSON.parse(data);
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
            setResult(null);
            if (m.clock) setClock(m.clock);
            break;
          case "opponent_moved": {
            const mv = parseUci(m.uci);
            // Only apply a move legal in the current position — a stale or
            // malformed frame can't corrupt the board or throw.
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
            setResult(m.result);
            verifyResultSig(m.result_hash, m.server_sig).then(setVerified);
            onGameOver?.(m.result?.winner ?? null);
            break;
        }
      } catch {
        /* never let one bad frame kill the stream */
      }
    },
    [],
  );

  return { fen, moves, lastUci, inCheck, clock, result, verified, applyFrame };
}
