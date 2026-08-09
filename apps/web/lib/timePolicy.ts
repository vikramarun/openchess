// How the browser bot spends its clock.
//
// This is the best agency-per-Elo control in the whole feature: a bot that
// moves instantly is instantly recognizable to a spectator, and it costs almost
// no strength. Compare the style dials, where visible character has to be
// bought with centipawns.
//
// Everything here is pure, so scripts/time.test.ts can pin the safety rules
// without a worker or a socket. Those rules matter — a browser seat that
// overruns its clock in a wagered game loses real USDC, so every computed
// budget is clamped three ways before it reaches the engine.

/** Never hand the engine less than this; below it a search returns nothing useful. */
export const MIN_BUDGET_MS = 50;
/** Slack for postMessage + the move's trip back to the server. */
export const OVERHEAD_MS = 100;
/** No single move may spend more than this share of the remaining clock. */
export const MAX_CLOCK_FRACTION = 0.25;
/** Below this much clock, spend a tenth of it per move and nothing more. */
export const PANIC_MS = 5000;

export type TimeMode =
  /** Stockfish allocates from the real clock (today's behavior). */
  | "engine"
  /** Same, but with a constant `movestogo` — lower thinks longer per move. */
  | "pace"
  /** A flat think time per move. */
  | "fixed"
  /** remaining / divisor + increment * incFactor. */
  | "fraction"
  /** A fixed node count: identical strength on a phone and a desktop. */
  | "nodes";

/** One flat record rather than a discriminated union: `mode` selects which
 *  fields apply, and every field always has a valid value. That makes the
 *  localStorage blob trivial to clamp and the UI trivial to render — switching
 *  modes never loses the settings of the mode you switched away from. */
export type TimePolicy = {
  mode: TimeMode;
  /** `pace`: constant movestogo. Fixed, never counting down — as movestogo
   *  approaches 1 Stockfish assumes a new time control is coming and burns
   *  nearly everything it has left. */
  movestogo: number;
  /** `fixed`: ms per move. */
  fixedMs: number;
  /** `fraction`: divide the remaining clock by this. */
  divisor: number;
  /** `fraction`: how much of the increment to spend on top. */
  incFactor: number;
  /** `nodes`: nodes per move. */
  nodes: number;
};

export const DEFAULT_TIME_POLICY: TimePolicy = {
  mode: "engine",
  movestogo: 30,
  fixedMs: 500,
  divisor: 30,
  incFactor: 0.8,
  nodes: 200_000,
};

const RANGES = {
  movestogo: [2, 200],
  fixedMs: [50, 30_000],
  divisor: [5, 200],
  incFactor: [0, 1],
  nodes: [1_000, 20_000_000],
} as const;

const MODES: TimeMode[] = ["engine", "pace", "fixed", "fraction", "nodes"];

