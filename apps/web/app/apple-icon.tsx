import { ImageResponse } from "next/og";

import { MARK_ACCENT, MARK_LIGHT, MARK_TILE, ROOK_LEFT, ROOK_RIGHT } from "@/lib/brand";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** iOS home-screen icon. Deliberately full-bleed rather than reusing the
 *  rounded tile from icon.svg: iOS applies its own squircle mask, and our
 *  corner radius showing through inside it reads as a mistake. The bare mark on
 *  a filled square lets the platform do the rounding. */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: MARK_TILE,
        }}
      >
        <svg width={124} height={124} viewBox="0 0 64 64">
          <path fill={MARK_LIGHT} d={ROOK_LEFT} />
          <path fill={MARK_ACCENT} d={ROOK_RIGHT} />
        </svg>
      </div>
    ),
    size,
  );
}
