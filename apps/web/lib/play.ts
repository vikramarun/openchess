// Browser bring-your-own-engine client: connects to the game server over the
// same WebSocket protocol the native client uses, and drives a BrowserEngine.

import { Chess } from "chessops/chess";
import { parseUci } from "chessops/util";

import { ensureBookLoaded, probeUserBook } from "./browserBot";
import { SERVER_WS } from "./config";
import { BrowserEngine } from "./engine";
import { bookMove } from "./openings";

export type PlayHandlers = {
  onEvent?: (msg: any) => void;
};

/** A book move for this history — the user's uploaded Polyglot book first,
 *  then the built-in mainline set — but only if it's actually legal in the
 *  reconstructed position, so a bad book can never send an illegal move (it
 *  just falls through to the engine). */
function legalBookMove(movesUci: string[]): string | null {
  const pos = Chess.default();
  for (const u of movesUci) {
    const m = parseUci(u);
    if (!m || !pos.isLegal(m)) return null;
    pos.play(m);
  }
  const candidate = probeUserBook(pos, movesUci.length) ?? bookMove(movesUci);
  if (!candidate) return null;
  const cm = parseUci(candidate);
  return cm && pos.isLegal(cm) ? candidate : null;
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
        case "welcome":
          send({ type: "ready", game_id: gameId });
          break;
        case "your_turn": {
          try {
            const history: string[] = m.moves_uci ?? [];
            // Opening book first: play known lines instantly instead of burning
            // clock on move 1. Falls through to the engine once out of book.
            const booked = legalBookMove(history);
            // Play to the authoritative clock when the server provides one, so
            // the time control is real (the engine self-allocates and can
            // flag). Fall back to a fixed think time if no clock is present.
            const c = m.clock;
            const uci =
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
