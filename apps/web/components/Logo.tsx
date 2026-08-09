import { MARK_ACCENT, MARK_LIGHT, ROOK_LEFT, ROOK_RIGHT } from "@/lib/brand";

/** The OpenChess mark, inline. Draws from the same path constants that
 *  lib/brand.ts bakes into app/icon.svg and the OG cards, so the header can
 *  never disagree with the favicon.
 *
 *  No tile: every on-page use sits on --bg or --panel-2, both dark enough for
 *  the light half to read. The tiled variant is for icon-shaped uses only. */
export function Logo({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label="OpenChess"
    >
      <path fill={MARK_LIGHT} d={ROOK_LEFT} />
      <path fill={MARK_ACCENT} d={ROOK_RIGHT} />
    </svg>
  );
}
