"use client";

import { Chess } from "chessops/chess";
import { INITIAL_FEN, makeFen } from "chessops/fen";
import { makeSanAndPlay } from "chessops/san";
import { parseUci } from "chessops/util";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Chessboard } from "@/components/Chessboard";
import { PlayerBar } from "@/components/PlayerBar";
import { lastMoveFromUci, material, sideToMoveFromFen } from "@/lib/board";
import { shortAddress } from "@/lib/address";
import { SERVER_HTTP, SERVER_WS } from "@/lib/config";
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

export default function GamePage() {
  const params = useParams();
  const id = String(params.id);

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

  // Fetch the live-game metadata once so the spectator sees who's playing, the
  // stake, and the time control — not just a bare game id.
  useEffect(() => {
    let off = false;
    fetch(`${SERVER_HTTP}/games/live`)
      .then((r) => (r.ok ? r.json() : []))
      .then((games: (Meta & { game_id: string })[]) => {
        if (off) return;
        const g = games.find((x) => x.game_id === id);
        if (g) setMeta(g);
      })
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [id]);

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
                <Link href="/" className="ghost">
                  Watch another
                </Link>
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
