import type { Metadata } from "next";

import { fetchGame } from "@/lib/gameApi";
import { gameSubtitle, gameTitle } from "@/lib/gameSummary";

/** A game URL is the most-shared link this app produces, so it gets a real
 *  title instead of the site default.
 *
 *  Note what is NOT set here: openGraph.images. The sibling opengraph-image.tsx
 *  is injected into this segment's metadata automatically, and setting images
 *  in both means one silently wins. Titles here, the picture there. */
export async function generateMetadata({
  params,
}: {
  params: { id: string };
}): Promise<Metadata> {
  // fetchGame already swallows 404s, network failures, and malformed payloads
  // into null. A crawler hitting a dead id must get a generic title, never a 500.
  const game = await fetchGame(params.id);
  if (!game) return { title: "Game" };

  const title = gameTitle(game);
  const description = gameSubtitle(game);
  return {
    title,
    description,
    openGraph: { title, description },
    twitter: { title, description },
  };
}

export default function GameLayout({ children }: { children: React.ReactNode }) {
  return children;
}
