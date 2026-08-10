// What a seat puts on the wire in answer to `your_turn`, and what it feeds its
// engine to get there.
//
// Both directions matter, and both have bitten:
//
//   IN  — the server accepts castling as king-takes-rook ("e1h1") from any
//         client, so that spelling can reach us in `moves_uci`. A UCI engine in
//         standard mode does not accept it and does not say so: it truncates
//         its position there and plays the rest of the game a ply behind, so
//         every move it returns is illegal. The history must be normalized
//         before it reaches the engine.
//   OUT — a move the server rejects is unrecoverable (it will not re-prompt the
//         ply), and the seat used to answer that by resigning. In a level
//         position, with a wager on it. Nothing illegal may leave this file.

// Browser globals must exist before the module under test is imported. No
// `window`: that keeps `ensureBookLoaded` on its server-side early return
// instead of reaching for indexedDB, and leaves the built-in book at its
// curated lines (the histories below deliberately leave those).
// `export {}` makes this file a MODULE, so its helpers don't collide with the
// identically-named ones in the sibling test scripts.
export {};

import { Chess } from "chessops/chess";

import { replayHistory, toStandardUci, anyLegalUci } from "../lib/uci";
import { FakeSocket, install } from "./fakeSocket";

install();

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`,
  );
}
function checkThat(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

/** A stub engine that answers with a scripted sequence of moves. Records the
 *  history it was handed, which is the whole point of half these tests. */
class StubEngine {
  seenHistory: string[][] = [];
  resyncs = 0;
  /** Every reserve the seat has set, in order. */
  overheads: number[] = [];
  /** What the seat asked of the engine, in order — the reserve has to be set
   *  before the first search, and counting the two separately can't tell. */
  calls: string[] = [];
  /** Every `go` command the seat built, in order. */
  plans: string[] = [];
  constructor(
    private answers: string[],
    /** Ticks to stall inside `setMoveOverhead`, standing in for the real
     *  engine's `await this.ready`. Without a stall the option lands in the
     *  first microtask and no ordering bug can be observed. */
    private setupTicks = 0,
  ) {}
  async setMoveOverhead(ms: number) {
    for (let i = 0; i < this.setupTicks; i++) await new Promise((r) => setTimeout(r, 0));
    this.overheads.push(ms);
    this.calls.push("overhead");
  }
  private next(history: string[]) {
    this.seenHistory.push([...history]);
    this.calls.push("search");
    return this.answers.length > 1 ? this.answers.shift()! : this.answers[0];
  }
  async bestMoveWithClock(history: string[]) {
    return this.next(history);
  }
  /** The seat now builds its own `go` command from the configured time policy
   *  (lib/timePolicy.ts) and hands it over, so this is the method the move loop
   *  actually calls. `bestMove` stays because retryAfterResync still uses it. */
  async bestMoveWithPlan(history: string[], plan?: { cmd: string }) {
    if (plan) this.plans.push(plan.cmd);
    return this.next(history);
  }
  async bestMove(history: string[]) {
    return this.next(history);
  }
  async resync() {
    this.resyncs++;
  }
  stopSearch() {}
}

// 1.e4 e5 2.Nf3 Nc6 3.Bc4 Nf6 4.O-O — off the curated book at 3...Nf6, and the
// castle is written the way the old book wrote it. Black to move.
const HISTORY_KTR = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "e1h1"];
const HISTORY_STD = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "e1g1"];

type PlaySeat = typeof import("../lib/play").playSeat;
let playSeat: PlaySeat;

/** Run one `your_turn` against a stub engine; hand back the socket + engine. */
async function oneTurn(answers: string[], history = HISTORY_KTR) {
  const engine = new StubEngine(answers);
  playSeat("game-1", "tok", engine as never, 400);
  const ws = FakeSocket.last!;
  ws.onopen?.();
  await ws.deliver({ type: "welcome" });
  await ws.deliver({
    type: "your_turn",
    ply: history.length,
    moves_uci: history,
    clock: { white_ms: 60_000, black_ms: 60_000, increment_ms: 0 },
  });
  return { ws, engine };
}

/** Play a game at a given time control, through `game_start`, and report what
 *  network reserve the engine was given.
 *
 *  `clockMs` defaults to the initial time — a fresh game — but can differ, which
 *  is what a RECONNECT looks like: the server resends `game_start` with the time
 *  that is LEFT. */
async function reserveFor(initialMs: number, clockMs = initialMs) {
  const engine = new StubEngine(["f8c5"]);
  playSeat("game-1", "tok", engine as never, 400);
  const ws = FakeSocket.last!;
  ws.onopen?.();
  await ws.deliver({ type: "welcome" });
  await ws.deliver({
    type: "game_start",
    time_control: { initial_ms: initialMs, increment_ms: 0 },
    clock: { white_ms: clockMs, black_ms: clockMs, increment_ms: 0 },
  });
  await ws.deliver({
    type: "your_turn",
    ply: HISTORY_KTR.length,
    moves_uci: HISTORY_KTR,
    clock: { white_ms: initialMs, black_ms: initialMs, increment_ms: 0 },
  });
  return engine;
}

/** The `go` this seat builds at a given time control with `remainingMs` on its
 *  own clock. HISTORY_KTR is 7 plies, so we are Black — put the low clock
 *  there, or the seat reads the healthy one and nothing is being tested. */
async function goAt(initialMs: number, remainingMs: number) {
  const engine = new StubEngine(["f8c5"]);
  playSeat("game-1", "tok", engine as never, 400);
  const ws = FakeSocket.last!;
  ws.onopen?.();
  await ws.deliver({ type: "welcome" });
  await ws.deliver({
    type: "game_start",
    clock: { white_ms: initialMs, black_ms: initialMs, increment_ms: 0 },
  });
  await ws.deliver({
    type: "your_turn",
    ply: HISTORY_KTR.length,
    moves_uci: HISTORY_KTR,
    clock: { white_ms: initialMs, black_ms: remainingMs, increment_ms: 0 },
  });
  return engine.plans[0] ?? "";
}

const movesSent = (ws: FakeSocket) =>
  ws.sent.filter((m) => m.type === "move").map((m) => m.uci_move);

/** The position the seat is actually being asked to move in. */
const position = (history: string[]) => replayHistory(history)!.pos;
const isLegal = (pos: Chess, uci: unknown) =>
  typeof uci === "string" && toStandardUci(pos, uci) !== null;

async function main() {
  ({ playSeat } = await import("../lib/play"));

  // --- IN: the engine must never see king-takes-rook ---------------------------
  {
    const { ws, engine } = await oneTurn(["f8c5"]);
    check(
      "the history reaches the engine as standard UCI",
      engine.seenHistory[0],
      HISTORY_STD,
    );
    check("and its move goes out unchanged", movesSent(ws), ["f8c5"]);
  }

  // --- OUT: our own move is normalized too -------------------------------------
  {
    // Same position from the other side, so that castling is the engine's move.
    const history = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6"];
    const { ws } = await oneTurn(["e1h1"], history);
    check("a king-takes-rook move from the engine is sent as e1g1", movesSent(ws), [
      "e1g1",
    ]);
  }

  // --- OUT: an illegal move is never sent, and never resigned over -------------
  {
    // "a1a8" is not a move in this position — the classic symptom of an engine
    // whose position has drifted from the real game.
    const { ws, engine } = await oneTurn(["a1a8"]);
    check("a desynced engine gets reset and asked again", engine.resyncs, 1);
    checkThat(
      "the seat still sends a LEGAL move",
      movesSent(ws).length === 1 && isLegal(position(HISTORY_KTR), movesSent(ws)[0]),
      `sent ${JSON.stringify(movesSent(ws))}`,
    );
    check(
      "and does not resign over its own engine's bug",
      ws.sent.map((m) => m.type).filter((t) => t === "resign"),
      [],
    );
  }

  // --- OUT: the retry is trusted when it recovers ------------------------------
  {
    const { ws, engine } = await oneTurn(["a1a8", "f8c5"]);
    check("a resync that fixes the engine is believed", movesSent(ws), ["f8c5"]);
    check("and costs exactly one reset", engine.resyncs, 1);
  }

  // --- the last-resort move must itself be legal -------------------------------
  {
    // White's king is boxed in by the queen on b3: the ONLY legal move is the a7
    // pawn promoting. Serialized without its piece ("a7a8") that move is
    // illegal, which would drop the seat straight back into the rejected-move
    // resign this fallback exists to prevent.
    const { parseFen } = await import("chessops/fen");
    const pos = Chess.fromSetup(parseFen("7k/P7/8/8/8/1q6/8/K7 w - - 0 1").unwrap()).unwrap();
    const uci = anyLegalUci(pos);
    check("the fallback promotes a pawn that reaches the back rank", uci, "a7a8q");
    checkThat("and the move it picks is legal", isLegal(pos, uci), `${uci}`);
  }
  {
    const pos = Chess.default();
    checkThat("the fallback finds a move in the start position", isLegal(pos, anyLegalUci(pos)));
  }

  // --- the network reserve reaches the engine, scaled to the game --------------
  // Stockfish withholds ~52x this number before allocating anything, so a value
  // left at the rapid default is a fifth of a bullet clock: the seat answered in
  // ~2ms below 13 seconds and threw away won games. The seat has to re-set it
  // per game, because the engine is prewarmed before the time control is known.
  {
    check("a 1+0 seat reserves 60ms", (await reserveFor(60_000)).overheads, [60]);
    check("a 10+0 seat keeps the cap", (await reserveFor(600_000)).overheads, [250]);

    // A RECONNECT resends `game_start` with the time LEFT, not the time
    // control. Reading the clock there gave a seat rejoining a 10+0 game at 12s
    // a 50ms reserve — the floor — which halves its network tolerance and drags
    // the handover point from 26s down to 5.2s, in the one situation where the
    // connection is already suspect.
    check(
      "a seat rejoining a 10+0 game at 12s still reserves 250ms",
      (await reserveFor(600_000, 12_000)).overheads,
      [250],
    );
    check(
      "and one rejoining a 1+0 game at 8s still reserves 60ms",
      (await reserveFor(60_000, 8_000)).overheads,
      [60],
    );
  }
  {
    // A server too old to send `time_control` still gets the scaling from the
    // clock, which is correct on a fresh game. Losing that would put every web
    // seat back on a flat 250ms until the Fly server is deployed — the two do
    // not ship together.
    const engine = new StubEngine(["f8c5"]);
    playSeat("game-1", "tok", engine as never, 400);
    const ws = FakeSocket.last!;
    ws.onopen?.();
    await ws.deliver({ type: "welcome" });
    await ws.deliver({
      type: "game_start",
      clock: { white_ms: 60_000, black_ms: 60_000, increment_ms: 0 },
    });
    check("an older server still scales from the clock", engine.overheads, [60]);
  }
  {
    // And it must land BEFORE the first search, not after it. Both handlers are
    // async and the socket invokes them concurrently, so this is a real race:
    // losing it would budget move one at the old reserve.
    // A real socket does NOT wait for one handler before invoking the next, and
    // `setMoveOverhead` waits on the engine's handshake — so deliver both frames
    // without awaiting in between, which is the shape the barrier exists for.
    const engine = new StubEngine(["f8c5"], 2);
    playSeat("game-1", "tok", engine as never, 400);
    const ws = FakeSocket.last!;
    ws.onopen?.();
    await ws.deliver({ type: "welcome" });
    const clock = { white_ms: 60_000, black_ms: 60_000, increment_ms: 0 };
    const started = ws.onmessage!({ data: JSON.stringify({ type: "game_start", clock }) });
    const turned = ws.onmessage!({
      data: JSON.stringify({
        type: "your_turn",
        ply: HISTORY_KTR.length,
        moves_uci: HISTORY_KTR,
        clock,
      }),
    });
    await Promise.all([started, turned]);
    check("the reserve is set before the first search", engine.calls, ["overhead", "search"]);
  }

  // --- and the seat stops delegating once the clock is low --------------------
  // The unit tests pin the threshold; this pins that the seat is actually wired
  // to it, with the scaled reserve rather than a constant. A 10+0 reserve is
  // 250ms (dead at 13s, handover at 26s); a 1+0 reserve is 60ms (handover at
  // 6.2s), which is the whole reason bullet can keep delegating at 10s.
  {
    checkThat("a 10+0 seat delegates with a healthy clock", (await goAt(600_000, 400_000)).startsWith("go wtime"));
    checkThat("a 10+0 seat takes over at 20s", (await goAt(600_000, 20_000)).startsWith("go movetime"));
    checkThat("a 1+0 seat still delegates at 10s", (await goAt(60_000, 10_000)).startsWith("go wtime"));
    checkThat("a 1+0 seat takes over at 5s", (await goAt(60_000, 5_000)).startsWith("go movetime"));
  }

  console.log(failed === 0 ? "\nall checks passed" : `\n${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
