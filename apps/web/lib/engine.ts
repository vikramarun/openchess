// In-browser UCI engine: Stockfish compiled to WASM, run in a Web Worker on the
// USER's CPU. This is what makes "load an engine by default" free — the engine
// never touches our servers. The web page itself becomes a bring-your-own-engine
// client (see lib/play.ts), speaking the same protocol as the native client.

export class BrowserEngine {
  private worker: Worker;
  private listeners: ((line: string) => void)[] = [];
  private ready: Promise<void>;
  public name = "Stockfish (WASM, in your browser)";

  constructor() {
    this.worker = new Worker("/stockfish.js");
    this.worker.onmessage = (e: MessageEvent) => {
      const line: string =
        typeof e.data === "string" ? e.data : (e.data && e.data.data) || "";
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
    await this.waitFor((l) => l.includes("uciok"));
    this.send("setoption name MultiPV value 1");
    this.send("isready");
    await this.waitFor((l) => l.includes("readyok"));
  }

  /** Resolves once the engine has completed its UCI handshake. */
  whenReady() {
    return this.ready;
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
        cleanup();
        reject(new Error("bestmove timeout"));
      }, 120000);
      const fn = (line: string) => {
        const m = line.match(/^bestmove\s+(\S+)/);
        if (m) {
          clearTimeout(to);
          cleanup();
          resolve(m[1]);
        }
      };
      const cleanup = () => {
        this.listeners = this.listeners.filter((l) => l !== fn);
      };
      this.listeners.push(fn);
    });
    this.send(goCmd);
    return result;
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

  dispose() {
    try {
      this.send("quit");
      this.worker.terminate();
    } catch {
      /* ignore */
    }
  }
}
