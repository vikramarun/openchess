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
  constructor(private answers: string[]) {}
  private next(history: string[]) {
    this.seenHistory.push([...history]);
    return this.answers.length > 1 ? this.answers.shift()! : this.answers[0];
  }
  async bestMoveWithClock(history: string[]) {
    return this.next(history);
  }
  /** The seat now builds its own `go` command from the configured time policy
   *  (lib/timePolicy.ts) and hands it over, so this is the method the move loop
   *  actually calls. `bestMove` stays because retryAfterResync still uses it. */
  async bestMoveWithPlan(history: string[]) {
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

  console.log(failed === 0 ? "\nall checks passed" : `\n${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
