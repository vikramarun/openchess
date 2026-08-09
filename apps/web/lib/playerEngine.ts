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
  loading = (async () => {
    const e = new BrowserEngine();
    try {
      await e.whenReady();
    } catch (err) {
      // Don't cache a broken engine: a transient failure (a dropped download)
      // must not poison every later attempt in this tab.
      e.dispose();
      loading = null;
      throw err;
    }
    engine = e;
    loading = null;
    return e;
  })();
  return loading;
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
