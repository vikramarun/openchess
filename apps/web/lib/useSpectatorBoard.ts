"use client";

import { Chess } from "chessops/chess";
import { INITIAL_FEN, makeFen } from "chessops/fen";
import { makeSanAndPlay } from "chessops/san";
import { parseUci } from "chessops/util";
import { useCallback, useMemo, useRef, useState } from "react";

import { verifyResultSig, type Verification } from "@/lib/verify";

export type SpectatorClock = { white_ms: number; black_ms: number; increment_ms?: number };
export type SpectatorResult = { winner: "white" | "black" | null; reason: string };

/** One position in the game so far. Index = ply (0 is the starting position),
 *  which is what lets a spectator step back and forth through a game that is
 *  still being played.
 *
 *  Deliberately no per-ply clock: a spectator who joins mid-game is replayed the
 *  history with the CURRENT clock stamped on every historical move
 *  (`handle_spectator` in the server's ws.rs), so a "clock at ply N" read off
 *  these frames would be fiction. The live view therefore shows the live clock
 *  regardless of the ply you're viewing; the finished-game replay gets real
 *  per-move clocks from the database. */
export type BoardFrame = {
  fen: string;
  /** UCI of the move that produced this position (null at ply 0). */
  lastUci: string | null;
  /** SAN of that same move (null at ply 0). */
  san: string | null;
  check: "white" | "black" | null;
};

const START: BoardFrame = { fen: INITIAL_FEN, lastUci: null, san: null, check: null };

/** Board state + the WS-frame reducer shared by the wager view (SeatGame) and
 *  the spectator page (LiveSpectator). This owns the move-application logic (the
 *  legality-guarded game_start/opponent_moved/clock_sync/game_over switch) so it
 *  lives in ONE place — a divergence there is a real board-corruption risk. Each
 *  caller keeps its own socket, status, and terminal `finished` flag (their
 *  lifecycles genuinely differ: SeatGame also drives an engine seat), and feeds
 *  frames in via `applyFrame`. game_over is signalled back through `onGameOver`
 *  so the caller can stop reconnecting / advance its mode.
 *
 *  Every position is retained (`frames`), not just the newest one, so a viewer
 *  can navigate the game while it is still running (see lib/usePlyNav.ts). The
 *  top-level `fen`/`lastUci`/`inCheck` always describe the live tip. */
export function useSpectatorBoard() {
  const [frames, setFrames] = useState<BoardFrame[]>([START]);
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
            setFrames([START]);
            setResult(null);
            if (m.clock) setClock(m.clock);
            break;
          case "opponent_moved": {
            const mv = parseUci(m.uci);
            // Only apply a move legal in the current position — a stale or
            // malformed frame can't corrupt the board or throw.
            if (mv && pos.current.isLegal(mv)) {
              const san = makeSanAndPlay(pos.current, mv);
              const next: BoardFrame = {
                fen: makeFen(pos.current.toSetup()),
                lastUci: m.uci,
                san,
                check: pos.current.isCheck() ? pos.current.turn : null,
              };
              setFrames((f) => [...f, next]);
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

  /** Clear the board back to the pre-game state. For a caller that starts a NEW
   *  game on the same mounted view (`/play`): `game_start` resets us anyway, but
   *  it only arrives once both seats are ready, and until then the finished
   *  game's final position and result banner would sit there under "creating
   *  game…". The clock goes too — the previous game's last clock is usually
   *  `0:00` for whoever flagged, and showing that over a game about to start
   *  reads as a player already out of time. */
  const reset = useCallback(() => {
    pos.current = Chess.default();
    setFrames([START]);
    setClock(null);
    setResult(null);
    setVerified(null);
  }, []);

  const tip = frames[frames.length - 1];
  const moves = useMemo(() => frames.slice(1).map((f) => f.san ?? ""), [frames]);

  return {
    /** Live position (the newest frame). */
    fen: tip.fen,
    lastUci: tip.lastUci,
    inCheck: tip.check,
    /** SAN move list. */
    moves,
    /** Every position so far; index = ply. */
    frames,
    clock,
    result,
    verified,
    applyFrame,
    reset,
  };
}
