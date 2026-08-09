// How the engine wrapper routes `bestmove`.
//
// The engine answers exactly one `bestmove` per `go`, in order. If those lines
// are broadcast to every waiter — as they were — then two searches that overlap
// both resolve from the FIRST one, and the second caller gets a move for the
// previous position: illegal, rejected by the server, and (before lib/uci.ts)
// resigned over. Searches overlap whenever a caller stops waiting for one, which
// is exactly what the desync-recovery path in lib/play.ts does.
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
