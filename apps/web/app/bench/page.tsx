"use client";

// Measurement harness for what a playing style costs — results and method in
// apps/web/BENCH.md. DEVELOPMENT ONLY: the route 404s in production, because
// it spawns six wasm engines and has no business being reachable in a money
// app.
//
// Measures what a style budget actually costs, so the dials can be labelled
// with real numbers instead of a model. Engine vs engine, entirely
// client-side: no server, no sockets, no clocks. Strength is fixed by NODE
// COUNT rather than time, which removes machine noise and makes a run
// reproducible.
//
// Design notes that matter for the numbers:
//  * Paired openings. Each sampled opening is played TWICE with colours
//    reversed, which cancels most of the opening's own bias — the single
//    biggest variance reducer available at small sample sizes.
//  * Separate workers per side, so the two players never share a hash table.
//  * Uniform random choice inside the window. A real personality picks by
//    taste, but taste is uncorrelated with strength, so random-in-window is
//    the honest isolation of what the WINDOW costs.

import { notFound } from "next/navigation";

import { Chess } from "chessops/chess";
import { parseUci } from "chessops/util";
import { useCallback, useRef, useState } from "react";

import { acceptableMoves, CandidateCollector } from "@/lib/candidates";
import { polyglotKey } from "@/lib/polyglot";

// Overridable from the query string so a run can be repeated at a different
// search budget: /bench?nodes=200000&pairs=16&arms=0,25,60
const q = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
const NODES = Number(q.get("nodes")) || 30_000;
const PLY_CAP = 200;
const CONCURRENCY = Number(q.get("conc")) || 3;

type Arm = {
  id: string;
  multiPv: number;
  epsilonCp: number;
  /** `twopass`: shortlist by style on a cheap search, then let the engine
   *  re-verify the shortlist with the rest of the budget via `searchmoves`. */
  mode?: "single" | "twopass";
  /** How many style-preferred moves go into the second pass. */
  shortlist?: number;
  /** Fraction of the node budget spent on pass 1. */
  split?: number;
};
const BASELINE: Arm = { id: "baseline", multiPv: 1, epsilonCp: 0 };
const ARM_EPS = (q.get("arms") ?? "0,15,25,40,60").split(",").map(Number);
const ARM_MPV = Number(q.get("mpv")) || 4;
const MODE = (q.get("mode") ?? "single") as "single" | "twopass";
const SHORTLIST = Number(q.get("k")) || 2;
const SPLIT = Number(q.get("split")) || 0.34;
const ARMS: Arm[] = ARM_EPS.map((e) => ({
  id: MODE === "twopass" ? `2pass \u03b5${e} k${SHORTLIST}` : `mpv${ARM_MPV} \u03b5${e}`,
  multiPv: ARM_MPV,
  epsilonCp: e,
  mode: MODE,
  shortlist: SHORTLIST,
  split: SPLIT,
}));

/** A worker speaking plain UCI, driven one search at a time. */
class Eng {
  private w: Worker;
  private listeners: ((l: string) => void)[] = [];
  private mpv = 1;
  ready: Promise<void>;

  constructor() {
    this.w = new Worker("/stockfish-18-lite-single.js");
    this.w.onmessage = (e) => {
      const l = typeof e.data === "string" ? e.data : (e.data && e.data.data) || "";
      for (const fn of [...this.listeners]) fn(l);
    };
    this.ready = this.until((l) => l.includes("uciok"), () => this.send("uci"), 120_000).then(() =>
      this.until((l) => l.includes("readyok"), () => {
        this.send("setoption name Hash value 16");
        this.send("isready");
      }),
    );
  }
  private send(c: string) {
    this.w.postMessage(c);
  }
  private until(pred: (l: string) => boolean, kick: () => void, ms = 120_000): Promise<void> {
    return new Promise((res, rej) => {
      const to = setTimeout(() => { cleanup(); rej(new Error("engine timeout")); }, ms);
      const fn = (l: string) => { if (pred(l)) { clearTimeout(to); cleanup(); res(); } };
      const cleanup = () => { this.listeners = this.listeners.filter((x) => x !== fn); };
      this.listeners.push(fn);
      kick();
    });
  }
  setMultiPv(n: number) {
    if (n === this.mpv) return;
    this.mpv = n;
    this.send(`setoption name MultiPV value ${n}`);
  }
  newGame() { this.send("ucinewgame"); }
  /** Search from a move history and return the engine's answer + candidates. */
  search(
    moves: string[],
    nodes: number = NODES,
    restrictTo?: string[],
  ): Promise<{ bestmove: string; collector: CandidateCollector }> {
    const collector = new CandidateCollector();
    return new Promise((res, rej) => {
      const to = setTimeout(() => { cleanup(); rej(new Error("bestmove timeout")); }, 30_000);
      const fn = (l: string) => {
        const m = l.match(/^bestmove\s+(\S+)/);
        if (m) { clearTimeout(to); cleanup(); res({ bestmove: m[1], collector }); return; }
        collector.feed(l);
      };
      const cleanup = () => { this.listeners = this.listeners.filter((x) => x !== fn); };
      this.listeners.push(fn);
      this.send(moves.length ? `position startpos moves ${moves.join(" ")}` : "position startpos");
      // `searchmoves` greedily consumes every remaining token, so it goes last.
      const tail = restrictTo?.length ? ` searchmoves ${restrictTo.join(" ")}` : "";
      this.send(`go nodes ${Math.max(1, Math.floor(nodes))}${tail}`);
    });
  }
  dispose() { try { this.send("quit"); this.w.terminate(); } catch { /* ignore */ } }
}

