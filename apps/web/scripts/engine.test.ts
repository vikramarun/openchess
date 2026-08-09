// How the engine wrapper routes `bestmove`, and the search scores beside it.
//
// The engine answers exactly one `bestmove` per `go`, in order. If those lines
// are broadcast to every waiter — as they were — then two searches that overlap
// both resolve from the FIRST one, and the second caller gets a move for the
// previous position: illegal, rejected by the server, and (before lib/uci.ts)
// resigned over. Searches overlap whenever a caller stops waiting for one, which
// is exactly what the desync-recovery path in lib/play.ts does.
//
// `onInfo` (which drives a playing seat's eval bar) rides the same overlap, so
// it needs the same routing: scores belong to the search that is actually
// running, and must stop reaching a caller whose search has ended.
export {};

import { BrowserEngine } from "../lib/engine";

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`,
  );
}

/** A worker that speaks just enough UCI to get through the handshake. */
class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeWorker.last = this;
  }
  postMessage(cmd: string) {
    this.sent.push(cmd);
    // Asynchronously, like a real worker: the code under test registers its
    // waiter after calling send(), and a synchronous reply would arrive first
    // and be missed — an artefact of the fake, not of the engine.
    if (cmd === "uci") queueMicrotask(() => this.emit("uciok"));
    else if (cmd === "isready") queueMicrotask(() => this.emit("readyok"));
  }
  terminate() {}
  emit(line: string) {
    this.onmessage?.({ data: line });
  }
}
(globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;

const settle = () => new Promise((r) => setTimeout(r, 0));

async function main() {
  const engine = new BrowserEngine();
  await engine.whenReady();
  const worker = FakeWorker.last!;

  // Two searches in flight: the first caller has walked away (its cap expired)
  // but the engine is still working on it, so both are outstanding.
  let first: string | undefined;
  let second: string | undefined;
  void engine.bestMove(["e2e4"], 100).then((u) => (first = u));
  await settle();
  void engine.bestMove(["e2e4", "e7e5"], 100).then((u) => (second = u));
  await settle();

  worker.emit("bestmove a2a3");
  await settle();
  check("the first bestmove answers the FIRST search", first, "a2a3");
  check("and does not answer the second", second, undefined);

  worker.emit("bestmove b2b3");
  await settle();
  check("the second bestmove answers the second search", second, "b2b3");

  // A later search must not inherit a queue slot from an abandoned one.
  let third: string | undefined;
  void engine.bestMove(["e2e4", "e7e5", "g1f3"], 100).then((u) => (third = u));
  await settle();
  worker.emit("bestmove c2c3");
  await settle();
  check("a fresh search gets its own answer", third, "c2c3");

  // --- search scores (onInfo), which a playing seat's eval bar reads ---

  // The scores of a search reach the caller that asked for that search.
  const seenA: number[] = [];
  const searchA = engine.bestMove(["d2d4"], 100, (i) => seenA.push(i.depth));
  await settle();
  worker.emit("info depth 5 score cp 20 pv d7d5");
  check("onInfo receives the search's scores", seenA, [5]);

  // A second search overlapping the first: the engine is still working on A, so
  // these scores are A's. Feeding them to B would put a number on B's bar for a
  // position B is not looking at — the score-shaped version of the crossed
  // bestmove above.
  const seenB: number[] = [];
  const searchB = engine.bestMove(["d2d4", "d7d5"], 100, (i) => seenB.push(i.depth));
  await settle();
  worker.emit("info depth 6 score cp 25 pv c2c4");
  check("scores go to the running search, not the queued one", seenA, [5, 6]);
  check("the queued search hears nothing yet", seenB, []);

  worker.emit("bestmove c2c4");
  await settle();
  check("the finished search's bestmove still resolves", await searchA, "c2c4");

  // A is done, so B is the running search now.
  worker.emit("info depth 7 score cp 30 pv g1f3");
  check("the next search picks up its own scores", seenB, [7]);
  check("and the finished one hears nothing more", seenA, [5, 6]);

  worker.emit("bestmove g1f3");
  await settle();
  check("second search resolves", await searchB, "g1f3");

  // Detached for good: a later search with no onInfo must not resurrect either.
  const searchC = engine.bestMove(["a2a3"], 100);
  await settle();
  worker.emit("info depth 9 score cp 5 pv a7a6");
  worker.emit("bestmove a7a6");
  await searchC;
  check("a finished search's listener is gone", [seenA, seenB], [[5, 6], [7]]);

  // stopSearch is just `stop` — the engine still answers with a bestmove, which
  // is what leaves the worker clean for the next `position`.
  engine.stopSearch();
  check("stopSearch sends stop", worker.sent[worker.sent.length - 1], "stop");

  // resync clears the engine's state and waits for it to settle.
  await engine.resync();
  check(
    "resync sends ucinewgame then isready",
    worker.sent.slice(-2),
    ["ucinewgame", "isready"],
  );

  engine.dispose();
  console.log(failed === 0 ? "\nall checks passed" : `\n${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
