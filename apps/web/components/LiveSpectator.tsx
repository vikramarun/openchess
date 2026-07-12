"use client";

import { Chess } from "chessops/chess";
import { INITIAL_FEN, makeFen } from "chessops/fen";
import { makeSanAndPlay } from "chessops/san";
import { parseUci } from "chessops/util";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Chessboard } from "@/components/Chessboard";
import { PlayerBar } from "@/components/PlayerBar";
import { lastMoveFromUci, material, sideToMoveFromFen } from "@/lib/board";
import { shortAddress } from "@/lib/address";
import { SERVER_HTTP, SERVER_WS } from "@/lib/config";
import { connectSpectator } from "@/lib/spectatorSocket";
import { fmtUsdc } from "@/lib/escrow";
import { TC_NAME, tcLabel } from "@/lib/timeControls";
import { shortAddr, verifyResultSig, type Verification } from "@/lib/verify";

type Clock = { white_ms: number; black_ms: number; increment_ms: number };
type Result = { winner: "white" | "black" | null; reason: string };
type Meta = {
  white: string | null;
  black: string | null;
  white_name: string | null;
  black_name: string | null;
  white_engine: string | null;
  black_engine: string | null;
  stake: string | null;
  initial_secs: number;
  increment_secs: number;
};

/** Best display name for a seat: declared name, else short wallet, else engine. */
function seatName(name: string | null, addr: string | null): string {
  if (name) return name;
  if (addr) return shortAddress(addr);
  return "Engine";
}

/** Watch an in-progress game over a read-only spectator socket. When it ends the
 *  banner offers a move-by-move Review (a reload re-enters `/game/[id]` in replay
 *  mode, now that the game is finished). */
export function LiveSpectator({ id }: { id: string }) {
  const [fen, setFen] = useState(INITIAL_FEN);
  const [moves, setMoves] = useState<string[]>([]);
  const [lastUci, setLastUci] = useState<string | null>(null);
  const [inCheck, setInCheck] = useState<"white" | "black" | null>(null);
  const [clock, setClock] = useState<Clock | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [verified, setVerified] = useState<Verification | null>(null);
  const [status, setStatus] = useState("connecting…");
  const [meta, setMeta] = useState<Meta | null>(null);

  const pos = useRef(Chess.default());

  // Fetch the live-game metadata so the spectator sees who's playing, the stake,
  // and the time control — not just a bare game id. A game only appears in
  // /games/live once both engines are ready, so poll until it's found (a game
  // opened just before we mounted appears once it starts). The bound covers the
  // 60s never-started reap; whether it's found or not, the sidebar message is
  // derived from the live WS status below, so a late-starting game never latches
  // a stale "not live" note.
  useEffect(() => {
    let off = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const again = () => {
      if (!off && ++tries < 24) timer = setTimeout(poll, 2500); // ~60s
    };
    const poll = () => {
      fetch(`${SERVER_HTTP}/games/live`)
        .then((r) => (r.ok ? r.json() : []))
        .then((games: (Meta & { game_id: string })[]) => {
          if (off) return;
          const g = Array.isArray(games) ? games.find((x) => x.game_id === id) : undefined;
          if (g) setMeta(g);
          else again();
        })
        .catch(again);
    };
    poll();
    return () => {
      off = true;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    let spectator: { close: () => void } | null = null;
    let finished = false;

    const handle = (data: string) => {
      let msg: any;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      try {
        switch (msg.type) {
          case "game_start":
            pos.current = Chess.default();
            setFen(INITIAL_FEN);
            setMoves([]);
            setLastUci(null);
            setInCheck(null);
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
              setLastUci(msg.uci);
              setInCheck(pos.current.isCheck() ? pos.current.turn : null);
            }
            if (msg.clock) setClock(msg.clock);
            break;
          }
          case "clock_sync":
            if (msg.clock) setClock(msg.clock);
            break;
          case "game_over":
            finished = true; // game ended — stop reconnecting to a soon-reaped room
            setResult(msg.result);
            setStatus("finished");
            verifyResultSig(msg.result_hash, msg.server_sig).then(setVerified);
            break;
        }
      } catch {
        // never let one bad message kill the stream
      }
    };

    spectator = connectSpectator({
      url: `${SERVER_WS}/ws/game/${id}`,
      onFrame: handle,
      onStatus: setStatus,
      liveStatus: "watching",
      isFinished: () => finished,
      isCancelled: () => cancelled,
    });

    return () => {
      cancelled = true;
      spectator?.close();
    };
  }, [id]);

  const winnerText = result
    ? result.winner
      ? `${result.winner === "white" ? "White" : "Black"} wins`
      : "Draw"
    : null;

  const live = !result && status === "watching";
  const turn = sideToMoveFromFen(fen);
  const mat = material(fen);
  const tc = meta ? tcLabel(meta.initial_secs, meta.increment_secs) : null;

  return (
    <div className="container">
      <div style={{ marginBottom: 12 }}>
        <Link href="/" className="muted">
          ← Back to lobby
        </Link>
      </div>
      <div className="game-wrap">
        <div className="board-col">
          <PlayerBar
            color="black"
            name={meta ? seatName(meta.black_name, meta.black) : "Black"}
            engine={meta?.black_engine}
            clockMs={clock?.black_ms}
            active={live && turn === "black"}
            captured={mat.blackCaptured}
            edge={-mat.advantage}
          />
          <Chessboard fen={fen} lastMove={lastMoveFromUci(lastUci)} check={inCheck} />
          <PlayerBar
            color="white"
            name={meta ? seatName(meta.white_name, meta.white) : "White"}
            engine={meta?.white_engine}
            clockMs={clock?.white_ms}
            active={live && turn === "white"}
            captured={mat.whiteCaptured}
            edge={mat.advantage}
          />
        </div>

        <div className="sidebar">
          <div className="panel">
            <div style={{ fontWeight: 700, color: "var(--text-strong)" }}>
              Spectating {status === "reconnecting…" && <span className="muted">· reconnecting…</span>}
            </div>
            <div className="muted" style={{ marginTop: 6, fontSize: 14 }}>
              {meta ? (
                <>
                  {meta.stake ? (
                    <>
                      Stake <b style={{ color: "var(--text-strong)" }}>{fmtUsdc(meta.stake)} USDC</b>{" "}
                      <span className="tag tag-rated">Rated</span>
                    </>
                  ) : (
                    <>
                      Casual <span className="tag">Free</span>
                    </>
                  )}
                  {tc && (
                    <>
                      {" · "}
                      {tc} {TC_NAME[tc] ?? ""}
                    </>
                  )}
                </>
              ) : status === "finished" || status === "disconnected" ? (
                <>This game isn’t live right now — it may have finished.</>
              ) : (
                <>Loading game details…</>
              )}
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
              <div style={{ marginTop: 10, display: "flex", gap: 8, justifyContent: "center" }}>
                <button className="ghost" onClick={() => window.location.reload()}>
                  Review game
                </button>
                <Link href="/" className="ghost">
                  Play
                </Link>
              </div>
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
