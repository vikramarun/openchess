"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Chessboard } from "@/components/Chessboard";
import { EvalToggle } from "@/components/EvalBar";
import { MoveNav, MovePanel } from "@/components/Moves";
import { PlayerBar } from "@/components/PlayerBar";
import { lastMoveFromUci, material, sideToMoveFromFen } from "@/lib/board";
import { shortAddress } from "@/lib/address";
import { SERVER_HTTP, SERVER_WS } from "@/lib/config";
import { connectSpectator } from "@/lib/spectatorSocket";
import { fmtUsdc } from "@/lib/escrow";
import { TC_NAME, tcLabel } from "@/lib/timeControls";
import { useEval, useEvalPref } from "@/lib/useEval";
import { usePlyNav } from "@/lib/usePlyNav";
import { useSpectatorBoard } from "@/lib/useSpectatorBoard";
import { shortAddr } from "@/lib/verify";

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

/** Watch an in-progress game over a read-only spectator socket. The board is
 *  navigable while the game runs — stepping back doesn't stop the stream, and
 *  the "Live" pill returns to the newest position. When it ends the banner
 *  offers a move-by-move Review (a reload re-enters `/game/[id]` in replay mode,
 *  now that the game is finished). */
export function LiveSpectator({ id }: { id: string }) {
  const { fen, moves, frames, clock, result, verified, applyFrame } = useSpectatorBoard();
  const [status, setStatus] = useState("connecting…");
  const [meta, setMeta] = useState<Meta | null>(null);

  // Navigate the game while it is still being played; `nav.live` means we're
  // showing the newest position (so clocks and the turn indicator are current).
  const nav = usePlyNav(frames.length - 1);
  const view = frames[nav.at];
  const [evalOn, setEvalOn] = useEvalPref();
  const engineEval = useEval(view.fen, evalOn);

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
    let finished = false;
    const spectator = connectSpectator({
      url: `${SERVER_WS}/ws/game/${id}`,
      onFrame: (data) =>
        applyFrame(data, () => {
          finished = true; // game ended — stop reconnecting to a soon-reaped room
          setStatus("finished");
        }),
      onStatus: setStatus,
      liveStatus: "watching",
      isFinished: () => finished,
      isCancelled: () => cancelled,
    });
    return () => {
      cancelled = true;
      spectator.close();
    };
  }, [id, applyFrame]);

  const winnerText = result
    ? result.winner
      ? `${result.winner === "white" ? "White" : "Black"} wins`
      : "Draw"
    : null;

  const live = !result && status === "watching";
  // The name-plates describe the LIVE game — clock and whose turn it is — and
  // stay put while you scrub; only the board, material and eval follow the ply
  // you're looking at. (This is also why there's no per-ply clock here: the
  // live stream doesn't carry clock history. See BoardFrame.)
  const turn = sideToMoveFromFen(fen);
  const mat = material(view.fen);
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
          <Chessboard
            fen={view.fen}
            lastMove={lastMoveFromUci(view.lastUci)}
            check={view.check}
            showEval={evalOn && !engineEval.failed}
            evalScore={engineEval.score}
            evalThinking={engineEval.thinking}
          />
          <PlayerBar
            color="white"
            name={meta ? seatName(meta.white_name, meta.white) : "White"}
            engine={meta?.white_engine}
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
                <>
                  This game isn’t live right now — it may have finished.
                  <div style={{ marginTop: 8 }}>
                    <button className="ghost" onClick={() => window.location.reload()}>
                      Load replay
                    </button>
                  </div>
                </>
              ) : (
                <>Loading game details…</>
              )}
            </div>
            <EvalToggle
              on={evalOn}
              onChange={setEvalOn}
              loading={engineEval.loading}
              failed={engineEval.failed}
            />
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

          <MovePanel
            sans={moves}
            at={nav.at}
            onSelect={nav.go}
            emptyText="waiting…"
            behind={!nav.live}
          />
        </div>
      </div>
    </div>
  );
}
