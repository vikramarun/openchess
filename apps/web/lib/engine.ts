// In-browser UCI engine: Stockfish 18 (NNUE) compiled to WASM, run in a Web
// Worker on the USER's CPU. This is what makes "load an engine by default"
// free — the engine never touches our servers. The web page itself becomes a
// bring-your-own-engine client (see lib/play.ts), speaking the same protocol
// as the native client.
//
// Build: stockfish-18-lite-single (single-threaded, 7 MB) from the `stockfish`
// npm package (v18.0.x) — see public/ENGINE.md. Single-threaded avoids the
// SharedArrayBuffer/COOP+COEP headers a multi-threaded build would require.

/** Worker script served from public/; the sibling .wasm is located next to it. */
const ENGINE_URL = "/stockfish-18-lite-single.js";
/** Transposition-table size (MB). Modest fixed default — bigger helps slightly
 *  at longer time controls; two engines run at once on the self-play page. */
const HASH_MB = 64;
/** Clock reserved per move for the round trip to the server (ms). Matches the
 *  native client's default (crates/byo-client `DEFAULT_MOVE_OVERHEAD_MS`). */
const MOVE_OVERHEAD_MS = 250;

/** One `info` line from a search, as the engine reports it: the score is from
 *  the SIDE TO MOVE's perspective (UCI convention) — flip it for a white-relative
 *  eval (see lib/evalScore.ts). */
export type EngineInfo = {
  /** Centipawns, or null when the line reports a mate score. */
  cp: number | null;
  /** Moves to mate (signed: >0 = side to move mates), or null. */
  mate: number | null;
  depth: number;
  /** Principal variation in UCI. */
  pv: string[];
};

/** Parse a UCI `info` line into a score. Returns null for the lines that carry
 *  no usable score — currmove/nps chatter, and fail-high/low bounds, which are
 *  provisional and would make an eval bar jump around mid-search. */
export function parseInfoLine(line: string): EngineInfo | null {
  if (!line.startsWith("info ")) return null;
  if (line.includes(" lowerbound") || line.includes(" upperbound")) return null;
  const t = line.split(/\s+/);
  let depth = 0;
  let cp: number | null = null;
  let mate: number | null = null;
  let pv: string[] = [];
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case "depth":
        depth = Number(t[++i]) || 0;
        break;
      case "multipv":
        // MultiPV is pinned to 1 in the handshake; ignore anything else so a
        // future multi-line search can't feed a side line to the bar.
        if (Number(t[++i]) !== 1) return null;
        break;
      case "score":
        if (t[i + 1] === "cp") {
          const v = Number(t[i + 2]);
          if (!Number.isFinite(v)) return null;
          cp = v;
          mate = null;
          i += 2;
        } else if (t[i + 1] === "mate") {
          const v = Number(t[i + 2]);
          if (!Number.isFinite(v)) return null;
          mate = v;
          cp = null;
          i += 2;
        }
        break;
      case "pv":
        pv = t.slice(i + 1);
        i = t.length;
        break;
    }
  }
  if (cp === null && mate === null) return null;
  return { cp, mate, depth, pv };
}

export class BrowserEngine {
  private worker: Worker;
  private listeners: ((line: string) => void)[] = [];
  /** Waiters for `bestmove`, oldest first — one per outstanding `go`. */
  private bestmoveWaiters: ((uci: string) => void)[] = [];
  private ready: Promise<void>;
  /** Serializes analyse() searches on the single worker. */
  private analysisQueue: Promise<void> = Promise.resolve();
  /** Abandons the most recently started analysis, if any. */
  private cancelAnalysis: (() => void) | null = null;
  private disposed = false;
  public name = "Stockfish 18 (browser)";

