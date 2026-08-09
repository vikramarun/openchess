// The seat engine's failure paths. These are the reason the module exists —
// the lobby refuses to stake unless prewarming succeeds — so they are worth
// more coverage than the happy path.
//
// The bug this file was written for: `new BrowserEngine()` used to sit outside
// the try, so a synchronous Worker-constructor failure left a permanently
// rejected promise cached. Every later attempt returned it, meaning one
// transient failure stopped the player posting for the rest of the session
// while the UI told them to try again.
import {
  acquirePlayerEngine,
  prewarmPlayerEngine,
  releasePlayerEngine,
  resetPlayerEngine,
  setEngineFactory,
} from "../lib/playerEngine";

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
}

/** Stands in for BrowserEngine. `mode` decides how this instance fails. */
class FakeEngine {
  static built = 0;
  static disposed = 0;
  constructor(private mode: "ok" | "handshake") {
    FakeEngine.built++;
  }
  whenReady() {
    return this.mode === "ok"
      ? Promise.resolve()
      : Promise.reject(new Error("handshake failed"));
  }
  dispose() {
    FakeEngine.disposed++;
  }
}

const factory = (mode: "ok" | "handshake" | "construct") => () => {
  // The case that mattered: the constructor itself throwing, synchronously,
  // before any promise exists.
  if (mode === "construct") throw new Error("Worker construction failed");
  return new FakeEngine(mode) as unknown as import("../lib/engine").BrowserEngine;
};

const rejected = async (p: Promise<unknown>) => {
  try {
    await p;
    return false;
  } catch {
    return true;
  }
};

async function main() {
  // --- a synchronous constructor failure must not be cached ---------------
  {
    resetPlayerEngine();
    FakeEngine.built = 0;
    setEngineFactory(factory("construct"));
    check("a constructor throw rejects", await rejected(prewarmPlayerEngine()), true);
    check("…and again, still rejecting", await rejected(prewarmPlayerEngine()), true);

    // The real assertion: once the cause clears, the very next call succeeds.
    setEngineFactory(factory("ok"));
    let recovered = true;
    try {
      await prewarmPlayerEngine();
    } catch {
      recovered = false;
    }
    check("a repaired engine is used on the next attempt", recovered, true);
  }

  // --- an async handshake failure must not be cached either ---------------
  {
    resetPlayerEngine();
    FakeEngine.built = 0;
    FakeEngine.disposed = 0;
    setEngineFactory(factory("handshake"));
    check("a handshake failure rejects", await rejected(prewarmPlayerEngine()), true);
    check("the dead engine is disposed, not leaked", FakeEngine.disposed, 1);

    setEngineFactory(factory("ok"));
    let recovered = true;
    try {
      await prewarmPlayerEngine();
    } catch {
      recovered = false;
    }
    check("and recovery works after a handshake failure too", recovered, true);
  }

  // --- the happy path is warm, and shared -------------------------------
  {
    resetPlayerEngine();
    FakeEngine.built = 0;
    setEngineFactory(factory("ok"));
    const a = await prewarmPlayerEngine();
    const b = await acquirePlayerEngine();
    const c = await acquirePlayerEngine();
    check("prewarming builds exactly one engine", FakeEngine.built, 1);
    check("every caller gets the same warm instance", a === b && b === c, true);

    // Concurrent callers must not each build one.
    resetPlayerEngine();
    FakeEngine.built = 0;
    const many = await Promise.all([prewarmPlayerEngine(), prewarmPlayerEngine(), prewarmPlayerEngine()]);
    check("concurrent prewarms share one build", FakeEngine.built, 1);
    check("…and one instance", many[0] === many[1] && many[1] === many[2], true);
  }

  // --- refcounting: a release must not dispose an engine still in use ----
  {
    resetPlayerEngine();
    FakeEngine.built = 0;
    FakeEngine.disposed = 0;
    setEngineFactory(factory("ok"));
    await acquirePlayerEngine();
    await acquirePlayerEngine();
    releasePlayerEngine();
    check("one release with a seat still holding disposes nothing", FakeEngine.disposed, 0);
    releasePlayerEngine();
    // The last release only ARMS the idle timer; disposal is deferred so the
    // next game reuses the engine instead of re-downloading 7 MB.
    check("the last release does not dispose immediately either", FakeEngine.disposed, 0);
    check("and the engine is still handed out", (await acquirePlayerEngine()) !== null, true);
    releasePlayerEngine();
  }

  setEngineFactory();
  resetPlayerEngine();
  process.exit(failed === 0 ? 0 : 1);
}

void main();
