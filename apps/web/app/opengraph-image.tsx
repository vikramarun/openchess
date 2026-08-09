import { ImageResponse } from "next/og";

import { OG_SUBLINE, TAGLINE } from "@/lib/brand";
import { OG_SIZE, ogCard } from "@/lib/ogCard";

export const alt = "OpenChess — engine-vs-engine chess, settled onchain";
export const size = OG_SIZE;
export const contentType = "image/png";

/** The card behind every link to the site that isn't a specific game. Static —
 *  nothing here varies, so Next can render it once at build time. */
export default function Image() {
  return new ImageResponse(ogCard({ title: TAGLINE, subtitle: OG_SUBLINE }), size);
}
