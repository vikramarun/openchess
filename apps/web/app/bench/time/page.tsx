"use client";

// Measurement harness for CLOCK MANAGEMENT — the arm BENCH.md said it was
// missing ("Fixed nodes, not fixed time. Time-based play adds clock-management
// effects this does not capture"). DEVELOPMENT ONLY, like its sibling.
//
// It answers one question: does taking the clock off the engine's own manager
// at low time gain or lose Elo, and where is the right handover point? Both
// sides run the SHIPPED code — `budgetMs`/`goCommand` from lib/timePolicy —
// so this measures what players get, not a reimplementation of it.
//
// Three things differ from /bench, and each of them would silently corrupt the
// result if copied across:
//
//  * CONCURRENCY 1, always. The node-based bench runs six engines at once
//    because a node is a node whatever else the CPU is doing. Here the unit of
//    measurement IS wall-clock, so a second engine on the same core changes the
//    thing being measured. This is the single easiest way to get numbers that
//    look fine and mean nothing.
//  * A simulated round trip (`?rtt=`). The reserve exists to pay for a network
//    this harness does not have, so without charging one, every arm that
//    reserved less would win by construction and the bench would recommend a
//    reserve of zero. See app/bench/time/clock.ts.
//  * Flagging is a real loss. It is most of what clock management is for, and
//    an arm that thinks beautifully and flags has lost.
//
// Shared with /bench: paired openings (each played twice with colors reversed),
// separate workers per side, deterministic sampling.

import { notFound } from "next/navigation";

import { Chess } from "chessops/chess";
import { parseUci } from "chessops/util";
import { useCallback, useRef, useState } from "react";

import {
  budgetMs,
  goCommand,
  moveOverheadMs,
  takeoverBelowMs,
  DEFAULT_TIME_POLICY,
  MAX_MOVE_OVERHEAD_MS,
} from "@/lib/timePolicy";
import { polyglotKey } from "@/lib/polyglot";
import { tcByLabel } from "@/lib/timeControls";

import { charge, newClock, remainingFor, type BenchClock, type Side } from "./clock";

const q =
  typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
const PLY_CAP = 300;
/** Stands in for the round trip the real server charges. */
const RTT_MS = Number(q.get("rtt") ?? 80);
// Resolved through the lobby's own table rather than parsed here. A label like
// "1+0" is MINUTES plus increment-seconds, and reading it as seconds is a silent
// disaster rather than an error: the run completes, prints "1+0", and measures a
// one-second game. The tell was the reserve — 50ms instead of the 60ms a real
// 1+0 scales to. An unknown label falls back to DEFAULT_TC.
const TC = tcByLabel(q.get("tc"));
const INITIAL_MS = TC.initial * 1000;
const INC_MS = TC.inc * 1000;

type Arm = {
  id: string;
  /** `null` = scale it to the time control, as shipped. */
  overhead: number | null;
  /** 0 = never take over (the pre-takeover behavior). */
  factor: number;
};

/** The baseline is what shipped BEFORE any of this: a flat 250ms reserve and
 *  full delegation. Every arm's Elo is therefore "versus the bot players had". */
const BASELINE: Arm = { id: "flat250/delegate", overhead: MAX_MOVE_OVERHEAD_MS, factor: 0 };
const ALL_ARMS: Record<string, Arm> = {
  scaled: { id: "scaled/delegate", overhead: null, factor: 0 },
  t1: { id: "scaled/takeover×1", overhead: null, factor: 1 },
  t2: { id: "scaled/takeover×2", overhead: null, factor: 2 },
  t4: { id: "scaled/takeover×4", overhead: null, factor: 4 },
};
const ARMS: Arm[] = (q.get("arms") ?? "scaled,t2")
  .split(",")
  .map((k) => ALL_ARMS[k.trim()])
  .filter(Boolean);

const overheadFor = (arm: Arm) => arm.overhead ?? moveOverheadMs(INITIAL_MS);

