"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Chessboard } from "@/components/Chessboard";
import { MoveNav, MovePanel } from "@/components/Moves";
import { PlayerBar } from "@/components/PlayerBar";
import { StakeConfirm, type ConfirmOpponent } from "@/components/StakeConfirm";
import { autoAcceptEnabled, setAutoAccept } from "@/lib/autoAccept";
import { lastMoveFromUci, material, sideToMoveFromFen, type Side } from "@/lib/board";
import { other, useFlip } from "@/lib/useFlip";
import { SERVER_WS } from "@/lib/config";
import { BrowserEngine } from "@/lib/engine";
import { acquirePlayerEngine, fallbackEngine, releasePlayerEngine } from "@/lib/playerEngine";
import { useLiveSeatHold } from "@/lib/liveSeat";
import { playSeat } from "@/lib/play";
import { connectSpectator } from "@/lib/spectatorSocket";
import { contractUrl, fmtUsdc, profitForStake } from "@/lib/escrow";
import { toWhiteRelative, type EvalScore } from "@/lib/evalScore";
import { fetchGame } from "@/lib/gameApi";
import { useEval, useEvalPref } from "@/lib/useEval";
import { usePlyNav } from "@/lib/usePlyNav";
import { useOnchainConfig } from "@/lib/useOnchainConfig";
import { useSpectatorBoard } from "@/lib/useSpectatorBoard";
import { shortAddr } from "@/lib/verify";

type Opponent = { name: string; declared_engine: string | null };

/** Play ONE seat of a server game in the browser (the opponent runs theirs).
 *  Renders the live board from a spectator socket; drives the user's seat with
 *  an in-browser Stockfish. Used by the staked modes. */
