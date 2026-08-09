// Browser bring-your-own-engine client: connects to the game server over the
// same WebSocket protocol the native client uses, and drives a BrowserEngine.

import { Chess } from "chessops/chess";

import {
  ensureBookLoaded,
  ensureRepertoireLoaded,
  getBrowserBotConfig,
  probeRepertoire,
  probeUserBook,
} from "./browserBot";
import { SERVER_WS } from "./config";
import { BrowserEngine, type EngineInfo } from "./engine";
import { bookMove } from "./openings";
import { budgetMs, goCommand } from "./timePolicy";
import { anyLegalUci, replayHistory, toStandardUci, type Replay } from "./uci";

export type PlayHandlers = {
  onEvent?: (msg: any) => void;
  /** Scores from THIS seat's own search, as it thinks about its move. `ply` is
   *  the position being searched (moves played so far), so the side to move —
   *  whose perspective the UCI score is from — is `ply % 2`. Lets the UI show an
   *  eval bar without a second engine: this search is happening anyway. Silent
   *  on a book move, since no search runs. */
  onEval?: (info: EngineInfo, ply: number) => void;
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
  /** Called at most once, when the seat's engine fails outright mid-game (a
   *  dead worker, not a bad move — that is handled by retryAfterResync).
   *  Returning a working engine lets the seat play on instead of resigning,
   *  which matters because a resignation forfeits a real stake. */
  onEngineFallback?: () => Promise<BrowserEngine>;
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
  let cap: ReturnType<typeof setTimeout> | undefined;
  try {
    await engine.resync();
    const search = engine.bestMove(replay.history, movetimeMs);
    // Cap the wait, then STOP the search rather than walking away from it: an
    // abandoned search keeps running, and its late bestmove would be waiting in
    // the queue when the next ply asks a question of its own.
    const again = await Promise.race([
      search,
      new Promise<null>((r) => {
        cap = setTimeout(() => {
          engine.stopSearch();
          r(null);
        }, movetimeMs + 2000);
      }),
    ]);
    return again ? toStandardUci(replay.pos, again) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(cap);
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
  const cfg = getBrowserBotConfig();
  const ply = history.length;

  // Two books, two depth settings, each governed by the control next to it:
  // `bookMaxPly` belongs to the uploaded .bin, `repertoire.maxPly` to the
  // built-in repertoire (and to the broad fallback book, which is the same
  // kind of thing). Sharing one of them here meant the repertoire picker's
  // "leave book after ply" changed the preview and nothing else.
  const user = probeUserBook(pos, ply, cfg.bookMaxPly);
  const userStd = user ? toStandardUci(pos, user) : null;
  if (userStd) return userStd;

  // The chosen repertoire. Normalized like everything else: a .bin stores
  // castling as king-takes-rook by spec, so decodeMove already converts it —
  // this is the belt to that braces.
  const repMaxPly = cfg.repertoire.maxPly;
  const rep = probeRepertoire(pos, ply, repMaxPly, cfg.repertoire.pick);
  const repStd = rep ? toStandardUci(pos, rep) : null;
  if (repStd) return repStd;

  // The broad book honours a depth limit too — it used to be exempt, which
  // made "leave book after N plies" quietly untrue for it.
  if (ply >= repMaxPly) return null;
  const builtin = bookMove(history);
  return builtin ? toStandardUci(pos, builtin) : null;
}

/** Play one seat of a game in the browser, driving `engine`. Resolves when the
 *  game ends or the socket closes. `cancelled()` lets the caller tear it down. */
export function playSeat(
  gameId: string,
  token: string,
  engineIn: BrowserEngine,
  movetimeMs: number,
  handlers: PlayHandlers = {},
  cancelled: () => boolean = () => false,
): { promise: Promise<void>; close: () => void } {
  // Reassignable: a dead engine is swapped for a replacement mid-game (below).
  let engine = engineIn;
  let onFallback = handlers.onEngineFallback ?? null;
  // Warm both book caches; they resolve long before the first your_turn.
  void ensureBookLoaded();
  void ensureRepertoireLoaded();

  const ws = new WebSocket(`${SERVER_WS}/ws/game/${gameId}?token=${token}`);
  let seq = 0;
  // `deadline_server_ms` is stamped in the SERVER's clock, so it needs an
  // offset to be usable. `welcome` carries `server_time_ms` for exactly that.
  // Estimated once and ignoring one-way latency, which is fine because the
  // deadline is only ever an upper bound with OVERHEAD_MS subtracted.
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
        case "welcome": {
          if (typeof m.server_time_ms === "number") serverOffsetMs = m.server_time_ms - Date.now();
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
            if (!replay) {
              // We could not replay the SERVER's own history, so this seat is
              // flying blind for the rest of the game: no book, and no way to
              // check its own move before sending it. Say so — the alternative
              // is losing on a rejected move with nothing in the log.
              console.warn(
                `[openchess] cannot replay the game history at ply ${m.ply}; ` +
                  `book and move validation are off for this seat`,
              );
            }
            // Opening book first: play known lines instantly instead of burning
            // clock on move 1. Falls through to the engine once out of book.
            const booked = replay ? legalBookMove(replay.pos, history) : null;
            // Play to the authoritative clock when the server provides one, so
            // the time control is real (the engine self-allocates and can
            // flag). Fall back to a fixed think time if no clock is present.
            // How the clock gets spent is configurable; the default `engine`
            // mode reproduces the previous `go wtime/btime` command byte for
            // byte. Every computed budget is clamped to a quarter of the clock,
            // a tenth once under five seconds, and the server's own deadline.
            const c = m.clock;
            const ourMs = history.length % 2 === 0 ? c?.white_ms : c?.black_ms;
            const deadlineInMs =
              typeof m.deadline_server_ms === "number"
                ? m.deadline_server_ms - serverOffsetMs - Date.now()
                : undefined;
            const policy = getBrowserBotConfig().time;
            const plan = goCommand(policy, {
              clock: c
                ? { whiteMs: c.white_ms, blackMs: c.black_ms, incMs: c.increment_ms ?? 0 }
                : null,
              budgetMs: budgetMs(policy, {
                remainingMs: ourMs ?? movetimeMs * 20,
                incrementMs: c?.increment_ms ?? 0,
                deadlineInMs,
              }),
            });
            // The seat's eval bar rides on the search it is already running for
            // its own move (#39), so it has to survive the time policy taking
            // over the `go` command — otherwise the bar silently goes blank on
            // every playing board.
            const onInfo = handlers.onEval
              ? (info: EngineInfo) => handlers.onEval!(info, history.length)
              : undefined;
            let played: string;
            if (booked) {
              played = booked;
            } else {
              try {
                played = await engine.bestMoveWithPlan(history, plan, onInfo);
              } catch (err) {
                // The engine itself died. Resigning here forfeits a real stake
                // over a crashed worker, so try once with a fresh default
                // engine first. Once only — a loop would burn the clock.
                if (!onFallback) throw err;
                const swap = onFallback;
                onFallback = null;
                engine = await swap();
                played = await engine.bestMoveWithPlan(history, plan, onInfo);
              }
            }
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
