"use client";

import { Chess } from "chessops/chess";
import { INITIAL_FEN, makeFen } from "chessops/fen";
import { makeSanAndPlay } from "chessops/san";
import { parseUci } from "chessops/util";
import { useEffect, useRef, useState } from "react";

import { Chessboard } from "@/components/Chessboard";
import { ensureBookLoaded } from "@/lib/browserBot";
import { SERVER_HTTP, SERVER_WS } from "@/lib/config";
import { BrowserEngine } from "@/lib/engine";
import { playSeat } from "@/lib/play";
import { DEFAULT_TC, TIME_CONTROLS, tcByLabel, type TimeControl } from "@/lib/timeControls";
import { shortAddr, verifyResultSig, type Verification } from "@/lib/verify";

type Clock = { white_ms: number; black_ms: number };
type Result = { winner: "white" | "black" | null; reason: string };

function fmt(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default function PlayPage() {
  const [fen, setFen] = useState(INITIAL_FEN);
  const [moves, setMoves] = useState<string[]>([]);
  const [clock, setClock] = useState<Clock | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [verified, setVerified] = useState<Verification | null>(null);
  const [status, setStatus] = useState("loading engines…");
  const [nonce, setNonce] = useState(0); // bump to start a new game
  const [tc, setTc] = useState<TimeControl | null>(null); // resolved on mount

  const pos = useRef(Chess.default());

  // Resolve the time control from the ?tc= query param (set by the homepage),
  // defaulting to 3+0. Done in an effect so SSR/CSR markup matches.
  useEffect(() => {
    const q =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("tc")
        : null;
    setTc(tcByLabel(q ?? DEFAULT_TC.label));
  }, []);

  const pickTc = (next: TimeControl) => {
    setResult(null);
    setVerified(null);
    setTc(next);
    setNonce((n) => n + 1); // restart even if the same control is re-picked
  };

  useEffect(() => {
    if (!tc) return; // wait until the time control is resolved
    let cancelled = false;
    const cancelledFn = () => cancelled;
    const engines: BrowserEngine[] = [];
    let spectator: WebSocket | null = null;
    const seats: { close: () => void }[] = [];

    const run = async () => {
      pos.current = Chess.default();
      setFen(INITIAL_FEN);
      setMoves([]);
      setResult(null);

      const white = new BrowserEngine();
      const black = new BrowserEngine();
      engines.push(white, black);
      setStatus("loading engines…");
      await Promise.all([white.whenReady(), black.whenReady()]);
      if (cancelled) return;
      // Warm the uploaded book. Note: the book is a shared cache, so both seats
      // follow it through the opening — "vs the house" diverges once out of book.
      await ensureBookLoaded();

      setStatus("creating game…");
      const resp = await fetch(`${SERVER_HTTP}/games`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initial_secs: tc.initial, increment_secs: tc.inc }),
      });
      if (!resp.ok) {
        setStatus(`server error (${resp.status}) — is the game server running?`);
        return;
      }
      const game = await resp.json();
      if (cancelled) return;

      // Spectator socket renders the live board (no token = read-only).
      spectator = new WebSocket(`${SERVER_WS}/ws/game/${game.game_id}`);
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
              break;
          }
        } catch {
          /* ignore one bad frame */
        }
      };

      // Two browser engines play the two seats.
      seats.push(playSeat(game.game_id, game.white_token, white, 300, {}, cancelledFn));
      seats.push(playSeat(game.game_id, game.black_token, black, 300, {}, cancelledFn));
    };

    run().catch(() => {
      // Ignore failures from a cancelled run (React StrictMode double-invokes
      // effects in dev; the first run is torn down immediately).
      if (!cancelled) setStatus("failed to start");
    });

    return () => {
      cancelled = true;
      spectator?.close();
      seats.forEach((s) => s.close());
      engines.forEach((e) => e.dispose());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, tc?.label]);

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
            <div style={{ fontWeight: 700, color: "var(--text-strong)", marginBottom: 4 }}>
              Quick Play
            </div>
            <div className="muted" style={{ fontSize: 14 }}>
              Two Stockfish engines playing in your browser — your CPU, not our servers.
            </div>
            <div className="tc-row" role="group" aria-label="Time control">
              {TIME_CONTROLS.map((t) => (
                <button
                  key={t.label}
                  className={`tc-pill${tc?.label === t.label ? " active" : ""}`}
                  onClick={() => pickTc(t)}
                  title={`${t.initial / 60} minute${t.initial === 60 ? "" : "s"}${
                    t.inc ? ` + ${t.inc}s` : ""
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="muted" style={{ marginTop: 8 }}>
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

          <button className="primary" onClick={() => setNonce((n) => n + 1)}>
            New game
          </button>
        </div>
      </div>
    </div>
  );
}
