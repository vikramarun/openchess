"use client";

import { useEffect, useState } from "react";

import { fmtUsdc, profitForStake } from "@/lib/escrow";
import { TC_NAME, tcLabel } from "@/lib/timeControls";

export type ConfirmOpponent = { name: string; declared_engine?: string | null } | null;

/** Fallback window when the server doesn't tell us its deadline (a node
 *  predating `Welcome.start_deadline_ms`). Deliberately short: guessing long is
 *  how you promise time that was already taken back. */
export const FALLBACK_WINDOW_MS = 30_000;

/** Expire slightly before the server does, so a player who runs out of time
 *  sees this prompt call the game off rather than watching a dialog that is
 *  already dead argue with a "game voided" banner arriving behind it. */
const SAFETY_MARGIN_MS = 3_000;

/** The pre-game handshake: what's on the line, who you drew, and an explicit
 *  "go" from both sides before a move is played. The seat holds back its
 *  `ready` frame until this resolves (see lib/play.ts), and the server won't
 *  start a game until BOTH seats have readied — so this really is mutual, not
 *  a local speed bump. */
export function StakeConfirm({
  opponent,
  color,
  stake,
  initialSecs,
  incrementSecs,
  deadlineMs,
  waiting,
  onAccept,
  onDecline,
}: {
  opponent: ConfirmOpponent;
  color: "white" | "black";
  stake?: string | null;
  initialSecs?: number | null;
  incrementSecs?: number | null;
  /** Milliseconds the SERVER will still wait, as reported in `welcome`. Null
   *  on a server that doesn't report it. */
  deadlineMs?: number | null;
  /** We've accepted; the other side hasn't. */
  waiting: boolean;
  onAccept: (autoAcceptFuture: boolean) => void;
  onDecline: () => void;
}) {
  const [auto, setAuto] = useState(false);
  const windowMs = Math.max(
    0,
    (deadlineMs ?? FALLBACK_WINDOW_MS) - SAFETY_MARGIN_MS,
  );
  const [left, setLeft] = useState(Math.round(windowMs / 1000));

  // One countdown for the whole prompt, including the "waiting for them" half:
  // the server's reap doesn't care which side is slow, so neither does this.
  // Anchored to the server's own deadline, so it can't promise time that the
  // room has already spent booting this client's engine.
  useEffect(() => {
    const deadline = Date.now() + windowMs;
    const tick = () => setLeft(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [windowMs]);

  // Silence is a decline. Left alone the room would be reaped anyway; doing it
  // here means the player sees why, instead of a board that never starts.
  useEffect(() => {
    if (left === 0 && !waiting) onDecline();
  }, [left, waiting, onDecline]);

  const wagered = !!stake;
  const oppName = opponent?.name ?? "your opponent";
  const tc =
    initialSecs != null
      ? tcLabel(initialSecs, incrementSecs ?? 0)
      : null;

  return (
    <div className="modal-overlay">
      <div className="modal confirm-modal" role="dialog" aria-modal="true" aria-label="Confirm the game">
        <div className="confirm-hero">{wagered ? "⚔" : "♟"}</div>
        <div className="modal-title">{wagered ? "Stakes are locked" : "Game on"}</div>

        <div className="confirm-facts">
          <div>
            <span className="muted">Opponent</span>
            <b>{oppName}</b>
            {opponent?.declared_engine && (
              <span className="muted" style={{ fontSize: 12 }}> 🤖 {opponent.declared_engine}</span>
            )}
          </div>
          <div>
            <span className="muted">You play</span>
            <b>{color === "white" ? "White" : "Black"}</b>
          </div>
          {tc && (
            <div>
              <span className="muted">Clock</span>
              <b>{tc}</b>
              <span className="muted" style={{ fontSize: 12 }}> {TC_NAME[tc] ?? "Custom"}</span>
            </div>
          )}
        </div>

        {wagered ? (
          <div className="stake-callout confirm-stake">
            <div className="confirm-stake-amount">{fmtUsdc(stake)} USDC</div>
            <div>
              Win and you take <b>+{fmtUsdc(profitForStake(stake))} USDC</b>. That’s their
              stake, less a 1% fee. A draw returns yours.
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
              Rated. Locked in the escrow contract, settled onchain when the game ends.
            </div>
          </div>
        ) : (
          <div className="stake-callout confirm-stake">
            <div className="confirm-stake-amount">Free</div>
            <div>Casual game. Nothing staked and your rating doesn’t move.</div>
          </div>
        )}

        {waiting ? (
          <>
            <div className="confirm-waiting">
              <span className="confirm-spinner" aria-hidden="true" />
              Waiting for {oppName} to accept…
            </div>
            <div className="muted confirm-countdown">
              {left > 0 ? `${left}s left before the game is called off` : "Calling it off…"}
            </div>
          </>
        ) : (
          <>
            <label className="confirm-auto">
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
              <span>Auto-accept from now on and skip this prompt</span>
            </label>
            <button className="primary modal-play" onClick={() => onAccept(auto)}>
              {wagered ? "Play for it ⚔" : "Let’s play ♟"}
            </button>
            <button className="modal-cancel muted" onClick={onDecline}>
              Not this one
            </button>
            <div className="muted confirm-countdown">
              Both players have to accept. {left > 0 ? `${left}s left` : "Time’s up"}, and
              after that the game is called off
              {wagered ? " and your stake comes back" : ""}.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