type Result = "w" | "b" | "d";

/** Play one game from a fixed opening. Returns which colour won. */
async function playGame(
  white: { eng: Eng; arm: Arm },
  black: { eng: Eng; arm: Arm },
  opening: string[],
  rng: () => number,
): Promise<Result> {
  const pos = Chess.default();
  const moves: string[] = [];
  const seen = new Map<string, number>();
  white.eng.newGame();
  black.eng.newGame();

  for (const u of opening) {
    const m = parseUci(u);
    if (!m || !pos.isLegal(m)) break;
    pos.play(m);
    moves.push(u);
  }

  while (moves.length < PLY_CAP) {
    const outcome = pos.outcome();
    if (outcome) return outcome.winner === "white" ? "w" : outcome.winner === "black" ? "b" : "d";
    if (pos.halfmoves >= 100) return "d";
    const key = String(polyglotKey(pos));
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n >= 3) return "d";

    const side = pos.turn === "white" ? white : black;
    const arm = side.arm;
    const twoPass = arm.mode === "twopass" && arm.epsilonCp > 0;
    const split = arm.split ?? 0.34;

    // Pass 1 finds the candidates. In two-pass mode it gets only part of the
    // budget, because the rest re-verifies the shortlist — the TOTAL node count
    // matches the baseline either way, so the comparison stays fair.
    side.eng.setMultiPv(arm.multiPv);
    const { bestmove, collector } = await side.eng.search(moves, twoPass ? NODES * split : NODES);
    const h = collector.harvest(bestmove);
    const pool = acceptableMoves(h, {
      epsilonCp: arm.epsilonCp,
      minDepth: 4,
      disableBeyondCp: 400,
    });

    let uci: string;
    if (!pool.length) {
      // Nothing to style. Spend the remaining budget on an ordinary search so
      // the arm never quietly thinks less than the baseline.
      uci = twoPass ? (await side.eng.search(moves, NODES * (1 - split))).bestmove : bestmove;
    } else if (!twoPass) {
      uci = pool[Math.floor(rng() * pool.length)].uci;
    } else {
      // Shortlist by "style" (random here — taste is uncorrelated with
      // strength), then let the engine choose among the shortlist with a
      // full-width search restricted to those moves. It reaches far greater
      // depth on two moves than it could on all of them.
      const picks = [...pool];
      const shortlist: string[] = [];
      const k = Math.min(arm.shortlist ?? 2, picks.length);
      for (let i = 0; i < k; i++) {
        shortlist.push(picks.splice(Math.floor(rng() * picks.length), 1)[0].uci);
      }
      side.eng.setMultiPv(1);
      const p2 = await side.eng.search(moves, NODES * (1 - split), shortlist);
      uci = shortlist.includes(p2.bestmove) ? p2.bestmove : shortlist[0];
    }
    const mv = parseUci(uci);
    if (!mv || !pos.isLegal(mv)) return pos.turn === "white" ? "b" : "w"; // illegal = loss
    pos.play(mv);
    moves.push(uci);
  }
  return "d";
}

function elo(score: number): number {
  const s = Math.min(0.999, Math.max(0.001, score));
  return -400 * Math.log10(1 / s - 1);
}

