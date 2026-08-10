// Verify the think-time budget. These are safety rules, not preferences: a
// browser seat that overruns its clock in a wagered game loses real USDC, so
// every clamp here is pinned rather than trusted.
import {
  budgetMs,
  goCommand,
  normalizeTimePolicy,
  timePolicyLabel,
  DEFAULT_TIME_POLICY,
  MAX_CLOCK_FRACTION,
  MAX_MOVE_OVERHEAD_MS,
  MIN_BUDGET_MS,
  MIN_MOVE_OVERHEAD_MS,
  takeoverBelowMs,
  moveOverheadMs,
  OVERHEAD_MS,
  PANIC_MS,
  type TimePolicy,
} from "../lib/timePolicy";

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
}

const P = (patch: Partial<TimePolicy>): TimePolicy => ({ ...DEFAULT_TIME_POLICY, ...patch });

// --- normalization ---------------------------------------------------------
{
  check("empty normalizes to defaults", normalizeTimePolicy({}), DEFAULT_TIME_POLICY);
  check("null normalizes to defaults", normalizeTimePolicy(null), DEFAULT_TIME_POLICY);
  check("an unknown mode falls back", normalizeTimePolicy({ mode: "telepathy" }).mode, "engine");
  check("a valid mode survives", normalizeTimePolicy({ mode: "nodes" }).mode, "nodes");

  // These come out of localStorage, which the user can edit. A NaN would reach
  // the engine as `go movetime NaN`, which it simply never answers — the seat
  // would hang until the server flagged it.
  check("NaN fixedMs falls back", normalizeTimePolicy({ fixedMs: NaN }).fixedMs, DEFAULT_TIME_POLICY.fixedMs);
  // Infinity is invalid input, not "very large" — falling back to the default
  // is safer than clamping to the 20M ceiling, which would be a minutes-long
  // search on every move.
  check("Infinity nodes falls back to the default", normalizeTimePolicy({ nodes: Infinity }).nodes, DEFAULT_TIME_POLICY.nodes);
  check("a genuinely large nodes value clamps to the ceiling", normalizeTimePolicy({ nodes: 1e12 }).nodes, 20_000_000);
  check("negative fixedMs clamps up", normalizeTimePolicy({ fixedMs: -9999 }).fixedMs, 50);
  check("absurd fixedMs clamps down", normalizeTimePolicy({ fixedMs: 1e9 }).fixedMs, 30_000);
  check("a string number is accepted", normalizeTimePolicy({ divisor: "40" }).divisor, 40);
  check("an object is rejected", normalizeTimePolicy({ divisor: {} }).divisor, DEFAULT_TIME_POLICY.divisor);
  check("incFactor clamps to 0..1", normalizeTimePolicy({ incFactor: 5 }).incFactor, 1);
  // movestogo must never reach 1: Stockfish then assumes a new time control is
  // coming and spends nearly the whole clock on one move.
  check("movestogo floors at 2", normalizeTimePolicy({ movestogo: 1 }).movestogo, 2);
  check("switching mode keeps other fields", normalizeTimePolicy({ mode: "fixed", nodes: 5000 }).nodes, 5000);
}

// --- the three safety clamps ----------------------------------------------
{
  const huge = P({ mode: "fixed", fixedMs: 30_000 });

  // 1. Never more than a quarter of the clock.
  check(
    "a huge fixed budget is capped at 1/4 of the clock",
    budgetMs(huge, { remainingMs: 60_000, incrementMs: 0 }),
    15_000,
  );
  check(
    "the quarter cap holds at any clock size",
    [10_000, 40_000, 100_000].every(
      (r) => budgetMs(huge, { remainingMs: r, incrementMs: 0 }) <= r * MAX_CLOCK_FRACTION,
    ),
    true,
  );

  // 2. Panic mode under 5s.
  check(
    "under PANIC_MS we spend a tenth of the clock",
    budgetMs(huge, { remainingMs: 4_000, incrementMs: 0 }),
    400,
  );
  check(
    "just above PANIC_MS the quarter rule applies instead",
    budgetMs(huge, { remainingMs: PANIC_MS + 1000, incrementMs: 0 }),
    Math.floor((PANIC_MS + 1000) * MAX_CLOCK_FRACTION),
  );

  // 3. The server's deadline always wins.
  check(
    "the server deadline caps the budget",
    budgetMs(huge, { remainingMs: 60_000, incrementMs: 0, deadlineInMs: 2_000 }),
    2_000 - OVERHEAD_MS,
  );
  check(
    "a generous deadline doesn't raise the budget",
    budgetMs(huge, { remainingMs: 60_000, incrementMs: 0, deadlineInMs: 999_999 }),
    15_000,
  );

  // Floor and ceiling.
  check("tiny budgets floor at MIN_BUDGET_MS", budgetMs(P({ mode: "fixed", fixedMs: 50 }), { remainingMs: 60_000, incrementMs: 0 }), MIN_BUDGET_MS);
  check(
    "we never hand over the whole clock",
    budgetMs(huge, { remainingMs: 120, incrementMs: 0 }) <= 120 - OVERHEAD_MS || budgetMs(huge, { remainingMs: 120, incrementMs: 0 }) <= 20,
    true,
  );
  check("an almost-flagged clock still returns something playable", budgetMs(huge, { remainingMs: 10, incrementMs: 0 }) >= 1, true);
  check("the budget is always an integer", Number.isInteger(budgetMs(huge, { remainingMs: 37_777, incrementMs: 133 })), true);

  // Monotonic: more clock never means less thinking.
  const seq = [1_000, 5_000, 20_000, 60_000, 300_000].map((r) => budgetMs(huge, { remainingMs: r, incrementMs: 0 }));
  check("budget is monotonic in remaining time", seq.every((v, i) => i === 0 || v >= seq[i - 1]), true);
}

