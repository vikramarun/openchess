import { MARK_ACCENT, MARK_LIGHT, ROOK_LEFT, ROOK_RIGHT } from "@/lib/brand";

/** The OpenChess mark, inline. Draws from the same path constants that
 *  lib/brand.ts bakes into app/icon.svg and the OG cards, so the header can
 *  never disagree with the favicon.
 *
 *  No tile: every on-page use sits on --bg or --panel-2, both dark enough for
 *  the light half to read. The tiled variant is for icon-shaped uses only. */
export function Logo({
  size = 24,
  className,
  tone,
  decorative,
}: {
  size?: number;
  className?: string;
  /** Paint both halves this color instead of the two-tone mark. For surfaces
   *  the split doesn't read on — struck into the gold of the demo coin, the
   *  light half vanishes and the green half turns muddy. Geometry still comes
   *  from lib/brand.ts, so a stamped mark can't drift from the favicon. */
  tone?: string;
  /** Drop the img role and label, for a mark that sits beside its own wordmark
   *  or inside an element that already names itself. */
  decorative?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": "OpenChess" })}
    >
      <path fill={tone ?? MARK_LIGHT} d={ROOK_LEFT} />
      <path fill={tone ?? MARK_ACCENT} d={ROOK_RIGHT} />
    </svg>
  );
}
