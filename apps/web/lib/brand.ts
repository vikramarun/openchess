// The OpenChess mark, and the brand strings that go with it.
//
// The mark is a rook bisected down the middle: the rook is the vault (stakes
// sit in the escrow contract, never with us) and the split is the two engines.
// A rook is the right piece for the job mechanically too — it is nearly all
// straight lines, so it survives a 16px favicon where a knight turns to mush.
//
// Geometry lives HERE and nowhere else. It is rendered by <Logo>, baked into
// app/icon.svg, and rasterized into the apple-icon and the OG cards, and those
// paths cannot be allowed to drift apart; scripts/brand.test.ts pins the one
// copy that is a separate file on disk. This is the same arrangement the board
// theming uses (lib/boardBootstrap.ts vs. applyBoardPrefs, pinned by
// scripts/boardPrefs.test.ts).

/** Light half — matches --text-strong. */
export const MARK_LIGHT = "#ededec";
/** Dark half — matches --accent. */
export const MARK_ACCENT = "#629924";
/** Icon tile — matches --bg. */
export const MARK_TILE = "#161512";

// The rook, split at the axis of symmetry (x=32) into two closed paths in a
// 0 0 64 64 box. Two solid paths rather than one path drawn twice under a
// clipPath: resvg (which rasterizes these for the OG cards) then has nothing to
// get wrong, and a fill is cheaper than a clip at favicon sizes.
//
// Three merlons (12-22, 27-37, 42-52), a tapered neck, a flared base. Content
// occupies x 12..52, y 12..59.
export const ROOK_LEFT = "M32 12 H27 V20 H22 V12 H12 V27 L17 32 L20 45 L13 55 V59 H32 Z";
export const ROOK_RIGHT = "M32 12 H37 V20 H42 V12 H52 V27 L47 32 L44 45 L51 55 V59 H32 Z";

/** Centers the mark in a 64x64 tile with even padding. The rook's own bounding
 *  box is taller than it is wide and sits low in the viewBox (y 12..59, center
 *  35.5), so it needs lifting as well as scaling — otherwise the tile looks
 *  bottom-heavy. Maps (32, 35.5) to (32, 32) at 0.85 scale. */
const TILE_TRANSFORM = "translate(4.8 1.825) scale(.85)";

export type MarkOptions = {
  /** Draw on an opaque rounded tile. Required for anything icon-shaped: on a
   *  light browser tab strip the #ededec half of a transparent mark vanishes
   *  and leaves half a rook, and iOS composites transparent app icons badly. */
  tile?: boolean;
  /** Rendered size in px. Omitted for icon.svg, which should scale to whatever
   *  the consumer asks for. */
  size?: number;
};

/** The complete mark as a standalone SVG document. */
export function rookMarkSvg({ tile = false, size }: MarkOptions = {}): string {
  const dims = size ? ` width="${size}" height="${size}"` : "";
  const paths =
    `<path fill="${MARK_LIGHT}" d="${ROOK_LEFT}"/>` +
    `<path fill="${MARK_ACCENT}" d="${ROOK_RIGHT}"/>`;
  const body = tile
    ? `<rect width="64" height="64" rx="12" fill="${MARK_TILE}"/>` +
      `<g transform="${TILE_TRANSFORM}">${paths}</g>`
    : paths;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"${dims}>${body}</svg>`;
}

// NOTE for the OG cards (lib/ogCard.tsx, app/apple-icon.tsx): draw the mark by
// putting ROOK_LEFT/ROOK_RIGHT in an inline <svg>, and do NOT reach for an
// <img> with a data URI of rookMarkSvg(). Satori rasterizes with resvg, and the
// resvg build in a production bundle does not decode a nested SVG image — it
// drops it and still returns a 200, so the card renders wordmark-only and every
// shared link quietly loses its logo. The dev server uses a different resvg
// that DOES decode it, so this passes locally and fails once deployed. That is
// exactly how it shipped the first time. Encoding makes no difference; base64
// and percent-encoded produce byte-identical, markless output.

// --- strings -----------------------------------------------------------------

export const BRAND_NAME = "OpenChess";
export const TAGLINE = "Machines play. You back yours.";
export const SITE_TITLE = "OpenChess: engine-vs-engine chess, settled onchain";
export const SITE_DESCRIPTION =
  "Bring your own engine or use the one already in your browser. Games play out for real USDC stakes, settled onchain on Base and never held by us.";
/** Short line for the OG cards, where the full description is too long to read
 *  at a glance in a timeline. */
export const OG_SUBLINE = "Engine-vs-engine chess · USDC on Base";

/** Canonical origin. Overridable so a preview deployment unfurls as itself
 *  rather than advertising production. */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://openchess.ai";
