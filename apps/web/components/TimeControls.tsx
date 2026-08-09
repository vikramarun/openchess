"use client";

import { budgetMs, type TimeMode, type TimePolicy } from "@/lib/timePolicy";

const MODES: { mode: TimeMode; label: string; blurb: string }[] = [
  { mode: "engine", label: "Engine decides", blurb: "Stockfish allocates from the real clock. Strongest, and the default." },
  { mode: "pace", label: "Pace", blurb: "Same, but told to expect N more moves — lower thinks longer per move." },
  { mode: "fixed", label: "Fixed per move", blurb: "A flat think time. Low values bank clock and never flag." },
  { mode: "fraction", label: "Share of clock", blurb: "Spend 1/N of what's left, plus part of the increment." },
  { mode: "nodes", label: "Fixed nodes", blurb: "Same strength on a phone as on a desktop — search size, not time." },
];

/** How the bot spends its clock.
 *
 *  This is the best agency-per-Elo control on the page: a bot that answers
 *  instantly is obvious to anyone watching, and it costs almost no strength.
 *  The preview matters — every mode is clamped for safety (a quarter of the
 *  clock, a tenth once under five seconds, never past the server's deadline),
 *  so showing the resulting budget is the only honest way to explain what a
 *  setting will actually do. */
export function TimeControls({
  time,
  onChange,
}: {
  time: TimePolicy;
  onChange: (patch: Partial<TimePolicy>) => void;
}) {
  const active = MODES.find((m) => m.mode === time.mode)!;
  // Preview at three points of a 3+2 game, the middle lobby time control.
  const preview = [
    { label: "at the start (3:00)", ms: 180_000 },
    { label: "with 30s left", ms: 30_000 },
    { label: "with 4s left", ms: 4_000 },
  ].map((p) => ({ ...p, budget: budgetMs(time, { remainingMs: p.ms, incrementMs: 2_000 }) }));

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="rep-presets">
        {MODES.map((m) => (
          <button
            key={m.mode}
            className={`rep-preset${time.mode === m.mode ? " active" : ""}`}
            onClick={() => onChange({ mode: m.mode })}
            title={m.blurb}
          >
            <span className="rp-name">{m.label}</span>
            <span className="rp-blurb">{m.blurb}</span>
          </button>
        ))}
      </div>

      {/* Only the parameters the active mode actually uses. Switching modes
          keeps the others, so nothing is lost by trying one out. */}
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
        {time.mode === "pace" && (
          <label className="muted" style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
            Moves to plan for
            <input
              type="number"
              min={2}
              max={200}
              value={time.movestogo}
              onChange={(e) => onChange({ movestogo: Number(e.target.value) || 30 })}
              style={{ width: 72 }}
            />
          </label>
        )}
        {time.mode === "fixed" && (
          <label className="muted" style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
            Milliseconds per move
            <input
              type="number"
              min={50}
              max={30000}
              step={50}
              value={time.fixedMs}
              onChange={(e) => onChange({ fixedMs: Number(e.target.value) || 500 })}
              style={{ width: 88 }}
            />
          </label>
        )}
        {time.mode === "fraction" && (
          <>
            <label className="muted" style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
              Spend 1 /
              <input
                type="number"
                min={5}
                max={200}
                value={time.divisor}
                onChange={(e) => onChange({ divisor: Number(e.target.value) || 30 })}
                style={{ width: 72 }}
              />
              of the clock
            </label>
            <label className="muted" style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
              plus
              <input
                type="number"
                min={0}
                max={1}
                step={0.1}
                value={time.incFactor}
                onChange={(e) => onChange({ incFactor: Number(e.target.value) })}
                style={{ width: 72 }}
              />
              of the increment
            </label>
          </>
        )}
        {time.mode === "nodes" && (
          <label className="muted" style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
            Nodes per move
            <input
              type="number"
              min={1000}
              max={20000000}
              step={10000}
              value={time.nodes}
              onChange={(e) => onChange({ nodes: Number(e.target.value) || 200000 })}
              style={{ width: 110 }}
            />
          </label>
        )}
      </div>

      {time.mode === "engine" ? (
        <div className="muted" style={{ fontSize: 12 }}>
          Stockfish manages the clock itself, including its own panic heuristics near zero. Nothing
          to tune, and nothing to lose.
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 12 }}>
          On a 3+2 game this thinks{" "}
          {preview.map((p, i) => (
            <span key={p.label}>
              {i > 0 && ", "}
              <b style={{ color: "var(--text-strong)" }}>{(p.budget / 1000).toFixed(2)}s</b> {p.label}
            </span>
          ))}
          .{" "}
          {time.mode === "nodes"
            ? "The node count is the real setting; the times above are only the wall that stops a slow device flagging."
            : "Capped at a quarter of the clock, a tenth once under five seconds, and never past the server's deadline."}
        </div>
      )}
    </div>
  );
}
