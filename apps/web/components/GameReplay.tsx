"use client";

import { Chess } from "chessops/chess";
import { INITIAL_FEN, makeFen } from "chessops/fen";
import { parseUci } from "chessops/util";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Chessboard } from "@/components/Chessboard";
import { EvalToggle } from "@/components/EvalBar";
import { MoveNav, MovePanel } from "@/components/Moves";
import { PlayerBar } from "@/components/PlayerBar";
import { playerLabel } from "@/lib/playerLabel";
import { lastMoveFromUci, material, type Side } from "@/lib/board";
import { other, useFlip } from "@/lib/useFlip";
import { fmtUsdc } from "@/lib/escrow";
import type { GameDetail } from "@/lib/gameApi";
import { bucketOf } from "@/lib/profileFilter";
import { TC_NAME, tcLabel } from "@/lib/timeControls";
import { useEval, useEvalPref } from "@/lib/useEval";
import { usePlyNav } from "@/lib/usePlyNav";
import { shortAddr, verifyResultSig, type Verification } from "@/lib/verify";

/** Best display name for a seat: short wallet, else "Engine" (casual).
 *
 *  No username here, and that's a payload gap rather than a helper gap:
 *  `/players/{addr}/games` and `GET /games/{id}` carry wallets only. Upgrading
 *  it needs `white_username`/`black_username` on those responses. */
const seatName = (addr: string | null) => playerLabel({ address: addr, fallback: "Engine" });

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
  // Shared with the live spectator, so navigation behaves identically in both
  // (including ←/→/Home/End). A finished game starts at the final position.
  const nav = usePlyNav(total);
  const at = nav.at;

  const [evalOn, setEvalOn] = useEvalPref();
  const fen = frames.fens[at];
  const engineEval = useEval(fen, evalOn);

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
      // No onchain settlement happens for an aborted game; any locked stake is
      // refunded on abort. Don't show the misleading "Settling onchain…".
      return detail.stake ? { cls: "", text: "The game didn’t start, so your stake was refunded." } : null;
    }
    if (!detail.stake) return null;
    switch (detail.settlement_status) {
      case "settled":
        return { cls: "won", text: "Settled onchain ✓" };
      case "failed":
        return { cls: "lost", text: "Settlement failed. Funds are recoverable onchain." };
      case "pending":
        return { cls: "", text: "Settling onchain…" };
      default:
        return null;
    }
  })();

  const { orientation, flip } = useFlip("white");

  // Name-plates follow perspective, not color — the side you are looking from
  // sits at the bottom, so flipping the board has to move them too.
  const bar = (side: Side) => {
    const w = side === "white";
    return (
      <PlayerBar
        color={side}
        name={seatName(w ? detail.white : detail.black)}
        engine={(w ? detail.white_engine : detail.black_engine) ?? undefined}
        clockMs={w ? clock.white_ms : clock.black_ms}
        captured={w ? mat.whiteCaptured : mat.blackCaptured}
        edge={w ? mat.advantage : -mat.advantage}
      />
    );
  };

  return (
    <div className="container">
      <div style={{ marginBottom: 12 }}>
        <Link href="/" className="muted">
          ← Back to lobby
        </Link>
      </div>
      <div className="game-wrap">
        <div className="board-col">
          {bar(other(orientation))}
          <Chessboard
            fen={fen}
            orientation={orientation}
            lastMove={frames.lastMoves[at]}
            check={frames.checks[at]}
            showEval={evalOn && !engineEval.failed}
            evalScore={engineEval.score}
            evalThinking={engineEval.thinking}
            onFlip={flip}
          />
          {bar(orientation)}
          {/* Replay transport */}
          <MoveNav
            at={at}
            total={total}
            onFirst={nav.first}
            onPrev={nav.prev}
            onNext={nav.next}
            onLast={nav.last}
          />
        </div>

        <div className="sidebar">
          <div className="panel">
            <div style={{ fontWeight: 700, color: "var(--text-strong)" }}>Game review</div>
            <div className="muted" style={{ marginTop: 6, fontSize: 14 }}>
              {/* Keyed on the ladder, not the stake: a buy-in tournament game is
                  ranked while carrying no stake of its own, and calling that
                  "Casual" here would contradict the Elo it just moved. */}
              {bucketOf(detail) === "ranked" ? (
                <>
                  {detail.stake ? (
                    <>
                      Stake{" "}
                      <b style={{ color: "var(--text-strong)" }}>{fmtUsdc(detail.stake)} USDC</b>{" "}
                    </>
                  ) : (
                    <>Tournament </>
                  )}
                  <span className="tag tag-rated">Ranked</span>
                </>
              ) : (
                <>
                  Casual <span className="tag">Free</span>
                </>
              )}
              {" · "}
              {tc} {TC_NAME[tc] ?? ""}
            </div>
            <EvalToggle
              on={evalOn}
              onChange={setEvalOn}
              loading={engineEval.loading}
              failed={engineEval.failed}
            />
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
              <div className="verified">✓ Verified, signed by oracle {shortAddr(verified.oracle)}</div>
            )}
          </div>

          <MovePanel
            sans={detail.moves.map((m) => m.san)}
            at={at}
            onSelect={nav.go}
            emptyText="No moves recorded."
          />

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