// --- per-mode budgets ------------------------------------------------------
{
  check(
    "fraction spends remaining/divisor plus part of the increment",
    budgetMs(P({ mode: "fraction", divisor: 40, incFactor: 0.8 }), { remainingMs: 120_000, incrementMs: 1_000 }),
    3_800,
  );
  check(
    "a blitzer's fixed time is respected when the clock allows",
    budgetMs(P({ mode: "fixed", fixedMs: 250 }), { remainingMs: 60_000, incrementMs: 0 }),
    250,
  );
  // `go nodes` ignores the clock, so its budget is only the wall that stops a
  // slow device flagging.
  check(
    "nodes mode caps its wall at 20% of the clock",
    budgetMs(P({ mode: "nodes" }), { remainingMs: 10_000, incrementMs: 0 }),
    2_000,
  );
  check(
    "nodes mode's wall never exceeds 4s",
    budgetMs(P({ mode: "nodes" }), { remainingMs: 600_000, incrementMs: 0 }),
    4_000,
  );
}

// --- go commands -----------------------------------------------------------
{
  const clock = { whiteMs: 60_000, blackMs: 59_000, incMs: 1_000 };
  // A healthy clock: well above the takeover point at every reserve below, so
  // these pin delegation rather than the handover.
  const go = (
    policy: TimePolicy,
    ctx: { clock: typeof clock | null; budgetMs: number; remainingMs?: number; overheadMs?: number },
  ) =>
    goCommand(policy, {
      clock: ctx.clock,
      budgetMs: ctx.budgetMs,
      remainingMs: ctx.remainingMs ?? 600_000,
      overheadMs: ctx.overheadMs ?? 250,
    });

  // The default must be byte-identical to what the engine sent before this
  // existed, or every existing game changes strength silently.
  check(
    "engine mode reproduces today's command exactly",
    go(P({ mode: "engine" }), { clock, budgetMs: 1234 }),
    { cmd: "go wtime 60000 btime 59000 winc 1000 binc 1000" },
  );
  check(
    "pace appends a constant movestogo",
    go(P({ mode: "pace", movestogo: 18 }), { clock, budgetMs: 1234 }).cmd,
    "go wtime 60000 btime 59000 winc 1000 binc 1000 movestogo 18",
  );
  check("fixed uses movetime", go(P({ mode: "fixed" }), { clock, budgetMs: 300 }).cmd, "go movetime 300");
  check("fraction uses movetime", go(P({ mode: "fraction" }), { clock, budgetMs: 900 }).cmd, "go movetime 900");

  const nodes = go(P({ mode: "nodes", nodes: 250_000 }), { clock, budgetMs: 2_500 });
  check("nodes uses go nodes", nodes.cmd, "go nodes 250000");
  // Without the wall a slow device would search 250k nodes past its flag.
  check("nodes carries a wall-clock stop", nodes.hardStopMs, 2_500);
  check("clock modes need no wall", go(P({ mode: "engine" }), { clock, budgetMs: 1 }).hardStopMs, undefined);

  // Clockless games (the /play page can run without one).
  check(
    "engine mode degrades to movetime with no clock",
    go(P({ mode: "engine" }), { clock: null, budgetMs: 400 }).cmd,
    "go movetime 400",
  );
  check(
    "pace degrades to movetime with no clock",
    go(P({ mode: "pace" }), { clock: null, budgetMs: 400 }).cmd,
    "go movetime 400",
  );

  // We must never report a clock we don't have.
  check(
    "a near-zero clock is floored, never inflated",
    go(P({ mode: "engine" }), {
      clock: { whiteMs: 3, blackMs: 0, incMs: -5 },
      budgetMs: 50,
      // Above the takeover point, so this still pins the clock command itself.
      remainingMs: 600_000,
    }).cmd,
    "go wtime 50 btime 50 winc 0 binc 0",
  );
}

