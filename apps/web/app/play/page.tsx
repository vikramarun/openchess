"use client";

import { useCallback, useEffect, useState } from "react";

import { Chessboard } from "@/components/Chessboard";
import { MoveList, MoveNav } from "@/components/MoveNav";
import { PlayerBar } from "@/components/PlayerBar";
import { lastMoveFromUci, material, sideToMoveFromFen } from "@/lib/board";
import { ensureBookLoaded } from "@/lib/browserBot";
import { SERVER_HTTP, SERVER_WS } from "@/lib/config";
import { BrowserEngine } from "@/lib/engine";
import { playSeat } from "@/lib/play";
import { DEFAULT_TC, TIME_CONTROLS, tcByLabel, type TimeControl } from "@/lib/timeControls";
import { usePlyNav } from "@/lib/usePlyNav";
import { useSpectatorBoard } from "@/lib/useSpectatorBoard";
import { shortAddr } from "@/lib/verify";

export default function PlayPage() {
  // Shared frame reducer: same board state, same navigation as the wager view
  // and the spectator page.
  const { fen, moves, frames, clock, result, verified, applyFrame, reset } = useSpectatorBoard();
  const nav = usePlyNav(frames.length - 1);
  const view = frames[nav.at];
  const [status, setStatus] = useState("loading engines…");
  const [nonce, setNonce] = useState(0); // bump to start a new game
  const [tc, setTc] = useState<TimeControl | null>(null); // resolved on mount

  // Resolve the time control from the ?tc= query param (set by the homepage),
  // defaulting to 3+0. Done in an effect so SSR/CSR markup matches.
  useEffect(() => {
    const q =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("tc")
        : null;
    setTc(tcByLabel(q ?? DEFAULT_TC.label));
  }, []);

  // Clearing the board is only half of starting over: usePlyNav remembers the
  // ply you were viewing, and THIS page is not remounted between games (the
  // gauntlet and tournament views key SeatGame by game id, so they are). Without
  // re-attaching to the tip, scrubbing back in one game leaves the next one
  // pinned at that move — it plays on while you watch move 5.
  const followTip = nav.last;
  const startOver = useCallback(() => {
    reset();
    followTip();
  }, [reset, followTip]);

  const pickTc = (next: TimeControl) => {
    startOver();
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
      startOver();

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
      spectator.onmessage = (ev) => applyFrame(ev.data, () => setStatus("finished"));

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

  const live = !result && status === "playing";
  // Clocks and the turn indicator describe the live tip; the board and material
  // follow the ply you're viewing.
  const turn = sideToMoveFromFen(fen);
  const mat = material(view.fen);

  return (
    <div className="container">
      <div className="game-wrap">
        <div className="board-col">
          <PlayerBar
            color="black"
            name="Stockfish"
            engine="in browser"
            clockMs={clock?.black_ms}
            active={live && turn === "black"}
            captured={mat.blackCaptured}
            edge={-mat.advantage}
          />
          <Chessboard fen={view.fen} lastMove={lastMoveFromUci(view.lastUci)} check={view.check} />
          <PlayerBar
            color="white"
            name="Stockfish"
            engine="in browser"
            clockMs={clock?.white_ms}
            active={live && turn === "white"}
            captured={mat.whiteCaptured}
            edge={mat.advantage}
          />
          {nav.total > 0 && (
            <MoveNav
              at={nav.at}
              total={nav.total}
              mode={result ? "replay" : "live"}
              live={nav.live}
              onFirst={nav.first}
              onPrev={nav.prev}
              onNext={nav.next}
              onLast={nav.last}
            />
          )}
        </div>

        <div className="sidebar">
          <div className="panel">
            <div style={{ fontWeight: 700, color: "var(--text-strong)", marginBottom: 4 }}>
              Test Engine
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
              Moves {!nav.live && <span className="behind">· viewing move {nav.at}</span>}
            </div>
            <MoveList sans={moves} at={nav.at} onSelect={nav.go} emptyText="…" />
          </div>

          <button className="primary" onClick={() => setNonce((n) => n + 1)}>
            New game
          </button>
        </div>
      </div>
    </div>
  );
}
