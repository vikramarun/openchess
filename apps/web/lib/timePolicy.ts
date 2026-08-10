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
/** What `engine` mode spends once it has taken over from the engine's own
 *  manager. Constants rather than the `tempo` fields on purpose — see the
 *  `default` branch of `budgetMs`. These are the numbers the takeover shipped
 *  with and the bench has yet to tune, so they move only with a measurement. */
export const ENGINE_TAKEOVER_DIVISOR = 30;
export const ENGINE_TAKEOVER_INC_FACTOR = 0.8;

export type TimeMode =
  /** Stockfish allocates from the real clock, with the seat taking over below
   *  the point its manager gives up (`takeoverBelowMs`). The default, and the
   *  only honest choice for an engine that isn't ours. */
  | "engine"
  /** A share of the remaining clock: remaining / divisor + increment × factor.
   *  The one taste axis, exposed as named presets (`TEMPO_PRESETS`). */
  | "tempo"
  /** A flat think time per move. */
  | "fixed"
  /** A fixed node count: identical strength on a phone and a desktop. */
  | "nodes";

/** One flat record rather than a discriminated union: `mode` selects which
 *  fields apply, and every field always has a valid value. That makes the
 *  localStorage blob trivial to clamp and the UI trivial to render — switching
 *  modes never loses the settings of the mode you switched away from. */
export type TimePolicy = {
  mode: TimeMode;
  /** `fixed`: ms per move. */
  fixedMs: number;
  /** `tempo`: divide the remaining clock by this. Lower thinks longer. */
  divisor: number;
  /** `tempo`: how much of the increment to spend on top. */
  incFactor: number;
  /** `nodes`: nodes per move. */
  nodes: number;
};

/** The tempo presets, as divisors. Named rather than numbered because this is
 *  the panel's only taste axis and nobody choosing a bot's character wants to
 *  reason about `incFactor`; the raw number stays reachable under Advanced.
 *
 *  `remaining / divisor` is geometric — it decays and never reaches zero — which
 *  is what keeps even the slowest preset from flagging on its own. What it can't
 *  do is know how many moves are left, so a low divisor front-loads. That is why
 *  the panel previews the actual first-move cost at every lobby time control
 *  instead of describing it. */
export const TEMPO_PRESETS = { blitzer: 90, steady: 45, deliberate: 22 } as const;
export type TempoName = keyof typeof TEMPO_PRESETS;

export const DEFAULT_TIME_POLICY: TimePolicy = {
  mode: "engine",
  fixedMs: 500,
  divisor: TEMPO_PRESETS.steady,
  incFactor: 0.8,
  nodes: 200_000,
};

const RANGES = {
  fixedMs: [50, 30_000],
  divisor: [5, 200],
  incFactor: [0, 1],
  nodes: [1_000, 20_000_000],
} as const;

const MODES: TimeMode[] = ["engine", "tempo", "fixed", "nodes"];

/** Modes that no longer exist, and what they become.
 *
 *  `pace` is gone because it was never a taste setting: its `movestogo` fed
 *  straight into `takeoverBelowMs`, so picking a "thoughtful" bot moved the
 *  low-clock cliff EARLIER (at the shipped reserve, from 26s to 8s at
 *  movestogo 30, and to 4.2s at 15). A knob labelled as character that edits a
 *  safety property is the coupling this whole change exists to remove, so it
 *  folds back into plain delegation rather than being relabelled.
 *
 *  `fraction` is the same arithmetic as `tempo` and simply keeps its divisor. */
const RETIRED_MODES: Record<string, TimeMode> = { pace: "engine", fraction: "tempo" };

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
  // A stored blob outlives the modes it was written with, so a retired one is
  // migrated rather than silently reset — a bot that quietly became something
  // else is worse than one that kept its settings.
  const stored = typeof r.mode === "string" ? (RETIRED_MODES[r.mode] ?? r.mode) : r.mode;
  const mode = MODES.includes(stored as TimeMode) ? (stored as TimeMode) : DEFAULT_TIME_POLICY.mode;
  return {
    mode,
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
    case "tempo":
      want = remainingMs / policy.divisor + incrementMs * policy.incFactor;
      break;
    case "nodes":
      // `go nodes N` ignores the clock entirely, so this is purely the wall
      // that stops a slow device from flagging: it gets a shallower search
      // instead. Degradation, not failure.
      want = Math.min(remainingMs * 0.2, 4000);
      break;
    default:
      // `engine` lets Stockfish allocate while it can. This value is what the
      // seat spends once it has TAKEN OVER (and when the server sent no clock
      // at all), so it is deliberately independent of `policy.divisor`:
      // that field belongs to `tempo`, and wiring the two together would mean
      // changing a tempo preset silently retuned the low-clock behavior of a
      // mode the user isn't even in. It nearly did — `divisor`'s default moved
      // from 30 to 45 when the presets landed, which would have cut every
      // takeover budget by a third with nothing to show for it.
      want = Math.min(
        remainingMs / ENGINE_TAKEOVER_DIVISOR + incrementMs * ENGINE_TAKEOVER_INC_FACTOR,
        4000,
      );
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
  // No mode states its own `movestogo` any more, which is the point: the
  // threshold is a property of the engine, not of anything the user picked.
  return overheadMs * (2 + SUDDEN_DEATH_MOVESTOGO) * factor;
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
  if (policy.mode === "fixed" || policy.mode === "tempo") return { cmd: `go movetime ${budget}` };

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
  return { cmd: base };
}