function clampNum(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

/** Validate a policy read from localStorage. Every field is clamped: this blob
 *  is user-editable and feeds the move loop, and a NaN budget would turn into
 *  a `go movetime NaN` that the engine simply never answers. */
export function normalizeTimePolicy(raw: unknown): TimePolicy {
  const r = (raw ?? {}) as Record<string, unknown>;
  const mode = MODES.includes(r.mode as TimeMode) ? (r.mode as TimeMode) : DEFAULT_TIME_POLICY.mode;
  return {
    mode,
    movestogo: Math.round(clampNum(r.movestogo, ...RANGES.movestogo, DEFAULT_TIME_POLICY.movestogo)),
    fixedMs: Math.round(clampNum(r.fixedMs, ...RANGES.fixedMs, DEFAULT_TIME_POLICY.fixedMs)),
    divisor: Math.round(clampNum(r.divisor, ...RANGES.divisor, DEFAULT_TIME_POLICY.divisor)),
    incFactor: clampNum(r.incFactor, ...RANGES.incFactor, DEFAULT_TIME_POLICY.incFactor),
    nodes: Math.round(clampNum(r.nodes, ...RANGES.nodes, DEFAULT_TIME_POLICY.nodes)),
  };
}

export type ClockCtx = {
  /** Our own remaining time, ms. */
  remainingMs: number;
  incrementMs: number;
  /** ms from now until the server's deadline for this move, if known. The
   *  server sends `deadline_server_ms` on every `your_turn` and the web client
   *  used to ignore it; it is the only authoritative wall we have. */
  deadlineInMs?: number;
};

/** Milliseconds this move may take. Pure.
 *
 *  The three clamps are the whole point and apply to every mode that computes
 *  its own budget: a quarter of the clock at most, a tenth of it once we are
 *  under PANIC_MS, and never past the server's deadline. */
export function budgetMs(policy: TimePolicy, ctx: ClockCtx): number {
  const { remainingMs, incrementMs, deadlineInMs } = ctx;

  let want: number;
  switch (policy.mode) {
    case "fixed":
      want = policy.fixedMs;
      break;
    case "fraction":
      want = remainingMs / policy.divisor + incrementMs * policy.incFactor;
      break;
    case "nodes":
      // `go nodes N` ignores the clock entirely, so this is purely the wall
      // that stops a slow device from flagging: it gets a shallower search
      // instead. Degradation, not failure.
      want = Math.min(remainingMs * 0.2, 4000);
      break;
    default:
      // engine / pace let Stockfish allocate; the value is only used when the
      // server sent no clock at all.
      want = Math.min(remainingMs / policy.divisor + incrementMs * policy.incFactor, 4000);
  }

  if (!Number.isFinite(want)) want = MIN_BUDGET_MS;
  want = Math.min(want, remainingMs * MAX_CLOCK_FRACTION);
  if (remainingMs < PANIC_MS) want = Math.min(want, remainingMs / 10);
  if (deadlineInMs !== undefined && Number.isFinite(deadlineInMs)) {
    want = Math.min(want, deadlineInMs - OVERHEAD_MS);
  }

  // Floor, then a hard ceiling that always wins: we must never hand over the
  // whole clock, even when the floor would ask us to.
  want = Math.max(MIN_BUDGET_MS, want);
  return Math.floor(Math.min(want, Math.max(1, remainingMs - OVERHEAD_MS)));
}

export type GoPlan = {
  /** The UCI `go …` command. */
  cmd: string;
  /** Wall-clock stop for commands that don't self-terminate (`go nodes`). */
  hardStopMs?: number;
};

/** Build the `go` command for this policy. Pure.
 *
 *  Note what is deliberately absent: we never scale the clock we report to the
 *  engine. Reporting less than we have "works" but reporting more is a flagging
 *  bug, and either way it breaks the panic heuristics Stockfish applies near
 *  zero. The budget is expressed as `movetime`/`nodes` instead. */
export function goCommand(
  policy: TimePolicy,
  ctx: {
    /** Server clock, or null for a clockless game. */
    clock: { whiteMs: number; blackMs: number; incMs: number } | null;
    budgetMs: number;
  },
): GoPlan {
  const { clock, budgetMs: budget } = ctx;

  if (policy.mode === "nodes") return { cmd: `go nodes ${policy.nodes}`, hardStopMs: budget };
  if (policy.mode === "fixed" || policy.mode === "fraction") return { cmd: `go movetime ${budget}` };

  // engine / pace need a real clock; without one they degrade to a budget.
  if (!clock) return { cmd: `go movetime ${budget}` };
  const w = Math.max(50, Math.floor(clock.whiteMs));
  const b = Math.max(50, Math.floor(clock.blackMs));
  const inc = Math.max(0, Math.floor(clock.incMs));
  const base = `go wtime ${w} btime ${b} winc ${inc} binc ${inc}`;
  return policy.mode === "pace" ? { cmd: `${base} movestogo ${policy.movestogo}` } : { cmd: base };
}

/** One-line description for the UI and for the engine label. */
export function timePolicyLabel(p: TimePolicy): string {
  switch (p.mode) {
    case "pace":
      return p.movestogo <= 20 ? "Deep thinker" : "Brisk";
    case "fixed":
      return p.fixedMs <= 300 ? "Blitzer" : `${(p.fixedMs / 1000).toFixed(1)}s/move`;
    case "fraction":
      return `1/${p.divisor} clock`;
    case "nodes":
      return `${Math.round(p.nodes / 1000)}k nodes`;
    default:
      return "";
  }
}