/** A worker speaking plain UCI, driven one search at a time. Unlike /bench's
 *  it reports how long the search actually took, which is the measurement. */
class Eng {
  private w: Worker;
  private listeners: ((l: string) => void)[] = [];
  ready: Promise<void>;

  constructor() {
    this.w = new Worker("/engines/sf18-lite-single-a8fbc05e/stockfish-18-lite-single.js");
    this.w.onmessage = (e) => {
      const l = typeof e.data === "string" ? e.data : (e.data && e.data.data) || "";
      for (const fn of [...this.listeners]) fn(l);
    };
    this.ready = this.until((l) => l.includes("uciok"), () => this.send("uci"), 120_000).then(() =>
      this.until((l) => l.includes("readyok"), () => {
        this.send("setoption name MultiPV value 1");
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
  setMoveOverhead(ms: number) {
    this.send(`setoption name Move Overhead value ${ms}`);
  }
  newGame() {
    this.send("ucinewgame");
  }
  /** Run a caller-built `go` and report the answer, the ENGINE's own elapsed
   *  time, and the main thread's wall time around it.
   *
   *  The clock is charged from `searchMs` — the `time` field the engine reports
   *  — rather than from wall time, and that is not a detail. A background tab is
   *  throttled, so message delivery to the main thread stretches; charging wall
   *  time would bill that throttling to the player's clock, push every arm
   *  further into the low-clock regime, and bias the very comparison being made.
   *  It fails silently: the run completes and the numbers look plausible.
   *  `wallMs` is kept so the gap is *reportable* — a run with a large
   *  overhead-per-move is a contaminated environment, and now you can see it
   *  instead of inferring it. The real-world cost that wall time was standing in
   *  for is modelled explicitly and reproducibly by `?rtt=`. */
  go(moves: string[], cmd: string): Promise<{ bestmove: string; searchMs: number; wallMs: number }> {
    return new Promise((res, rej) => {
      const t0 = performance.now();
      let searchMs = 0;
      const to = setTimeout(() => { cleanup(); rej(new Error("bestmove timeout")); }, 120_000);
      const fn = (l: string) => {
        // Every `info` line carries the search's elapsed ms; the last one before
        // `bestmove` is the search's own total.
        const t = l.match(/^info .*\btime (\d+)/);
        if (t) searchMs = Number(t[1]);
        const m = l.match(/^bestmove\s+(\S+)/);
        if (!m) return;
        clearTimeout(to);
        cleanup();
        res({ bestmove: m[1], searchMs, wallMs: performance.now() - t0 });
      };
      const cleanup = () => { this.listeners = this.listeners.filter((x) => x !== fn); };
      this.listeners.push(fn);
      this.send(moves.length ? `position startpos moves ${moves.join(" ")}` : "position startpos");
      this.send(cmd);
    });
  }
  dispose() {
    try { this.send("quit"); this.w.terminate(); } catch { /* ignore */ }
  }
}

type Result = "w" | "b" | "d";
export type GameStats = {
  result: Result;
  flagged: Side | null;
  plies: number;
  /** Mean main-thread overhead per move (wall minus the engine's own time).
   *  Small on an idle foreground tab; large means the run was throttled. It no
   *  longer corrupts the clock, but it still says how much to trust the run. */
  overheadPerMoveMs: number;
};

/** Play one clocked game from a fixed opening. */
async function playClockedGame(
  white: { eng: Eng; arm: Arm },
  black: { eng: Eng; arm: Arm },
  opening: string[],
): Promise<GameStats> {
  const pos = Chess.default();
  const moves: string[] = [];
  const seen = new Map<string, number>();
  let clock: BenchClock = newClock(INITIAL_MS, INC_MS);
  let overheadTotal = 0;
  let searches = 0;

  for (const s of [white, black]) {
    s.eng.newGame();
    // Per game, exactly as a seat does on `game_start`.
    s.eng.setMoveOverhead(overheadFor(s.arm));
  }

  // The opening is played free, off the clock, so both arms start their real
  // decisions from the same position with a full clock — the same reason the
  // seat's book moves cost 0.0s.
  for (const u of opening) {
    const m = parseUci(u);
    if (!m || !pos.isLegal(m)) break;
    pos.play(m);
    moves.push(u);
  }

  while (moves.length < PLY_CAP) {
    const outcome = pos.outcome();
    if (outcome) {
      return {
        result: outcome.winner === "white" ? "w" : outcome.winner === "black" ? "b" : "d",
        flagged: null,
        plies: moves.length,
        overheadPerMoveMs: searches ? overheadTotal / searches : 0,
      };
    }
    const draw = (): GameStats => ({
      result: "d",
      flagged: null,
      plies: moves.length,
      overheadPerMoveMs: searches ? overheadTotal / searches : 0,
    });
    if (pos.halfmoves >= 100) return draw();
    const key = String(polyglotKey(pos));
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n >= 3) return draw();

    const side: Side = pos.turn === "white" ? "white" : "black";
    const player = side === "white" ? white : black;
    const overheadMs = overheadFor(player.arm);
    const remainingMs = remainingFor(clock, side);

    // The shipped path, verbatim.
    const policy = DEFAULT_TIME_POLICY;
    const plan = goCommand(policy, {
      clock: { whiteMs: clock.whiteMs, blackMs: clock.blackMs, incMs: clock.incMs },
      budgetMs: budgetMs(policy, { remainingMs, incrementMs: clock.incMs }),
      remainingMs,
      overheadMs,
      takeoverFactor: player.arm.factor,
    });

    const { bestmove, searchMs, wallMs } = await player.eng.go(moves, plan.cmd);
    overheadTotal += Math.max(0, wallMs - searchMs);
    searches += 1;
    const charged = charge(clock, side, searchMs, RTT_MS);
    clock = charged.clock;
    if (charged.flagged) {
      // Losing on time is a real result and most of what this measures.
      return {
        result: side === "white" ? "b" : "w",
        flagged: side,
        plies: moves.length,
        overheadPerMoveMs: searches ? overheadTotal / searches : 0,
      };
    }

    const mv = parseUci(bestmove);
    if (!mv || !pos.isLegal(mv)) {
      return {
        result: side === "white" ? "b" : "w",
        flagged: null,
        plies: moves.length,
        overheadPerMoveMs: searches ? overheadTotal / searches : 0,
      };
    }
    pos.play(mv);
    moves.push(bestmove);
  }
  return {
    result: "d",
    flagged: null,
    plies: moves.length,
    overheadPerMoveMs: searches ? overheadTotal / searches : 0,
  };
}

function elo(score: number): number {
  const s = Math.min(0.999, Math.max(0.001, score));
  return -400 * Math.log10(1 / s - 1);
}

export default function TimeBench() {
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const stop = useRef(false);

  const run = useCallback(async (pairs: number) => {
    setRunning(true);
    stop.current = false;
    const say = (s: string) => setLog((L) => [...L, s]);

    const book: string[] = await (await fetch("/book.json")).json();
    let seed = 20260809;
    const rng = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const openings = Array.from({ length: pairs }, () =>
      book[Math.floor(rng() * book.length)].split(" ").slice(0, 8),
    );

    const scaled = moveOverheadMs(INITIAL_MS);
    say(
      `${TC.label} · rtt ${RTT_MS}ms · ${pairs} openings × 2 colors = ${pairs * 2} games/arm`,
    );
    say(
      `baseline ${BASELINE.id} (reserve ${MAX_MOVE_OVERHEAD_MS}ms, dead below ` +
        `${(takeoverBelowMs(DEFAULT_TIME_POLICY, MAX_MOVE_OVERHEAD_MS, 1) / 1000).toFixed(1)}s)`,
    );
    for (const arm of ARMS) {
      const oh = overheadFor(arm);
      say(
        `  arm ${arm.id}: reserve ${oh}ms, ` +
          (arm.factor === 0
            ? "always delegates"
            : `takes over below ${(takeoverBelowMs(DEFAULT_TIME_POLICY, oh, arm.factor) / 1000).toFixed(1)}s`),
      );
    }
    say(`scaled reserve for this time control: ${scaled}ms`);

    for (const arm of ARMS) {
      if (stop.current) break;
      const t0 = Date.now();
      let armScore = 0;
      let n = 0;
      const tally = { w: 0, d: 0, l: 0 };
      const flags = { arm: 0, base: 0 };
      let dropped = 0;
      let overheadSum = 0;

      // ONE pair of engines, ONE game at a time. See the header: concurrency
      // here would be measuring the scheduler, not the time policy.
      const a = new Eng();
      const b = new Eng();
      try {
        await Promise.all([a.ready, b.ready]);
      } catch (e) {
        say(`  !! engines failed to start: ${e instanceof Error ? e.message : String(e)}`);
        a.dispose();
        b.dispose();
        continue;
      }
      try {
        for (const op of openings) {
          if (stop.current) break;
          try {
            for (const armIsWhite of [true, false]) {
              if (stop.current) break;
              const w = armIsWhite ? { eng: a, arm } : { eng: a, arm: BASELINE };
              const bl = armIsWhite ? { eng: b, arm: BASELINE } : { eng: b, arm };
              const g = await playClockedGame(w, bl, op);
              overheadSum += g.overheadPerMoveMs;
              const armPoint = g.result === "d" ? 0.5 : (g.result === "w") === armIsWhite ? 1 : 0;
              armScore += armPoint;
              n += 1;
              if (armPoint === 1) tally.w++;
              else if (armPoint === 0.5) tally.d++;
              else tally.l++;
              if (g.flagged) {
                const armFlagged = (g.flagged === "white") === armIsWhite;
                if (armFlagged) flags.arm++;
                else flags.base++;
              }
              say(
                `  ${arm.id}: ${n} games, score ${(armScore / n).toFixed(3)}` +
                  ` (last: ${g.plies} plies${g.flagged ? `, ${g.flagged} flagged` : ""})`,
              );
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

      if (!n) {
        say(`${arm.id}: no games completed`);
        continue;
      }
      const s = armScore / n;
      const se = Math.sqrt((s * (1 - s)) / n);
      const d = elo(s);
      const lo = elo(Math.max(0.001, s - 1.96 * se));
      const hi = elo(Math.min(0.999, s + 1.96 * se));
      say(
        `${arm.id.padEnd(20)} n=${n}  +${tally.w} =${tally.d} -${tally.l}  score ${s.toFixed(3)}  ` +
          `Elo ${d >= 0 ? "+" : ""}${d.toFixed(0)} [${lo.toFixed(0)}, ${hi.toFixed(0)}]  ` +
          `flags ${flags.arm}/${flags.base} (arm/base)  ` +
          `overhead ${(overheadSum / n).toFixed(0)}ms/move  (${((Date.now() - t0) / 1000).toFixed(0)}s)` +
          (dropped ? `  [${dropped} openings dropped]` : ""),
      );
    }
    say("done");
    setRunning(false);
  }, []);

  if (process.env.NODE_ENV === "production") notFound();

  const pairs = Number(q.get("pairs")) || 6;
  return (
    <div className="container" style={{ padding: 20 }}>
      <h1>Clock-management bench</h1>
      <p className="muted">
        Each arm plays the pre-takeover bot (flat 250ms reserve, always delegates) at a real time
        control. One game at a time on purpose — wall-clock is the measurement.
      </p>
      <button className="primary" disabled={running} onClick={() => run(pairs)}>
        {running ? "Running…" : `Run (${pairs} openings/arm, ${TC.label})`}
      </button>{" "}
      <button className="ghost" onClick={() => { stop.current = true; }}>Stop</button>
      <pre id="bench-log" style={{ marginTop: 16, whiteSpace: "pre-wrap", fontSize: 12 }}>
        {log.join("\n")}
      </pre>
    </div>
  );
}
