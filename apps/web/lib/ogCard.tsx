// The shared layout behind every OG card: the site's, and each game's.
//
// This renders through Satori (next/og), which is not a browser. Two rules it
// enforces that ordinary JSX does not: every element with more than one child
// needs an explicit `display: flex`, and the mark has to arrive as an <img>
// with a data URI rather than as inline SVG. Spacing uses margins rather than
// `gap` for the same reason — fewer assumptions about what the renderer
// implements.

import { MARK_ACCENT, MARK_LIGHT, MARK_TILE, ROOK_LEFT, ROOK_RIGHT } from "./brand";

/** Facebook/Twitter/Discord all crop toward 1.91:1; this is the standard. */
export const OG_SIZE = { width: 1200, height: 630 };

/** Rendered size of the mark in the card header. */
const MARK_PX = 80;

const TEXT = "#ededec";
const MUTED = "#9c968c";
const FAINT = "#7d7870";
const ACCENT = "#629924";

export type OgCardProps = {
  /** Small line above the title — a game's time control, a section name. */
  eyebrow?: string;
  title: string;
  subtitle?: string;
  /** Bottom-right detail, e.g. a stake. The domain always sits bottom-left. */
  detail?: string;
};

export function ogCard({ eyebrow, title, subtitle, detail }: OgCardProps) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        backgroundColor: MARK_TILE,
        padding: "68px 72px",
      }}
    >
      {/* A hairline of accent along the top edge, so the card reads as ours
          even as a thumbnail where the wordmark is illegible. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: 1200,
          height: 8,
          backgroundColor: ACCENT,
        }}
      />

      <div style={{ display: "flex", alignItems: "center" }}>
        <svg width={MARK_PX} height={MARK_PX} viewBox="0 0 64 64">
          <path fill={MARK_LIGHT} d={ROOK_LEFT} />
          <path fill={MARK_ACCENT} d={ROOK_RIGHT} />
        </svg>
        <div
          style={{
            marginLeft: 20,
            fontSize: 38,
            fontWeight: 700,
            color: TEXT,
            letterSpacing: -1,
          }}
        >
          OpenChess
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        {eyebrow ? (
          <div
            style={{
              fontSize: 26,
              color: ACCENT,
              letterSpacing: 2,
              textTransform: "uppercase",
              marginBottom: 18,
            }}
          >
            {eyebrow}
          </div>
        ) : null}
        <div
          style={{
            fontSize: 66,
            fontWeight: 700,
            color: TEXT,
            letterSpacing: -2,
            lineHeight: 1.1,
            // Callers put a newline between the two engine names so the
            // matchup stacks; Satori collapses it without this.
            whiteSpace: "pre-wrap",
          }}
        >
          {title}
        </div>
        {subtitle ? (
          <div style={{ fontSize: 32, color: MUTED, marginTop: 20 }}>{subtitle}</div>
        ) : null}
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 26,
          color: FAINT,
        }}
      >
        <div>openchess.ai</div>
        {detail ? <div style={{ color: MUTED }}>{detail}</div> : null}
      </div>
    </div>
  );
}
