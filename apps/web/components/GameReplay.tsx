"use client";

import { Chess } from "chessops/chess";
import { INITIAL_FEN, makeFen } from "chessops/fen";
import { parseUci } from "chessops/util";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Chessboard } from "@/components/Chessboard";
import { PlayerBar } from "@/components/PlayerBar";
import { shortAddress } from "@/lib/address";
import { lastMoveFromUci, material, sideToMoveFromFen } from "@/lib/board";
import { fmtUsdc } from "@/lib/escrow";
import type { GameDetail } from "@/lib/gameApi";
import { TC_NAME, tcLabel } from "@/lib/timeControls";
import { shortAddr, verifyResultSig, type Verification } from "@/lib/verify";

/** Best display name for a seat: short wallet, else "Engine" (casual). */
function seatName(addr: string | null): string {
  return addr ? shortAddress(addr) : "Engine";
}

/** Replay a finished game move-by-move: navigable board (click a move, ←/→,
 *  Home/End), per-move clocks, player name-plates, and the result + settlement
 *  outcome. Reuses the same board/PlayerBar the live views use. */
export function GameReplay({ detail }: { detail: GameDetail }) {
  // Precompute the position, last-move and check at every ply by replaying the
  // moves once — cheap and lets navigation be an O(1) index.
  const frames = useMemo(() => {
    const pos = Chess.default();
    const fens = [INITIAL_FEN];
    const lastMoves: ([string, string] | null)[] = [null];
    const checks: ("white" | "black" | null)[] = [null];
    for (const m of detail.moves) {
      const mv = parseUci(m.uci);
      const applied = !!mv && pos.isLegal(mv);
      if (applied) pos.play(mv);
      fens.push(makeFen(pos.toSetup()));
      // Only highlight a move we actually applied — never point at an unplayed
      // one (defensive; real games always parse+apply, as the live views prove).
      lastMoves.push(applied ? lastMoveFromUci(m.uci) : null);
      checks.push(pos.isCheck() ? pos.turn : null);
    }
    return { fens, lastMoves, checks };
  }, [detail]);

  const total = detail.moves.length;
  const [ply, setPly] = useState(total); // start at the final position
  const at = Math.min(Math.max(ply, 0), total);

  // Verify the oracle signature over the result commitment, so the permanent
  // replay shows the same "provably fair" badge the live/seat views show.
  const [verified, setVerified] = useState<Verification | null>(null);
  useEffect(() => {
    let off = false;
    if (detail.result_hash && detail.result_sig) {
      verifyResultSig(detail.result_hash, detail.result_sig).then((v) => {
        if (!off) setVerified(v);
      });
    } else {
      setVerified(null);
    }
    return () => {
      off = true;
    };
  }, [detail.result_hash, detail.result_sig]);

  // Keyboard navigation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't hijack keys while the user is typing in a field.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft") setPly((p) => Math.max(0, p - 1));
      else if (e.key === "ArrowRight") setPly((p) => Math.min(total, p + 1));
      else if (e.key === "Home") setPly(0);
      else if (e.key === "End") setPly(total);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [total]);

  const fen = frames.fens[at];
  const turn = sideToMoveFromFen(fen);
  const mat = material(fen);
  // Clocks: the initial time before move 1, else the clock after the played move.
  const clock =
    at === 0
      ? { white_ms: detail.initial_secs * 1000, black_ms: detail.initial_secs * 1000 }
      : { white_ms: detail.moves[at - 1].white_ms, black_ms: detail.moves[at - 1].black_ms };

  // An aborted game never really started (e.g. escrow open or seat dispatch
  // failed); it carries an internal reason code, not a chess reason, and its
  // stake was refunded directly (never through the settlement outbox), so its
  // settlement_status stays 'pending' — don't render it as a normal result.
  const aborted = detail.status === "aborted";
  const resultText = aborted
    ? "Game didn’t start"
    : detail.result === "draw"
      ? "Draw"
      : detail.result === "white"
        ? "White wins"
        : detail.result === "black"
          ? "Black wins"
          : "Game over";
  const tc = tcLabel(detail.initial_secs, detail.increment_secs);

  const settleLine = (() => {
    if (aborted) {
      // No on-chain settlement happens for an aborted game; any locked stake is
      // refunded on abort. Don't show the misleading "Settling on-chain…".
      return detail.stake ? { cls: "", text: "The game didn’t start — your stake was refunded." } : null;
    }
    if (!detail.stake) return null;
    switch (detail.settlement_status) {
      case "settled":
        return { cls: "won", text: "Settled on-chain ✓" };
      case "failed":
        return { cls: "lost", text: "Settlement failed — funds recoverable on-chain" };
      case "pending":
        return { cls: "", text: "Settling on-chain…" };
      default:
        return null;
    }
  })();

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
            name={seatName(detail.black)}
            clockMs={clock.black_ms}
            captured={mat.blackCaptured}
            edge={-mat.advantage}
          />
          <Chessboard fen={fen} lastMove={frames.lastMoves[at]} check={frames.checks[at]} />
          <PlayerBar
            color="white"
            name={seatName(detail.white)}
            clockMs={clock.white_ms}
            captured={mat.whiteCaptured}
            edge={mat.advantage}
          />
          {/* Replay transport */}
          <div className="replay-nav" role="group" aria-label="Replay controls">
            <button onClick={() => setPly(0)} disabled={at === 0} aria-label="Start">
              ⏮
            </button>
            <button onClick={() => setPly((p) => Math.max(0, p - 1))} disabled={at === 0} aria-label="Previous move">
              ◀
            </button>
            <span className="replay-count">
              {at} / {total}
            </span>
            <button
              onClick={() => setPly((p) => Math.min(total, p + 1))}
              disabled={at === total}
              aria-label="Next move"
            >
              ▶
            </button>
            <button onClick={() => setPly(total)} disabled={at === total} aria-label="End">
              ⏭
            </button>
          </div>
        </div>

        <div className="sidebar">
          <div className="panel">
            <div style={{ fontWeight: 700, color: "var(--text-strong)" }}>Game review</div>
            <div className="muted" style={{ marginTop: 6, fontSize: 14 }}>
              {detail.stake ? (
                <>
                  Stake <b style={{ color: "var(--text-strong)" }}>{fmtUsdc(detail.stake)} USDC</b>{" "}
                  <span className="tag tag-rated">Rated</span>
                </>
              ) : (
                <>
                  Casual <span className="tag">Free</span>
                </>
              )}
              {" · "}
              {tc} {TC_NAME[tc] ?? ""}
            </div>
          </div>

          <div className={`result-banner ${settleLine?.cls ?? ""}`}>
            {resultText}
            {/* chess reasons (checkmate, resignation…) are human-readable; an
                aborted game's reason is an internal code, so don't surface it. */}
            {!aborted && detail.reason && <span className="muted"> · {detail.reason}</span>}
            {settleLine && (
              <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                {settleLine.text}
              </div>
            )}
            {verified?.signed && (
              <div className="verified">✓ Verified — signed by oracle {shortAddr(verified.oracle)}</div>
            )}
          </div>

          <div className="panel">
            <div className="muted" style={{ marginBottom: 8 }}>
              Moves
            </div>
            <div className="moves">
              {total === 0 && <span className="muted">No moves recorded.</span>}
              {detail.moves.map((m, i) => (
                <span key={i}>
                  {i % 2 === 0 && <span className="num">{i / 2 + 1}.</span>}
                  <button
                    className={`move-btn${at === i + 1 ? " active" : ""}`}
                    onClick={() => setPly(i + 1)}
                  >
                    {m.san}
                  </button>{" "}
                </span>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <Link href="/" className="ghost">
              Play
            </Link>
            {(detail.white || detail.black) && (
              <Link href={`/player/${(detail.white ?? detail.black)!.toLowerCase()}`} className="ghost">
                Players
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
