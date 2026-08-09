import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/brand";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // /profile is the signed-in settings screen and /bench is a dev-only
      // measurement harness that 404s in production; neither is a landing page.
      disallow: ["/profile", "/bench"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
