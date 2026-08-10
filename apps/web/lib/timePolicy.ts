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
/** Bounds on the per-move network reserve (see `moveOverheadMs`). */
export const MIN_MOVE_OVERHEAD_MS = 50;
export const MAX_MOVE_OVERHEAD_MS = 250;
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

/** Clock reserved per move for the round trip to the server, scaled to the time
 *  control. NOT a user setting — see below.
 *
 *  A flat reserve is not a flat cost. Stockfish's sudden-death manager takes
 *  `Move Overhead × (2 + movestogo)` off the clock BEFORE it allocates
 *  anything, and with no `movestogo` it assumes 50 — so a 250ms reserve holds
 *  back 13 SECONDS. That is 2% of a 10+0 clock and 22% of a 1+0 one, which is
 *  why a bullet seat fell off a cliff that a rapid seat never reached: below
 *  13s of clock there was nothing left to allocate and it answered in ~2ms.
 *  Measured on the shipped search, at 15s left: 100ms of thinking at a 250ms
 *  reserve, 517ms at 100ms. Same engine, same position.
 *
 *  Dividing by 1000 pins the total reserve at ~5.2% of the starting clock
 *  whatever the time control, which pushes the collapse down into the range
 *  where instant moves are the right answer anyway.
 *
 *  It stays out of the settings panel deliberately: it is a property of the
 *  network between us and the referee, not a matter of taste, and setting it
 *  too low doesn't feel like a preference — the seat flags and the player just
 *  sees a loss. `MIN_MOVE_OVERHEAD_MS` is the real risk knob here; the server
 *  forgives `LAG_ALLOWANCE_MS` (150ms) on top of whatever we reserve. */
export function moveOverheadMs(initialMs: number): number {
  // A missing or nonsensical clock is "we don't know yet", not "reserve
  // nothing": fall back to the most cautious value rather than the smallest.
  if (!Number.isFinite(initialMs) || initialMs <= 0) return MAX_MOVE_OVERHEAD_MS;
  return Math.round(
    clampNum(initialMs / 1000, MIN_MOVE_OVERHEAD_MS, MAX_MOVE_OVERHEAD_MS, MAX_MOVE_OVERHEAD_MS),
  );
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

/** Moves Stockfish assumes remain when the `go` carries no `movestogo`. A
 *  hardcoded horizon in its time manager, not a guess of ours. */
export const SUDDEN_DEATH_MOVESTOGO = 50;
/** How far above the engine's own dead point to stop delegating.
 *
 *  1 would hand over only where a delegated search is provably worthless; the
 *  band just above it is merely bad, and measurably worse than our own budget.
 *  At 2, with a 250ms reserve, we take over below 26s: measured, the engine
 *  allocates 209ms at 20s and 100ms at 15s there, where the budget below gives
 *  666ms and 500ms. Above the threshold the engine is better than we are and
 *  keeps the search extensions we cannot reproduce, so this is a floor on
 *  handing over, not an eagerness to. Provisional: the time-based bench arm is
 *  what should tune it. */
export const TAKEOVER_FACTOR = 2;

/** Clock below which the engine's own time manager stops being worth
 *  delegating to.
 *
 *  Derived, not guessed. Stockfish subtracts `Move Overhead × (2 + movestogo)`
 *  from the clock before allocating anything (see `moveOverheadMs`), so that
 *  product is exactly where its allocation reaches zero and it starts answering
 *  in ~2ms. `pace` states its own `movestogo`, which is why a lower one moves
 *  this threshold EARLIER — the same coupling that made "Pace, 15 moves" look
 *  like a taste setting while it was really editing a safety cliff. */
export function takeoverBelowMs(
  policy: TimePolicy,
  overheadMs: number,
  /** Overridable so `/bench/time` can sweep it — that is the only caller that
   *  should pass one. `0` means never take over, which is how the bench replays
   *  the pre-takeover behavior against the current one. */
  factor: number = TAKEOVER_FACTOR,
): number {
  const movestogo = policy.mode === "pace" ? policy.movestogo : SUDDEN_DEATH_MOVESTOGO;
  return overheadMs * (2 + movestogo) * factor;
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
    /** OUR remaining clock. `clock` carries both sides and this says which of
     *  them we are spending, which is what the takeover has to read. */
    remainingMs: number;
    /** The reserve currently set on the engine (`moveOverheadMs`). Required,
     *  not optional: the takeover point is derived from it, and a caller that
     *  forgot to pass it would silently get the old collapse back. */
    overheadMs: number;
    /** `/bench/time` only — see `takeoverBelowMs`. Left alone in the seat, so
     *  a game always uses the shipped factor. */
    takeoverFactor?: number;
  },
): GoPlan {
  const { clock, budgetMs: budget, remainingMs, overheadMs } = ctx;

  if (policy.mode === "nodes") return { cmd: `go nodes ${policy.nodes}`, hardStopMs: budget };
  if (policy.mode === "fixed" || policy.mode === "fraction") return { cmd: `go movetime ${budget}` };

  // engine / pace need a real clock; without one they degrade to a budget.
  if (!clock) return { cmd: `go movetime ${budget}` };

  // Low enough that the engine's own manager has (nearly) nothing left to
  // allocate: stop delegating and spend the budget ourselves. It has to be a
  // REPLACEMENT — a `movetime` alongside `wtime` is only ever a ceiling, so
  // appending one here would still leave a 2ms search (verified in
  // `pnpm test:time`).
  if (remainingMs <= takeoverBelowMs(policy, overheadMs, ctx.takeoverFactor)) {
    return { cmd: `go movetime ${budget}` };
  }

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
