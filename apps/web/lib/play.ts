// Browser bring-your-own-engine client: connects to the game server over the
// same WebSocket protocol the native client uses, and drives a BrowserEngine.

import { Chess } from "chessops/chess";
import { parseUci } from "chessops/util";

import {
  ensureBookLoaded,
  ensureRepertoireLoaded,
  getBrowserBotConfig,
  probeRepertoire,
  probeUserBook,
} from "./browserBot";
import { SERVER_WS } from "./config";
import { BrowserEngine } from "./engine";
import { bookMove } from "./openings";

export type PlayHandlers = {
  onEvent?: (msg: any) => void;
};

/** True if `uci` is legal in `pos`. */
function isLegalUci(pos: Chess, uci: string): boolean {
  const m = parseUci(uci);
  return !!m && pos.isLegal(m);
}

/** A book move for this history, in priority order:
 *
 *  1. the user's uploaded Polyglot book — the most explicit statement of intent;
 *  2. their selected repertoire (the built-in `.bin` books);
 *  3. the broad built-in mainline set.
 *
 *  Each falls through to the next only if it produced no LEGAL move, so a bad
 *  entry anywhere can never suppress the books below it — or the engine. The
 *  broad book last is deliberate: once an opponent leaves your repertoire you
 *  want to stay in *some* book rather than drop into a cold search that burns
 *  clock on move four. */
function legalBookMove(movesUci: string[]): string | null {
  const pos = Chess.default();
  for (const u of movesUci) {
    if (!isLegalUci(pos, u)) return null;
    pos.play(parseUci(u)!);
  }
  const cfg = getBrowserBotConfig();
  const maxPly = cfg.bookMaxPly;
  const ply = movesUci.length;

  const user = probeUserBook(pos, ply, maxPly);
  if (user && isLegalUci(pos, user)) return user;

  const rep = probeRepertoire(pos, ply, maxPly, cfg.repertoire.pick);
  if (rep && isLegalUci(pos, rep)) return rep;

  // The broad book honours maxPly too — it used to be exempt, which made the
  // "leave book after N plies" setting quietly untrue.
  if (ply >= maxPly) return null;
  const builtin = bookMove(movesUci);
  return builtin && isLegalUci(pos, builtin) ? builtin : null;
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
  // Warm both book caches; they resolve long before the first your_turn.
  void ensureBookLoaded();
  void ensureRepertoireLoaded();

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