  constructor() {
    // Origin-absolute path: the worker and its sibling .wasm both live at the
    // public root. If the app is ever served under a Next basePath, derive
    // this from that prefix (both files would 404 together otherwise).
    this.worker = new Worker(ENGINE_URL);
    this.worker.onmessage = (e: MessageEvent) => {
      const line: string =
        typeof e.data === "string" ? e.data : (e.data && e.data.data) || "";
      // A `bestmove` answers exactly ONE `go`, in order, so it goes to exactly
      // one waiter — the oldest. Fanning it out like every other line would let
      // an abandoned search answer for a live one: a caller that gave up
      // waiting leaves its search running, and its late `bestmove` would then
      // resolve the NEXT search too, with a move for the previous position.
      // Illegal, rejected by the server, and historically resigned over.
      const best = line.match(/^bestmove\s+(\S+)/);
      if (best) {
        this.bestmoveWaiters.shift()?.(best[1]);
        return;
      }
      for (const l of [...this.listeners]) l(line);
    };
    // If the worker script fails to load / instantiate, reject `ready` so the
    // UI can degrade gracefully instead of hanging on the handshake timeout.
    this.ready = new Promise<void>((resolve, reject) => {
      this.worker.onerror = () =>
        reject(new Error("Stockfish worker failed to load"));
      this.handshake().then(resolve).catch(reject);
    });
  }

  private send(cmd: string) {
    this.worker.postMessage(cmd);
  }