/** The preset a divisor corresponds to, or null for a hand-set one. */
export function tempoName(divisor: number): TempoName | null {
  const hit = (Object.keys(TEMPO_PRESETS) as TempoName[]).find(
    (k) => TEMPO_PRESETS[k] === divisor,
  );
  return hit ?? null;
}

const TEMPO_LABEL: Record<TempoName, string> = {
  blitzer: "Blitzer",
  steady: "Steady",
  deliberate: "Deliberate",
};

/** One-line description for the UI and for the engine label. */
export function timePolicyLabel(p: TimePolicy): string {
  switch (p.mode) {
    case "tempo": {
      const name = tempoName(p.divisor);
      return name ? TEMPO_LABEL[name] : `1/${p.divisor} clock`;
    }
    case "fixed":
      return p.fixedMs <= 300 ? "Blitzer" : `${(p.fixedMs / 1000).toFixed(1)}s/move`;
    case "nodes":
      return `${Math.round(p.nodes / 1000)}k nodes`;
    default:
      return "";
  }
}

/** What this policy will actually do at a given time control, for the panel.
 *
 *  Pure, and the honesty mechanism for the whole settings page: every previous
 *  version of this UI described `engine` mode in prose ("nothing to tune, and
 *  nothing to lose") precisely because it was the one mode whose behavior we
 *  could not compute — and that was the mode that collapsed to 2ms searches. Now
 *  that the handover point is derived, every mode has numbers, so every mode
 *  shows them.
 *
 *  `atFullClock` is the first move of the game; `atLowClock` is the case that
 *  was silently broken. `delegatesAtLowClock` says which of the two engines is
 *  choosing at that point, because "Stockfish decides" and "the seat decides"
 *  are genuinely different answers and the user is entitled to see which. */
export type TimePreview = {
  initialMs: number;
  overheadMs: number;
  /** Clock below which this seat stops delegating (0 when it never delegates). */
  handoverMs: number;
  atFullClockMs: number;
  atLowClockMs: number;
  lowClockMs: number;
  delegatesAtFullClock: boolean;
  delegatesAtLowClock: boolean;
};

export function previewAt(
  policy: TimePolicy,
  tc: { initialSecs: number; incSecs: number },
  /** Where to describe the low-time case. 15s is not arbitrary: it is where the
   *  reported blundering started. */
  lowClockMs = 15_000,
): TimePreview {
  const initialMs = tc.initialSecs * 1000;
  const incrementMs = tc.incSecs * 1000;
  const overheadMs = moveOverheadMs(initialMs);
  const delegated = policy.mode === "engine";
  const handoverMs = delegated ? takeoverBelowMs(policy, overheadMs) : 0;
  // Sample at the handover when that comes first. A fixed 15s is above the
  // handover at 1+0 (6.2s), so a bullet row would read "Stockfish" in both
  // columns and never show what the seat itself does — which is the case the
  // whole change is about. The cell reports the clock it sampled, so a sample
  // that moves per row stays honest.
  const lowAt = Math.min(lowClockMs, handoverMs > 0 ? handoverMs : lowClockMs, initialMs);
  const at = (remainingMs: number) => budgetMs(policy, { remainingMs, incrementMs });
  return {
    initialMs,
    overheadMs,
    handoverMs,
    atFullClockMs: at(initialMs),
    atLowClockMs: at(lowAt),
    lowClockMs: lowAt,
    delegatesAtFullClock: delegated && initialMs > handoverMs,
    delegatesAtLowClock: delegated && lowAt > handoverMs,
  };
}
