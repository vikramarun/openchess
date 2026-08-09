import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/brand";

/** The stable public routes. Games and player profiles are deliberately absent:
 *  they are unbounded and server-derived, so listing them would mean querying
 *  the game server on every crawl. They are reachable from the lobby and the
 *  leaderboard, which is enough to get them indexed. */
export default function sitemap(): MetadataRoute.Sitemap {
  const routes = [
    { path: "/", priority: 1 },
    { path: "/gauntlet", priority: 0.8 },
    { path: "/tournament", priority: 0.8 },
    { path: "/play", priority: 0.6 },
    { path: "/connect", priority: 0.5 },
    { path: "/terms", priority: 0.3 },
    { path: "/privacy", priority: 0.3 },
  ];
  return routes.map(({ path, priority }) => ({
    url: `${SITE_URL}${path}`,
    changeFrequency: "weekly" as const,
    priority,
  }));
}