export default function Bench() {
  if (process.env.NODE_ENV === "production") notFound();
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const stop = useRef(false);

  const run = useCallback(async (pairs: number) => {
    setRunning(true);
    stop.current = false;
    const say = (s: string) => setLog((L) => [...L, s]);

    const bookRes = await fetch("/book.json");
    const book: string[] = await bookRes.json();
    // Deterministic sampling so a rerun measures the same openings.
    let seed = 20260809;
    const rng = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const openings = Array.from({ length: pairs }, () =>
      book[Math.floor(rng() * book.length)].split(" ").slice(0, 8),
    );

    say(`${NODES} nodes/move · ${pairs} openings × 2 colours = ${pairs * 2} games per arm`);

    for (const arm of ARMS) {
      if (stop.current) break;
      const t0 = Date.now();
      let armScore = 0;
      let n = 0;
      const tally = { w: 0, d: 0, l: 0 };

      // One pair of engines per concurrency slot, reused across every opening
      // that slot handles. Creating a fresh pair per opening meant compiling
      // the 7 MB wasm two dozen times per arm, and under that churn the
      // handshake started timing out — which is what stalled the first run.
      // `ucinewgame` already clears state between games.
      let dropped = 0;
      const queue = [...openings];
      await Promise.all(
        Array.from({ length: CONCURRENCY }, async (_, slot) => {
          // Stagger, so the slots do not all compile the wasm at the same moment.
          await new Promise((r) => setTimeout(r, slot * 1500));
          const a = new Eng();
          const b = new Eng();
          try {
            await Promise.all([a.ready, b.ready]);
          } catch (e) {
            say(`  !! slot failed to start: ${e instanceof Error ? e.message : String(e)}`);
            a.dispose();
            b.dispose();
            return;
          }
          try {
            while (queue.length && !stop.current) {
              const op = queue.shift();
              if (!op) break;
              // A single bad game is dropped, never allowed to reject and take
              // the whole measurement down with it.
              try {
                for (const armIsWhite of [true, false]) {
                  if (stop.current) return;
                  const w = armIsWhite ? { eng: a, arm } : { eng: a, arm: BASELINE };
                  const bl = armIsWhite ? { eng: b, arm: BASELINE } : { eng: b, arm };
                  const r = await playGame(w, bl, op, rng);
                  const armPoint = r === "d" ? 0.5 : (r === "w") === armIsWhite ? 1 : 0;
                  armScore += armPoint;
                  n += 1;
                  if (armPoint === 1) tally.w++;
                  else if (armPoint === 0.5) tally.d++;
                  else tally.l++;
                  if (n % 6 === 0) say(`  ${arm.id}: ${n} games, score ${(armScore / n).toFixed(3)}`);
                }
              } catch (e) {
                dropped += 1;
                say(`  !! game dropped: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
          } finally {
            a.dispose();
            b.dispose();
          }
        }),
      );

      const s = armScore / n;
      const se = Math.sqrt((s * (1 - s)) / n);
      const d = elo(s);
      const lo = elo(Math.max(0.001, s - 1.96 * se));
      const hi = elo(Math.min(0.999, s + 1.96 * se));
      say(
        `${arm.id.padEnd(10)} n=${n}  +${tally.w} =${tally.d} -${tally.l}  score ${s.toFixed(3)}  ` +
          `Elo ${d >= 0 ? "+" : ""}${d.toFixed(0)} [${lo.toFixed(0)}, ${hi.toFixed(0)}]  (${((Date.now() - t0) / 1000).toFixed(0)}s)` +
          (dropped ? `  [${dropped} openings dropped]` : ""),
      );
    }
    say("done");
    setRunning(false);
  }, []);

  return (
    <div className="container" style={{ padding: 20 }}>
      <h1>Style-budget bench</h1>
      <p className="muted">Each arm plays the baseline (MultiPV 1, no style budget) at fixed nodes.</p>
      <button className="primary" disabled={running} onClick={() => run(Number(q.get("pairs")) || 30)}>
        {running ? "Running…" : `Run (${Number(q.get("pairs")) || 30} openings/arm, ${NODES} nodes)`}
      </button>{" "}
      <button className="ghost" onClick={() => { stop.current = true; }}>Stop</button>
      <pre id="bench-log" style={{ marginTop: 16, whiteSpace: "pre-wrap", fontSize: 12 }}>
        {log.join("\n")}
      </pre>
    </div>
  );
}