// --- the takeover ----------------------------------------------------------
// Below `Move Overhead × (2 + movestogo)` Stockfish has nothing left to
// allocate and answers in ~2ms, so the seat stops delegating and spends its own
// budget. It must be a REPLACEMENT: a `movetime` appended to a `wtime` command
// is only a ceiling, so the collapsed search would survive it.
{
  const clock = { whiteMs: 12_000, blackMs: 12_000, incMs: 0 };
  const at = (remainingMs: number, overheadMs: number, policy = P({ mode: "engine" })) =>
    goCommand(policy, { clock, budgetMs: 400, remainingMs, overheadMs });

  // 250ms reserve → dead at 13.0s, handover at 26.0s.
  check("a healthy clock still delegates", at(30_000, 250).cmd.startsWith("go wtime"), true);
  check("the collapse zone is taken over", at(20_000, 250).cmd, "go movetime 400");
  check("and so is everything below it", at(5_000, 250).cmd, "go movetime 400");

  // 60ms (1+0) → dead at 3.1s, handover at 6.2s. The whole point of scaling the
  // reserve is that a bullet seat delegates far further down than a rapid one.
  check("a bullet seat still delegates at 10s", at(10_000, 60).cmd.startsWith("go wtime"), true);
  check("a bullet seat takes over at 5s", at(5_000, 60).cmd, "go movetime 400");

  // The threshold is derived, so a policy that states its own movestogo moves
  // it — the coupling that made `pace` a safety setting wearing a taste label.
  check("engine mode assumes 50 moves to go", takeoverBelowMs(P({ mode: "engine" }), 100), 10_400);
  check("pace uses its own movestogo", takeoverBelowMs(P({ mode: "pace", movestogo: 10 }), 100), 2_400);
  check(
    "a low movestogo hands over later, not earlier",
    at(5_000, 100, P({ mode: "pace", movestogo: 10 })).cmd.startsWith("go wtime"),
    true,
  );

  // The modes that already spend their own budget are unaffected either way.
  check("fixed is unchanged in the takeover zone", at(1_000, 250, P({ mode: "fixed" })).cmd, "go movetime 400");
}

// --- labels ----------------------------------------------------------------
{
  check("engine mode has no label", timePolicyLabel(P({ mode: "engine" })), "");
  check("a low fixed time reads as Blitzer", timePolicyLabel(P({ mode: "fixed", fixedMs: 250 })), "Blitzer");
  check("a high fixed time shows seconds", timePolicyLabel(P({ mode: "fixed", fixedMs: 2500 })), "2.5s/move");
  check("a low movestogo reads as a deep thinker", timePolicyLabel(P({ mode: "pace", movestogo: 15 })), "Deep thinker");
  check("nodes reads in thousands", timePolicyLabel(P({ mode: "nodes", nodes: 250_000 })), "250k nodes");
}

// --- the network reserve ---------------------------------------------------
// Not a preference: Stockfish holds back ~52x this number before it allocates
// anything, so a flat value is a flat fraction of a rapid clock and a fifth of
// a bullet one. Measured at 15s left on the shipped search: 100ms of thinking
// at a 250ms reserve, 517ms at 100ms.
{
  check("1+0 scales down hard", moveOverheadMs(60_000), 60);
  check("3+0 scales", moveOverheadMs(180_000), 180);
  check("5+0 reaches the cap", moveOverheadMs(300_000), MAX_MOVE_OVERHEAD_MS);
  check("10+0 stays at the cap", moveOverheadMs(600_000), MAX_MOVE_OVERHEAD_MS);

  // The reserve Stockfish actually withholds is `overhead × (2 + 50)`. Pinning
  // it as a SHARE of the clock is the property that matters — it is what keeps
  // the collapse inside the range where instant moves are right anyway.
  for (const initial of [60_000, 180_000]) {
    const share = (moveOverheadMs(initial) * 52) / initial;
    check(`${initial / 1000}s reserves about a twentieth of the clock`, share < 0.06, true);
  }

  // An absent clock means "not known yet", which calls for the most cautious
  // value, not the smallest. Taking the floor here would risk flagging on
  // latency in exactly the case where we know least.
  check("an unknown clock takes the cap", moveOverheadMs(NaN), MAX_MOVE_OVERHEAD_MS);
  check("a zero clock takes the cap", moveOverheadMs(0), MAX_MOVE_OVERHEAD_MS);
  check("a tiny clock still reserves something", moveOverheadMs(1_000), MIN_MOVE_OVERHEAD_MS);
}

process.exit(failed === 0 ? 0 : 1);
