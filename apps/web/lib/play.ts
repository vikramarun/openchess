// Browser bring-your-own-engine client: connects to the game server over the
// same WebSocket protocol the native client uses, and drives a BrowserEngine.

import { SERVER_WS } from "./config";
import { BrowserEngine } from "./engine";

export type PlayHandlers = {
  onEvent?: (msg: any) => void;
};

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
            // Play to the authoritative clock when the server provides one, so
            // the time control is real (the engine self-allocates and can
            // flag). Fall back to a fixed think time if no clock is present.
            const c = m.clock;
            const uci = c
              ? await engine.bestMoveWithClock(
                  m.moves_uci ?? [],
                  c.white_ms,
                  c.black_ms,
                  c.increment_ms ?? 0,
                )
              : await engine.bestMove(m.moves_uci ?? [], movetimeMs);
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