export function SeatGame({
  gameId,
  token,
  color,
  stake,
  onDone,
  onResult,
  subtitle,
  confirmStakes = false,
  opponentPreview = null,
  initialSecs,
  incrementSecs,
}: {
  gameId: string;
  token: string;
  color: "white" | "black";
  stake?: string | null;
  onDone?: () => void;
  /** Fires once when the game ends — used by gauntlet/tournament to advance. */
  onResult?: (winner: "white" | "black" | null) => void;
  subtitle?: string;
  /** Ask the player to confirm the stakes before this seat readies. Off for
   *  the modes that dispatch games in batches (gauntlet, tournament rounds),
   *  where a prompt per pairing would be a treadmill. */
  confirmStakes?: boolean;
  /** Who the matchmaker paired us with, for the confirmation prompt. The
   *  socket only names the opponent in `game_start`, which the server holds
   *  back until both seats ready — i.e. until after this prompt is answered. */
  opponentPreview?: ConfirmOpponent;
  initialSecs?: number | null;
  incrementSecs?: number | null;
}) {
  // Declare this board to the sign-in gate for the life of the mount: the gate
  // re-walls a page when the session goes away, and the hold is what stops that
  // from unmounting a live game and forfeiting its stake (lib/liveSeat.ts).
  useLiveSeatHold();
  const { fen, moves, frames, clock, result, verified, applyFrame } = useSpectatorBoard();
  // Your own game is navigable while you play it, exactly as it is when you
  // spectate one: stepping back doesn't pause the stream or your engine (it only
  // drives its seat over its own socket), and `nav.live` means we're showing the
  // newest position, so the clocks and turn indicator still apply.
  const nav = usePlyNav(frames.length - 1);
  const view = frames[nav.at];
  const [opponent, setOpponent] = useState<Opponent | null>(null);
  const [engineSwapped, setEngineSwapped] = useState(false);
  const [status, setStatus] = useState("loading engine…");
  const [settleStatus, setSettleStatus] = useState<string | null>(null);
  // The seat's `ready` frame, parked until the player answers the prompt. The
  // resolver lives in a ref (settling a promise isn't render-safe state) while
  // the flag that shows the dialog is ordinary state.
  const confirmResolve = useRef<((ok: boolean) => void) | null>(null);
  const [prompting, setPrompting] = useState(false);
  // Kept OUT of `prompting` on purpose. Accepting clears `prompting` but the
  // dialog stays up as "waiting for them", and the countdown must keep running
  // against the same server deadline. Folding the two together resets the
  // countdown to the client-side fallback at the moment of accepting — which
  // is the lying-countdown bug this deadline exists to prevent.
  const [promptDeadlineMs, setPromptDeadlineMs] = useState<number | null>(null);
  const [awaitingOpponent, setAwaitingOpponent] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [evalOn] = useEvalPref();
  // White-relative score per ply, filled in by our OWN seat engine as it thinks
  // (lib/play.ts `onEval`). Keyed by ply rather than kept as a single "current"
  // score so scrubbing back shows what the engine actually thought there instead
  // of the live tip's number pinned next to an old position.
  const [evalByPly, setEvalByPly] = useState<Record<number, EvalScore>>({});
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  /** Answer the parked prompt. Idempotent — the second call is a no-op. */
  const settleConfirm = useCallback((ok: boolean) => {
    confirmResolve.current?.(ok);
    confirmResolve.current = null;
    setPrompting(false);
  }, []);

  useEffect(() => {
    let canceled = false;
    const canceledFn = () => canceled;
    let engine: BrowserEngine | null = null;
    let released = true;
    let spectator: { close: () => void } | null = null;
    let seat: { close: () => void } | null = null;
    let finished = false;

    const run = async () => {
      setEvalByPly({}); // a new game starts from an empty eval history
      // Normally already warm: the lobby prewarms before it stakes anything,
      // precisely so a 7 MB download can't fail with money escrowed.
      engine = await acquirePlayerEngine();
      // Release here rather than relying on the cleanup below: if the effect
      // was torn down DURING the await, cleanup has already run and saw
      // `released` still true, so nothing would ever give this reference back
      // and the engine would stay pinned for the life of the tab.
      if (canceled) {
        releasePlayerEngine();
        return;
      }
      released = false;

      // The spectator socket renders the live board (shared reducer); it
      // reconnects with backoff so a dropped connection mid-game shows
      // "reconnecting…" and recovers rather than freezing the board while money
      // is on the line.
      spectator = connectSpectator({
        url: `${SERVER_WS}/ws/game/${gameId}`,
        onFrame: (data) =>
          applyFrame(data, (winner) => {
            finished = true; // stop reconnecting — the game is over
            setStatus("finished");
            onResultRef.current?.(winner);
          }),
        onStatus: setStatus,
        liveStatus: "playing",
        isFinished: () => finished,
        isCanceled: () => canceled,
      });

      // Drive only our seat; the fixed movetime is a fallback — playSeat uses
      // the authoritative clock from your_turn when present.
      seat = playSeat(
        gameId,
        token,
        engine,
        400,
        {
          onEvent: (m) => {
            if (m?.type === "game_start") {
              setAwaitingOpponent(false); // they readied too — we're live
              if (m.opponent) setOpponent(m.opponent);
            }
          },
          // A dead worker must not forfeit a stake — play on with a fresh one.
          onEngineFallback: async () => {
            setEngineSwapped(true);
            return fallbackEngine();
          },
          // Our seat's search, reused. The score is from the side to move's
          // perspective (UCI), and the side to move at ply N is white when N is
          // even — so the flip to white-relative needs no board lookup.
          onEval: (info, ply) => {
            const score = toWhiteRelative(info, ply % 2 === 0 ? "white" : "black");
            setEvalByPly((prev) => ({ ...prev, [ply]: score }));
          },
          // Resolved by the modal below. Skipped entirely when the player has
          // opted out, so auto-accept costs nothing on the hot path.
          confirmStart:
            confirmStakes && !autoAcceptEnabled()
              ? (deadlineMs) =>
                  new Promise<boolean>((resolve) => {
                    confirmResolve.current = resolve;
                    setPromptDeadlineMs(deadlineMs);
                    setPrompting(true);
                  })
              : undefined,
        },
        canceledFn,
      );
    };

    run().catch(() => {
      if (!canceled) setStatus("failed to start");
    });

    return () => {
      canceled = true;
      spectator?.close();
      seat?.close();
      // Release rather than dispose: the seat engine is shared and stays warm
      // for a minute, so the next game doesn't re-download 7 MB.
      if (!released) {
        released = true;
        releasePlayerEngine();
      }
    };
  }, [gameId, token, applyFrame, confirmStakes]);

  // A game can end before the prompt is answered — the server reaps a room
  // whose seats never both readied. Take the prompt down rather than leave a
  // dialog offering to start a game that no longer exists.
  useEffect(() => {
    if (!result) return;
    setAwaitingOpponent(false);
    settleConfirm(false);
  }, [result, settleConfirm]);

  // Once a wagered game ends, poll the game's settlement status so the banner can
  // confirm "Settled ✓" (or surface a failure) instead of leaving the user
  // staring at "settling…". Bounded; the durable outbox usually settles within a
  // few seconds.
  useEffect(() => {
    if (!result || !stake) return;
    let off = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      fetchGame(gameId).then((d) => {
        if (off) return;
        const s = d?.settlement_status ?? null;
        if (s) setSettleStatus(s);
        if (s === "settled" || s === "failed") return; // terminal
        if (++tries < 20) timer = setTimeout(poll, 3000); // ~60s
      });
    };
    poll();
    return () => {
      off = true;
      if (timer) clearTimeout(timer);
    };
  }, [result, stake, gameId]);

  const winnerText = result
    ? result.winner
      ? `${result.winner === "white" ? "White" : "Black"} wins`
      : "Draw"
    : null;
  const youWon = result && result.winner === color;
  const youLost = result && result.winner && result.winner !== color;

  const { config } = useOnchainConfig();
  const escrowUrl = config?.escrow ? contractUrl(config.chainId, config.escrow) : null;
  const settledText = youWon
    ? `you won +${fmtUsdc(profitForStake(stake ?? 0))} USDC`
    : youLost
      ? `you lost ${fmtUsdc(stake)} USDC`
      : "draw, so your stake was returned";

  const oppColor = color === "white" ? "black" : "white";
  const live = !result && status === "playing";
  // Name-plates describe the LIVE game — clock and whose turn it is — and stay
  // put while you scrub; only the board and material follow the ply you're
  // looking at. (Same split as LiveSpectator; the live stream carries no clock
  // history, so a per-ply clock here would be fiction.)
  const turn = sideToMoveFromFen(fen);
  const mat = material(view.fen);
  const myClock = clock ? (color === "white" ? clock.white_ms : clock.black_ms) : null;
  const oppClock = clock ? (color === "white" ? clock.black_ms : clock.white_ms) : null;
  const myCaptured = color === "white" ? mat.whiteCaptured : mat.blackCaptured;
  const oppCaptured = color === "white" ? mat.blackCaptured : mat.whiteCaptured;
  const myEdge = color === "white" ? mat.advantage : -mat.advantage;
  // Defaults to your own color at the bottom, which is what a seated player wants.
  const { orientation, flip } = useFlip(color);

  // Name-plates follow perspective, not color — the side you are looking from
  // sits at the bottom, so flipping the board has to move them too.
  const bar = (side: Side) =>
    side === color ? (
      <PlayerBar
        color={color}
        name="You"
        clockMs={myClock}
        active={live && turn === color}
        captured={myCaptured}
        edge={myEdge}
      />
    ) : (
      <PlayerBar
        color={oppColor}
        name={opponent?.name ?? "Opponent"}
        engine={opponent?.declared_engine}
        clockMs={oppClock}
        active={live && turn === oppColor}
        captured={oppCaptured}
        edge={-myEdge}
      />
    );

  // Our seat's engine searches ONLY on our own turns, and not at all for a book
  // move — with the default 16-ply book that would leave the bar blank for the
  // whole opening. So the shared observer engine fills the gaps, gated on our
  // engine being idle: it is a separate worker, but it only ever runs while our
  // seat is NOT thinking, so it can't take CPU from the search whose move
  // quality (and stake) is on the line.
  const myTurn = live && turn === color;
  const observer = useEval(view.fen, evalOn && !myTurn);
  // The viewed ply is read through a ref so this fires ONLY when a score
  // arrives, never when the viewer moves. useEval deliberately holds the last
  // position's score until the new one reports, so re-running on `nav.at` would
  // file the ply you just left under the ply you just opened.
  const atRef = useRef(nav.at);
  atRef.current = nav.at;
  useEffect(() => {
    const s = observer.score;
    if (!s) return;
    const ply = atRef.current;
    // Our own search goes far deeper than the observer's capped one, so the
    // deeper score for a ply wins regardless of which engine produced it.
    setEvalByPly((prev) =>
      prev[ply] && prev[ply].depth >= s.depth ? prev : { ...prev, [ply]: s },
    );
  }, [observer.score]);

  // Both sources land in the same per-ply record, so the bar reads from one
  // place. Gaps remain possible (a book move nobody looked at), and there the
  // most recent earlier score carries forward rather than snapping to level.
  const viewedEval = useMemo(() => {
    for (let p = nav.at; p >= 0; p--) {
      const s = evalByPly[p];
      if (s) return s;
    }
    return null;
  }, [evalByPly, nav.at]);
  const evalThinking = myTurn || observer.thinking;

  // Memoised: StakeConfirm's auto-decline effect lists onDecline as a
  // dependency, and a fresh identity each render would re-run it every render.
  const acceptConfirm = useCallback(
    (autoFuture: boolean) => {
      if (autoFuture) setAutoAccept(true);
      settleConfirm(true);
      setAwaitingOpponent(true);
    },
    [settleConfirm],
  );
  const declineConfirm = useCallback(() => {
    settleConfirm(false);
    setAwaitingOpponent(false);
    setDeclined(true);
  }, [settleConfirm]);

  return (
    <div className="game-wrap">
      {(prompting || awaitingOpponent) && !result && (
        <StakeConfirm
          opponent={opponent ?? opponentPreview}
          color={color}
          stake={stake}
          initialSecs={initialSecs}
          incrementSecs={incrementSecs}
          deadlineMs={promptDeadlineMs}
          waiting={awaitingOpponent}
          onAccept={acceptConfirm}
          onDecline={declineConfirm}
        />
      )}
      <div className="board-col">
        {bar(other(orientation))}
        <Chessboard
          fen={view.fen}
          orientation={orientation}
          lastMove={lastMoveFromUci(view.lastUci)}
          check={view.check}
          onFlip={flip}
          showEval={evalOn}
          evalScore={viewedEval}
          evalThinking={evalThinking}
        />
        {bar(orientation)}
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
            {subtitle ?? `Your game · ${color === "white" ? "White" : "Black"}`}
          </div>
          <div className="muted" style={{ fontSize: 14 }}>
            Your engine plays your seat in your browser. Your opponent runs theirs.
          </div>
          {stake && (
            <div className="stake-callout" style={{ marginTop: 10 }}>
              <div>
                Stake <b>{fmtUsdc(stake)} USDC</b> · win{" "}
                <b>+{fmtUsdc(profitForStake(stake))} USDC</b>
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
                Win and you take your opponent’s stake, less a 1% fee. A draw or a no-show
                returns yours. Non-custodial, settled onchain.
              </div>
            </div>
          )}
          <div className="muted" style={{ marginTop: 8 }}>
            Status: {status}
          </div>
          {engineSwapped && (
            <div className="muted" style={{ marginTop: 6, fontSize: 13, color: "var(--danger)" }}>
              Your engine stopped responding — this game is being played by a fresh Stockfish 18.
              Your settings still apply from the next game.
            </div>
          )}
        </div>

        {declined && !result && (
          <div className="result-banner">
            You passed on this one.
            <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
              Stay on this page for a moment while the game is called off
              {stake ? " and your stake comes back" : ""}. Leaving now hands your opponent a
              forfeit{stake ? ", and the stake with it" : ""}.
            </div>
          </div>
        )}

        {result && (
          <div className={`result-banner ${youWon ? "won" : youLost ? "lost" : ""}`}>
            {youWon ? "You win" : youLost ? "You lose" : winnerText} · {result.reason}
            {stake && (
              <div style={{ fontSize: 13, marginTop: 6 }}>
                {settleStatus === "settled" ? (
                  <span style={{ color: youWon ? "var(--accent)" : "var(--text)" }}>
                    Settled onchain ✓ · {settledText}
                  </span>
                ) : settleStatus === "failed" ? (
                  <span className="muted">
                    Settlement is delayed. Your funds are safe and recoverable onchain once
                    the settle window opens.{" "}
                    {escrowUrl && (
                      <a href={escrowUrl} target="_blank" rel="noopener noreferrer">
                        View escrow ↗
                      </a>
                    )}
                  </span>
                ) : (
                  <span className="muted">
                    Settling onchain. Your balance updates once the oracle posts the result.
                  </span>
                )}
              </div>
            )}
            {verified?.signed && (
              <div className="verified">
                ✓ Verified, signed by oracle {shortAddr(verified.oracle)}
              </div>
            )}
          </div>
        )}

        <MovePanel sans={moves} at={nav.at} onSelect={nav.go} emptyText="…" behind={!nav.live} />

        {/* No early exit after declining, staked or not: leaving closes the
            socket, and the server only voids a game whose seats are both still
            attached — otherwise the opponent takes a forfeit win (and the
            stake). Waiting the room out costs under a minute and keeps
            "declined" from being recorded as a loss. */}
        {result && onDone && (
          <button className="primary" onClick={onDone}>
            Back to lobby
          </button>
        )}
      </div>
    </div>
  );
}
