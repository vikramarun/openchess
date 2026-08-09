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
import { acceptableMoves } from "./candidates";
import { budgetMs, goCommand } from "./timePolicy";

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
  // The server stamps `deadline_server_ms` in ITS clock, so we need the offset
  // to use it. `welcome` carries `server_time_ms` for exactly this. Estimated
  // once and ignoring one-way latency, which is fine because the deadline is
  // only ever used as an upper bound with OVERHEAD_MS subtracted.
  let serverOffsetMs = 0;
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
          if (typeof m.server_time_ms === "number") serverOffsetMs = m.server_time_ms - Date.now();
          send({ type: "ready", game_id: gameId });
          break;
        case "your_turn": {
          try {
            const history: string[] = m.moves_uci ?? [];
            // Opening book first: play known lines instantly instead of burning
            // clock on move 1. Falls through to the engine once out of book.
            const booked = legalBookMove(history);
            // Otherwise the configured time policy decides how to spend the
            // clock. Default is `engine`, which reproduces the previous
            // `go wtime/btime` command byte for byte.
            const c = m.clock;
            const ourMs = history.length % 2 === 0 ? c?.white_ms : c?.black_ms;
            const deadlineInMs =
              typeof m.deadline_server_ms === "number"
                ? m.deadline_server_ms - serverOffsetMs - Date.now()
                : undefined;
            const policy = getBrowserBotConfig().time;
            const budget = budgetMs(policy, {
              remainingMs: ourMs ?? movetimeMs * 20,
              incrementMs: c?.increment_ms ?? 0,
              deadlineInMs,
            });
            const plan = goCommand(policy, {
              clock: c ? { whiteMs: c.white_ms, blackMs: c.black_ms, incMs: c.increment_ms ?? 0 } : null,
              budgetMs: budget,
            });
            // Always go through the MultiPV-aware search, even though nothing
            // styles the result yet. At MultiPV 1 with no style budget the
            // outcome is exactly the engine's own move, so this is a no-op
            // today — and it means the collector runs on real games now rather
            // than arriving untested alongside the style dials.
            const uci =
              booked ??
              (await (async () => {
                const r = await engine.search(history, plan, 1);
                const pool = acceptableMoves(r, { epsilonCp: 0, minDepth: 6, disableBeyondCp: 400 });
                return pool.length ? pool[0].uci : r.bestmove;
              })());
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
