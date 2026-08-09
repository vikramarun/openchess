// The engine that plays your seats, kept warm.
//
// This exists because of a money bug. `SeatGame` used to construct a
// BrowserEngine *after* the game existed — i.e. after the stake was already
// escrowed — and then await a 7 MB download. A cold or failed load there means
// the seat never moves, the server's never-started reap forfeits the game, and
// the stake is gone. Nothing about that failure is the player's fault, and
// nothing about it was recoverable.
//
// So: warm the engine BEFORE any money is committed (`prewarmPlayerEngine`,
// called from the lobby's post/accept/queue buttons), and reuse that same warm
// instance for the seat. A refcount keeps it alive across the gap between
// prewarming and the game actually starting, and lets it go a minute after the
// last seat finishes.

import { BrowserEngine } from "./engine";

/** How a seat engine is constructed. Injectable so the failure paths below can
 *  be tested without a Worker — they are the whole reason this module exists,
 *  and they were wrong. */
let makeEngine: () => BrowserEngine = () => new BrowserEngine();

/** Test seam. Pass nothing to restore the real constructor. */
export function setEngineFactory(f?: () => BrowserEngine) {
  makeEngine = f ?? (() => new BrowserEngine());
}

let engine: BrowserEngine | null = null;
let loading: Promise<BrowserEngine> | null = null;
let refs = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** How long a warm engine survives with no seat using it. Long enough to cover
 *  posting an offer and waiting for someone to accept it. */
const IDLE_MS = 60_000;

function cancelIdle() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

/** Start (or reuse) the seat engine and resolve once it is ready to search.
 *
 *  Rejects if the engine cannot load — callers on the money path must treat
 *  that as "do not stake". */
export function prewarmPlayerEngine(): Promise<BrowserEngine> {
  cancelIdle();
  if (engine) return Promise.resolve(engine);
  if (loading) return loading;
  // The construction itself must be INSIDE the try. `new Worker(...)` throws
  // synchronously when the script can't be constructed at all (CSP, a bad URL,
  // out of memory), and with that line outside, `loading` kept a permanently
  // rejected promise that every later call returned — so one transient failure
  // meant the player could never post again without reloading the page, while
  // being told to "try again".
  const attempt = (async () => {
    let e: BrowserEngine | null = null;
    try {
      e = makeEngine();
      await e.whenReady();
      engine = e;
      return e;
    } catch (err) {
      e?.dispose();
      throw err;
    }
  })();
  loading = attempt;
  // Clear the in-flight slot however it settled, so the next call makes a
  // genuinely new attempt instead of replaying this one's outcome. This has to
  // run as a callback rather than a `finally` inside the async body: a
  // synchronous throw from the constructor settles that body BEFORE the
  // assignment above, and would leave the rejected promise cached.
  const clear = () => {
    if (loading === attempt) loading = null;
  };
  void attempt.then(clear, clear);
  return attempt;
}

/** Take the warm engine for a seat. Balance with `releasePlayerEngine`. */
export async function acquirePlayerEngine(): Promise<BrowserEngine> {
  const e = await prewarmPlayerEngine();
  refs += 1;
  cancelIdle();
  return e;
}

export function releasePlayerEngine() {
  refs = Math.max(0, refs - 1);
  if (refs > 0 || !engine) return;
  cancelIdle();
  idleTimer = setTimeout(() => {
    if (refs === 0 && engine) {
      engine.dispose();
      engine = null;
    }
    idleTimer = null;
  }, IDLE_MS);
}

/** A fresh engine on the default build, for when the seat's engine dies
 *  mid-game. Resigning a wagered game because a worker crashed is the worst
 *  possible outcome; playing on with a new one costs a little clock. */
export async function fallbackEngine(): Promise<BrowserEngine> {
  const e = new BrowserEngine();
  await e.whenReady();
  return e;
}

/** Test/debug seam. */
export function resetPlayerEngine() {
  cancelIdle();
  engine?.dispose();
  engine = null;
  loading = null;
  refs = 0;
}
