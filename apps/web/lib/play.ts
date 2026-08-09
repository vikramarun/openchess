// Browser bring-your-own-engine client: connects to the game server over the
// same WebSocket protocol the native client uses, and drives a BrowserEngine.

import { Chess } from "chessops/chess";

import { ensureBookLoaded, getBrowserBotConfig, probeUserBook } from "./browserBot";
import { SERVER_WS } from "./config";
import { BrowserEngine } from "./engine";
import { bookMove } from "./openings";
import { anyLegalUci, replayHistory, toStandardUci, type Replay } from "./uci";

export type PlayHandlers = {
  onEvent?: (msg: any) => void;
  /** Asked once, before this seat declares itself ready. Resolving false holds
   *  the seat back: the server starts a game only when BOTH seats ready, so
   *  this is the hook a "confirm the stakes" prompt hangs off. Omit to ready
   *  immediately (the previous behaviour).
   *
   *  `deadlineMs` is how long the SERVER will still wait, straight from
   *  `welcome` — not a client-side constant. The window starts when the room
   *  is created, so by the time the engine has booted and this socket is up,
   *  some of it is already gone. Null on a server too old to say. */
  confirmStart?: (deadlineMs: number | null) => Promise<boolean>;
};

/** Reset the engine and ask once more, for a seat whose engine just answered
 *  with a move that does not exist in this position. Bounded by a fixed think
 *  time AND a hard wall-clock cap: recovery must not eat the clock it is trying
 *  to save, and an engine that has stopped answering must not hold the seat for
 *  the 120s the normal search watchdog allows. Null if it fails again. */
async function retryAfterResync(
  engine: BrowserEngine,
  replay: Replay,
  movetimeMs: number,
): Promise<string | null> {
  try {
    await engine.resync();
    const again = await Promise.race([
      engine.bestMove(replay.history, movetimeMs),
      new Promise<null>((r) => setTimeout(() => r(null), movetimeMs + 2000)),
    ]);
    return again ? toStandardUci(replay.pos, again) : null;
  } catch {
    return null;
  }
}

/** A book move for `pos` — the user's uploaded Polyglot book first, then the
 *  built-in mainline set — returning the first LEGAL of the two, so a
 *  bad/illegal user-book entry falls through to the built-in book (and then to
 *  the engine) rather than suppressing it. Answers in standard UCI.
 *
 *  `history` must already be standard UCI: the built-in book is keyed by
 *  move-sequence PREFIX, so a history in the king-takes-rook notation would
 *  miss every entry from the castle onwards. */
function legalBookMove(pos: Chess, history: string[]): string | null {
  const maxPly = getBrowserBotConfig().bookMaxPly;
  const user = probeUserBook(pos, history.length, maxPly);
  const userStd = user ? toStandardUci(pos, user) : null;
  if (userStd) return userStd;
  const builtin = bookMove(history);
  return builtin ? toStandardUci(pos, builtin) : null;
}

/** Play one seat of a game in the browser, driving `engine`. Resolves when the
 *  game ends or the socket closes. `cancelled()` lets the caller tear it down. */
export function playSeat(
  gameId: string,
  token: string,
  engine: BrowserEngine,
  movetimeMs: number,
  handlers: PlayHandlers = {},
  cancelled: () => boolean = () => false,
): { promise: Promise<void>; close: () => void } {
  // Warm the uploaded-book cache; resolves long before the first your_turn.
  void ensureBookLoaded();

  const ws = new WebSocket(`${SERVER_WS}/ws/game/${gameId}?token=${token}`);
  let seq = 0;
  const send = (msg: Record<string, unknown>) => {
    seq += 1;
    ws.send(JSON.stringify({ v: 1, seq, ts_ms: 0, ...msg }));
  };

  const promise = new Promise<void>((resolve) => {
    ws.onopen = () => {
      send({
        type: "hello",
        token,
        client_version: "web",
        capabilities: { move_signing: false },
      });
    };
    ws.onclose = () => resolve();
    ws.onerror = () => resolve();
    ws.onmessage = async (ev) => {
      let m: any;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      handlers.onEvent?.(m);
      if (cancelled()) {
        ws.close();
        return;
      }
      switch (m.type) {
        case "welcome": {
          const deadlineMs =
            typeof m.start_deadline_ms === "number" ? m.start_deadline_ms : null;
          if (handlers.confirmStart && !(await handlers.confirmStart(deadlineMs))) {
            // Declined. Deliberately stay attached instead of closing: the
            // server voids a game neither side started as a draw (refunding a
            // wagered stake), but hands the opponent a forfeit WIN if our seat
            // is gone. Sitting here costs a minute and keeps the money.
            return;
          }
          if (cancelled()) {
            ws.close();
            return;
          }
          send({ type: "ready", game_id: gameId });
          break;
        }
        case "your_turn": {
          try {
            // Replay the server's history ourselves. Two things come out of it:
            // the position (for the book), and the history rewritten to standard
            // UCI. The server accepts castling in EITHER notation from any
            // client, so a peer's "e1h1" can reach us — and a UCI engine in
            // standard mode silently truncates its position at that move and
            // plays the rest of the game a ply behind (see lib/uci.ts).
            const replay = replayHistory(m.moves_uci ?? []);
            const history: string[] = replay?.history ?? m.moves_uci ?? [];
            // Opening book first: play known lines instantly instead of burning
            // clock on move 1. Falls through to the engine once out of book.
            const booked = replay ? legalBookMove(replay.pos, history) : null;
            // Play to the authoritative clock when the server provides one, so
            // the time control is real (the engine self-allocates and can
            // flag). Fall back to a fixed think time if no clock is present.
            const c = m.clock;
            const played =
              booked ??
              (c
                ? await engine.bestMoveWithClock(
                    history,
                    c.white_ms,
                    c.black_ms,
                    c.increment_ms ?? 0,
                  )
                : await engine.bestMove(history, movetimeMs));
            if (cancelled()) {
              ws.close();
              return;
            }
            // Last gate before the wire. An illegal move is not survivable —
            // the server rejects it and will not re-prompt this ply — so an
            // out-of-sync engine gets one reset and one more try, and failing
            // that the seat spends a legal move rather than the whole game:
            // resigning is a certain loss (wagered, a certain loss of the
            // stake) in a position that is usually perfectly fine.
            let uci = played;
            if (replay) {
              let std = toStandardUci(replay.pos, played);
              if (!std) {
                console.warn(
                  `[openchess] engine answered ${played} at ply ${m.ply}, which ` +
                    `is not legal here — resetting it and asking again`,
                );
                std = await retryAfterResync(engine, replay, movetimeMs);
                if (cancelled()) {
                  ws.close();
                  return;
                }
              }
              uci = std ?? anyLegalUci(replay.pos) ?? played;
            }
            send({
              type: "move",
              game_id: gameId,
              ply: m.ply,
              uci_move: uci,
              client_clock_ms: 0,
              sig: null,
            });
          } catch {
            // Engine failed/timed out — resign this seat rather than silently
            // stalling the game forever.
            send({ type: "resign", game_id: gameId });
            ws.close();
          }
          break;
        }
        case "move_rejected":
          // Our move was illegal/late — the engine is misbehaving; resign
          // instead of hanging (the server won't re-prompt this ply).
          send({ type: "resign", game_id: gameId });
          ws.close();
          break;
        case "game_over":
          ws.close();
          resolve();
          break;
      }
    };
  });

  return { promise, close: () => ws.close() };
}
