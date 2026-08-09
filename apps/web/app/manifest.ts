import type { MetadataRoute } from "next";

import { BRAND_NAME, MARK_TILE, SITE_DESCRIPTION, SITE_TITLE } from "@/lib/brand";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE_TITLE,
    short_name: BRAND_NAME,
    description: SITE_DESCRIPTION,
    start_url: "/",
    display: "standalone",
    background_color: MARK_TILE,
    theme_color: MARK_TILE,
    icons: [
      // One vector entry rather than a PNG ladder: the mark is flat geometry,
      // so a single SVG covers every size an installer asks for, and there is
      // no binary to keep in sync with lib/brand.ts.
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