  private waitFor(pred: (l: string) => boolean, timeoutMs = 20000): Promise<void> {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        cleanup();
        reject(new Error("engine timeout"));
      }, timeoutMs);
      const fn = (line: string) => {
        if (pred(line)) {
          clearTimeout(to);
          cleanup();
          resolve();
        }
      };
      const cleanup = () => {
        this.listeners = this.listeners.filter((l) => l !== fn);
      };
      this.listeners.push(fn);
    });
  }

  private async handshake() {
    this.send("uci");
    // The first `uciok` waits on the one-time 7MB wasm download + compile, so
    // it needs a generous timeout — on slow/cold connections 20s isn't enough,
    // and a rejection here fails the whole game (a wagered seat would flag).
    // A genuine load failure is caught separately by worker.onerror, so a long
    // wait only affects the truly-slow case, where waiting beats failing.
    await this.waitFor((l) => l.includes("uciok"), 120_000);
    this.send("setoption name MultiPV value 1");
    this.send(`setoption name Hash value ${HASH_MB}`);
    // The server charges wall-clock from `your_turn` to the move landing, so a
    // seat pays for the websocket round trip and for whatever the browser was
    // doing between postMessage calls. Stockfish reserves 10ms by default —
    // fine against a local opponent, a steady leak against a remote referee.
    this.send(`setoption name Move Overhead value ${MOVE_OVERHEAD_MS}`);
    this.send("isready");
    await this.waitFor((l) => l.includes("readyok"));
  }

  /** Resolves once the engine has completed its UCI handshake. */
  whenReady() {
    return this.ready;
  }

  /** Drop the engine's accumulated search state (`ucinewgame` clears the hash
   *  and the position) and wait for it to settle. The recovery path for a seat
   *  whose engine has gone out of sync with the real game — a dropped command,
   *  a move it refused to parse — before deciding the engine is unusable.
   *
   *  Call it only with the worker idle: `ucinewgame` during a search is
   *  undefined behaviour in UCI. `stopSearch()` first if one may be running. */
  async resync(): Promise<void> {
    await this.ready;
    this.send("ucinewgame");
    this.send("isready");
    await this.waitFor((l) => l.includes("readyok"));
  }

  /** Set the position and `go …`, resolving with the engine's bestmove. */
  private async go(movesUci: string[], goCmd: string): Promise<string> {
    await this.ready;
    const pos = movesUci.length
      ? `position startpos moves ${movesUci.join(" ")}`
      : "position startpos";
    this.send(pos);
    const result = new Promise<string>((resolve, reject) => {
      const to = setTimeout(() => {
        // Drop our slot in the queue, or every later search would be answered
        // one bestmove late for the rest of the game.
        this.bestmoveWaiters = this.bestmoveWaiters.filter((w) => w !== fn);
        reject(new Error("bestmove timeout"));
      }, 120000);
      const fn = (uci: string) => {
        clearTimeout(to);
        resolve(uci);
      };
      this.bestmoveWaiters.push(fn);
    });
    this.send(goCmd);
    return result;
  }

  /** End the search in flight early. The engine answers with a `bestmove` as
   *  usual, so the pending `bestMove*` promise still resolves and the worker is
   *  left clean — which is the point: a caller that has stopped waiting for a
   *  search must not leave it running. */
  stopSearch() {
    this.send("stop");
  }

  /** Best move (UCI) for the given move history under a fixed think time. */
  async bestMove(movesUci: string[], movetimeMs: number): Promise<string> {
    return this.go(movesUci, `go movetime ${movetimeMs}`);
  }

  /** Best move (UCI) with the engine managing its own time from the clock —
   *  Stockfish reads the side-to-move's remaining time from the position and
   *  self-allocates, so the time control is real (and the engine can flag). */
  async bestMoveWithClock(
    movesUci: string[],
    whiteMs: number,
    blackMs: number,
    incMs: number,
  ): Promise<string> {
    const w = Math.max(50, Math.floor(whiteMs));
    const b = Math.max(50, Math.floor(blackMs));
    const inc = Math.max(0, Math.floor(incMs));
    return this.go(
      movesUci,
      `go wtime ${w} btime ${b} winc ${inc} binc ${inc}`,
    );
  }

  /** Analyse an arbitrary position, streaming every score the search reports so
   *  a UI can deepen its eval progressively. Used by the eval bar, which follows
   *  whatever position the viewer is looking at (live tip, or a scrubbed-back
   *  ply) — hence a FEN rather than a move list. A FEN carries no repetition
   *  history, so the eval can't see a threefold; that's the normal tradeoff for
   *  an eval bar and never affects the authoritative result (the server is the
   *  referee).
   *
   *  Searches are serialized on the worker: starting one supersedes any search
   *  still running (`stop` → its `bestmove` → the new `position`), because UCI
   *  commands must not interleave and the caller only ever wants the newest
   *  position. Returns a handle whose `stop()` abandons this analysis. */
  analyse(
    fen: string,
    opts: {
      onInfo: (info: EngineInfo) => void;
      /** Fires when the search ends (depth reached, capped, or stopped). */
      onDone?: () => void;
      /** Depth cap — reached first on quiet positions. */
      depth?: number;
      /** Wall-clock cap, so the bar keeps up with a live blitz game. */
      maxMs?: number;
    },
  ): { stop: () => void } {
    const { onInfo, onDone, depth = 18, maxMs = 2500 } = opts;

    // Supersede the previous analysis: without this a stale search would hold
    // the worker for its full budget before the new position even starts.
    this.cancelAnalysis?.();

    let cancelled = false;
    let stopSearch: (() => void) | null = null;
    const cancel = () => {
      cancelled = true;
      stopSearch?.();
    };
    this.cancelAnalysis = cancel;

    const run = async () => {
      if (cancelled || this.disposed) return;
      try {
        await this.ready;
      } catch {
        return; // engine failed to load — the caller degrades to no bar
      }
      // Re-check after the await: the engine may have been torn down while a
      // queued analysis was waiting, and a search must never outlive `quit`.
      if (cancelled || this.disposed) return;
      this.send(`position fen ${fen}`);
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(cap);
          clearTimeout(hardStop);
          this.listeners = this.listeners.filter((l) => l !== info);
          this.bestmoveWaiters = this.bestmoveWaiters.filter((w) => w !== done);
          stopSearch = null;
          resolve();
        };
        // This search is a `go` like any other, so it claims a slot in the
        // bestmove queue; the score lines still come through as ordinary
        // broadcast output.
        const done = () => finish();
        const info = (line: string) => {
          const parsed = parseInfoLine(line);
          if (parsed && !cancelled) onInfo(parsed);
        };
        // `stop` makes the engine emit `bestmove`, which is what actually
        // releases the worker for the next search.
        stopSearch = () => this.send("stop");
        const cap = setTimeout(() => this.send("stop"), maxMs);
        // Backstop: a worker that never answers must not wedge the queue.
        const hardStop = setTimeout(finish, maxMs + 15000);
        this.listeners.push(info);
        this.bestmoveWaiters.push(done);
        this.send(`go depth ${depth}`);
      });
      if (!cancelled) onDone?.();
      if (this.cancelAnalysis === cancel) this.cancelAnalysis = null;
    };

    // Chain onto the previous analysis (settled or not) so `position`/`go` pairs
    // never interleave on the worker.
    this.analysisQueue = this.analysisQueue.then(run, run);
    return { stop: cancel };
  }

  dispose() {
    this.disposed = true;
    this.cancelAnalysis?.();
    try {
      this.send("quit");
      this.worker.terminate();
    } catch {
      /* ignore */
    }
  }
}
