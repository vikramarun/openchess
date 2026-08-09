// In-browser UCI engine: Stockfish 18 (NNUE) compiled to WASM, run in a Web
// Worker on the USER's CPU. This is what makes "load an engine by default"
// free — the engine never touches our servers. The web page itself becomes a
// bring-your-own-engine client (see lib/play.ts), speaking the same protocol
// as the native client.
//
// Build: stockfish-18-lite-single (single-threaded, 7 MB) from the `stockfish`
// npm package (v18.0.x) — see public/ENGINE.md. Single-threaded avoids the
// SharedArrayBuffer/COOP+COEP headers a multi-threaded build would require.

/** Worker script; the glue locates the sibling .wasm next to it.
 *
 *  The directory carries a content hash so the 7 MB binary can be served
 *  `immutable` (next.config.mjs). Next serves public/ with
 *  `max-age=0, must-revalidate` by default, which meant a round trip for the
 *  engine on every cold page. Re-hash the directory when the binary changes —
 *  that is the whole point of the name. */
const ENGINE_URL = "/engines/sf18-lite-single-a8fbc05e/stockfish-18-lite-single.js";
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

/** Everything a UCI `info` line can carry, unfiltered. */
export type InfoLine = {
  /** 1 when the token is absent, which is how a MultiPV-1 search reports. */
  multipv: number;
  cp: number | null;
  mate: number | null;
  depth: number;
  pv: string[];
  /** Fail-high/low marker. These are inequalities (`v >= beta`), not values. */
  bound: "lower" | "upper" | null;
  /** Win/draw/loss permille, when UCI_ShowWDL is on. */
  wdl: [number, number, number] | null;
};

/** Parse an `info` line with no filtering. Returns null only for lines that
 *  carry no score at all — currmove/nps chatter, `bestmove`, non-info lines. */
export function parseUciInfo(line: string): InfoLine | null {
  if (!line.startsWith("info ")) return null;
  const t = line.split(/\s+/);
  let depth = 0;
  let multipv = 1;
  let cp: number | null = null;
  let mate: number | null = null;
  let pv: string[] = [];
  let bound: "lower" | "upper" | null = null;
  let wdl: [number, number, number] | null = null;
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case "depth":
        depth = Number(t[++i]) || 0;
        break;
      case "multipv": {
        const v = Number(t[++i]);
        multipv = Number.isFinite(v) ? v : 1;
        break;
      }
      case "lowerbound":
        bound = "lower";
        break;
      case "upperbound":
        bound = "upper";
        break;
      case "wdl": {
        const w = Number(t[i + 1]);
        const d = Number(t[i + 2]);
        const l = Number(t[i + 3]);
        if ([w, d, l].every(Number.isFinite)) {
          wdl = [w, d, l];
          i += 3;
        }
        break;
      }
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
  return { multipv, cp, mate, depth, pv, bound, wdl };
}

/** The eval bar's score, or null.
 *
 *  A filter over `parseUciInfo` rather than its own tokenizer, so the two can't
 *  drift. The two rejections it adds are load-bearing and pinned by
 *  scripts/eval.test.ts: side PVs (a MultiPV search must never feed a side line
 *  to the bar) and fail-high/low bounds (provisional, and they would make the
 *  bar jump around mid-search). The returned object's KEY ORDER is also pinned
 *  there — that test compares with JSON.stringify. */
export function parseInfoLine(line: string): EngineInfo | null {
  const i = parseUciInfo(line);
  if (!i || i.multipv !== 1 || i.bound !== null) return null;
  return { cp: i.cp, mate: i.mate, depth: i.depth, pv: i.pv };
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

  /** Set the position and `go …`, resolving with the engine's bestmove.
   *
   *  `onInfo` streams the scores of that same search. A seat that is playing is
   *  already evaluating the live position on every one of its turns, so a UI can
   *  drive an eval bar off this for free — no second worker competing with the
   *  engine whose move quality is on the line. */
  private async go(
    movesUci: string[],
    goCmd: string,
    onInfo?: (info: EngineInfo) => void,
  ): Promise<string> {
    await this.ready;
    const pos = movesUci.length
      ? `position startpos moves ${movesUci.join(" ")}`
      : "position startpos";
    this.send(pos);
    const result = new Promise<string>((resolve, reject) => {
      // `bestmove` is dispatched to a single waiter, so the score lines are read
      // off the ordinary fan-out listeners instead — for exactly as long as this
      // search runs. Leaving it attached would feed the caller the NEXT search's
      // scores, which for a seat means a bar describing a position the viewer
      // isn't looking at.
      //
      // The fan-out needs the same guard `bestmove` gets, for the same reason:
      // when a caller walks away from a search the engine is still running, two
      // searches are outstanding at once, and the scores arriving belong to the
      // OLDER one. The engine works the queue in order, so a search reports only
      // while it is at the head of it.
      const infoFn = onInfo
        ? (line: string) => {
            if (this.bestmoveWaiters[0] !== fn) return;
            const info = parseInfoLine(line);
            if (info) onInfo(info);
          }
        : null;
      const cleanup = () => {
        if (infoFn) this.listeners = this.listeners.filter((l) => l !== infoFn);
      };
      if (infoFn) this.listeners.push(infoFn);
      const to = setTimeout(() => {
        // Drop our slot in the queue, or every later search would be answered
        // one bestmove late for the rest of the game.
        this.bestmoveWaiters = this.bestmoveWaiters.filter((w) => w !== fn);
        cleanup();
        reject(new Error("bestmove timeout"));
      }, 120000);
      const fn = (uci: string) => {
        clearTimeout(to);
        cleanup();
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

  /** Best move (UCI) for a caller-built `go` command — the seam the time policy
   *  drives (lib/timePolicy.ts builds the command, this runs it).
   *
   *  `hardStopMs` stops a search that does not self-terminate. `go nodes N` is
   *  the case that needs it: hardware-independent by design, which also means a
   *  slow device would happily search past its flag. */
  async bestMoveWithPlan(
    movesUci: string[],
    plan: { cmd: string; hardStopMs?: number },
    onInfo?: (info: EngineInfo) => void,
  ): Promise<string> {
    if (plan.hardStopMs === undefined || plan.hardStopMs <= 0) {
      return this.go(movesUci, plan.cmd, onInfo);
    }
    const wall = setTimeout(() => this.stopSearch(), plan.hardStopMs);
    try {
      return await this.go(movesUci, plan.cmd, onInfo);
    } finally {
      clearTimeout(wall);
    }
  }

  /** Best move (UCI) for the given move history under a fixed think time. */
  async bestMove(
    movesUci: string[],
    movetimeMs: number,
    onInfo?: (info: EngineInfo) => void,
  ): Promise<string> {
    return this.go(movesUci, `go movetime ${movetimeMs}`, onInfo);
  }

  /** Best move (UCI) with the engine managing its own time from the clock —
   *  Stockfish reads the side-to-move's remaining time from the position and
   *  self-allocates, so the time control is real (and the engine can flag). */
  async bestMoveWithClock(
    movesUci: string[],
    whiteMs: number,
    blackMs: number,
    incMs: number,
    onInfo?: (info: EngineInfo) => void,
  ): Promise<string> {
    const w = Math.max(50, Math.floor(whiteMs));
    const b = Math.max(50, Math.floor(blackMs));
    const inc = Math.max(0, Math.floor(incMs));
    return this.go(
      movesUci,
      `go wtime ${w} btime ${b} winc ${inc} binc ${inc}`,
      onInfo,
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
