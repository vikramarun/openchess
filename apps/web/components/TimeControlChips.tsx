import { TIME_CONTROLS } from "@/lib/timeControls";

/** Read-only display of the time controls available across every mode. The
 *  server enforces the chosen clock; engines (browser or native) play to it. */
export function TimeControlChips({ note }: { note?: string }) {
  return (
    <div className="tc-chips-wrap">
      <span className="muted" style={{ fontSize: 13 }}>
        Time controls:
      </span>
      <span className="tc-chips">
        {TIME_CONTROLS.map((t) => (
          <span key={t.label} className="tc-chip">
            {t.label}
          </span>
        ))}
      </span>
      {note && (
        <span className="muted" style={{ fontSize: 13 }}>
          {note}
        </span>
      )}
    </div>
  );
}
