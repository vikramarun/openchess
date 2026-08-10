"use client";

import { useState } from "react";

import { TIME_CONTROLS } from "@/lib/timeControls";
import {
  previewAt,
  TEMPO_PRESETS,
  tempoName,
  type TempoName,
  type TimeMode,
  type TimePolicy,
} from "@/lib/timePolicy";

/** How the bot spends its clock.
 *
 *  Two rules this UI exists to keep, both learned the hard way:
 *
 *  1. **A taste setting must not reach a safety property.** The retired `pace`
 *     mode read as "how thoughtful should my bot be" and actually moved the
 *     clock at which the engine stops thinking — from 26s down to 4s at its
 *     lowest setting. Nothing here may edit the reserve or the handover point;
 *     those are derived (see lib/timePolicy `moveOverheadMs`,
 *     `takeoverBelowMs`) and deliberately absent from the page.
 *  2. **If it can't be previewed, it isn't a setting.** The old panel showed
 *     budgets for every mode EXCEPT the default, and described that one in
 *     prose as having "nothing to lose" — while it was the mode that answered
 *     in 2ms below 13 seconds. Every mode now shows real numbers at real time
 *     controls, including the low-clock case that was broken.
 *
 *  There is no strength control, by design: this bot is always full-strength
 *  Stockfish, and BENCH.md prices the alternatives.
 */

const MODES: { mode: TimeMode; label: string; blurb: string }[] = [
  {
    mode: "engine",
    label: "Engine decides",
    blurb: "Stockfish manages its own clock, and the seat takes over once it can't. The default.",
  },
  { mode: "tempo", label: "Tempo", blurb: "A share of the clock per move — how fast your bot feels." },
  { mode: "fixed", label: "Fixed per move", blurb: "A flat think time. Low values bank clock and never flag." },
  { mode: "nodes", label: "Fixed nodes", blurb: "Same strength on a phone as on a desktop — search size, not time." },
];

const TEMPOS: { name: TempoName; label: string; blurb: string }[] = [
  { name: "blitzer", label: "Blitzer", blurb: "Snappy, banks clock" },
  { name: "steady", label: "Steady", blurb: "Even pace" },
  { name: "deliberate", label: "Deliberate", blurb: "Thinks visibly" },
];

const secs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

export function TimeControls({
  time,
  onChange,
}: {
  time: TimePolicy;
  onChange: (patch: Partial<TimePolicy>) => void;
}) {
  const [advanced, setAdvanced] = useState(false);

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

      {time.mode === "tempo" && (
        <div className="rep-presets">
          {TEMPOS.map((t) => (
            <button
              key={t.name}
              className={`rep-preset${time.divisor === TEMPO_PRESETS[t.name] ? " active" : ""}`}
              onClick={() => onChange({ divisor: TEMPO_PRESETS[t.name] })}
              title={t.blurb}
            >
              <span className="rp-name">{t.label}</span>
              <span className="rp-blurb">{t.blurb}</span>
            </button>
          ))}
        </div>
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

      <Preview time={time} />

      {time.mode === "tempo" && (
        <details open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}>
          <summary className="muted" style={{ fontSize: 12, cursor: "pointer" }}>
            Advanced
          </summary>
          <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
            <label className="muted" style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
              Spend 1 /
              <input
                type="number"
                min={5}
                max={200}
                value={time.divisor}
                onChange={(e) => onChange({ divisor: Number(e.target.value) || TEMPO_PRESETS.steady })}
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
          </div>
        </details>
      )}

      {/* The selected mode's blurb is already on its button; repeating it here
          just made the panel say everything twice. Only the thing the buttons
          CAN'T show belongs here: that Advanced has been used to set a pace no
          preset matches, so none of them is highlighted. */}
      {time.mode === "tempo" && !tempoName(time.divisor) && (
        <div className="muted" style={{ fontSize: 12 }}>
          Custom pace — 1/{time.divisor} of the clock, so no preset is selected above.
        </div>
      )}
    </div>
  );
}

function Cell({ delegated, ms }: { delegated: boolean; ms: number }) {
  return (
    <td style={{ paddingRight: 14, color: delegated ? undefined : "var(--text-strong)" }}>
      {delegated ? "Stockfish" : secs(ms)}
    </td>
  );
}

/** What this policy does at every time control the lobby offers.
 *
 *  A table rather than a sentence, and across all four time controls rather than
 *  one, because these settings are global while a game is not: the same policy
 *  behaves very differently at 1+0 and 10+0, and the old panel hid that by
 *  previewing a single hardcoded "3+2" that the lobby does not even offer. */
function Preview({ time }: { time: TimePolicy }) {
  const rows = TIME_CONTROLS.map((tc) => ({
    tc,
    p: previewAt(time, { initialSecs: tc.initial, incSecs: tc.inc }),
  }));
  const anyDelegation = rows.some((r) => r.p.delegatesAtFullClock || r.p.delegatesAtLowClock);
  // Flag a first move that eats a big share of the clock. `remaining/divisor`
  // decays and so never flags on its own, but it does front-load, and a preset
  // that looks thoughtful at 1+0 can be extravagant at 10+0.
  // Only where the SEAT is choosing: in a delegated cell the number is our
  // hypothetical, and warning about a move Stockfish is making is noise.
  const greedy = rows.filter(
    (r) => !r.p.delegatesAtFullClock && r.p.atFullClockMs > r.p.initialMs * 0.1,
  );

  return (
    <div className="muted" style={{ fontSize: 12 }}>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th style={{ paddingRight: 14, fontWeight: 500 }}>Time control</th>
              <th style={{ paddingRight: 14, fontWeight: 500 }}>First move</th>
              <th style={{ paddingRight: 14, fontWeight: 500 }}>With 15s left</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ tc, p }) => (
              <tr key={tc.label}>
                <td style={{ paddingRight: 14 }}>{tc.label}</td>
                {/* A delegated cell shows WHO is choosing, never a number.
                    Printing our own hypothetical budget there was the first
                    version of this table, and it was the same dishonesty the
                    old panel had in prose: at a healthy clock the seat does not
                    decide, cannot predict what the engine will decide, and a
                    plausible-looking "4.0s" is worse than saying so. */}
                <Cell delegated={p.delegatesAtFullClock} ms={p.atFullClockMs} />
                {p.initialMs <= p.lowClockMs ? (
                  <td style={{ paddingRight: 14 }}>—</td>
                ) : (
                  <Cell delegated={p.delegatesAtLowClock} ms={p.atLowClockMs} />
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 6 }}>
        {anyDelegation
          ? "“Stockfish” means the engine is still managing its own clock there, so the time is its call, not a setting. Below the handover the seat budgets the move itself."
          : "Capped at a quarter of the clock, a tenth once under five seconds, and never past the server's deadline."}
      </div>
      {time.mode === "engine" && (
        <div style={{ marginTop: 4 }}>
          Takes over below{" "}
          {rows.map((r, i) => (
            <span key={r.tc.label}>
              {i > 0 ? ", " : ""}
              <b style={{ color: "var(--text-strong)" }}>{secs(r.p.handoverMs)}</b> at {r.tc.label}
            </span>
          ))}
          .
        </div>
      )}
      {greedy.length > 0 && (
        <div style={{ marginTop: 4 }}>
          Spends over a tenth of the clock on move one at {greedy.map((r) => r.tc.label).join(", ")}.
        </div>
      )}
    </div>
  );
}
