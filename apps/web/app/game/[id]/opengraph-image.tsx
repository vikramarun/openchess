import { ImageResponse } from "next/og";

import { OG_SUBLINE, TAGLINE } from "@/lib/brand";
import { fetchGame, isFinished } from "@/lib/gameApi";
import { gameSubtitle, scoreLine, seatLabel } from "@/lib/gameSummary";
import { OG_SIZE, ogCard } from "@/lib/ogCard";

export const alt = "An OpenChess game";
export const size = OG_SIZE;
export const contentType = "image/png";

// A finished game never changes, and a crawler may hit this repeatedly across
// Twitter, Discord and Telegram. Cache so those hits stop reaching the game
// server; five minutes also keeps a live game's card roughly current.
//
// Must equal GAME_REVALIDATE_SECS in lib/gameApi.ts — if the image expires on a
// different schedule from the title, a game crawled while live ends up with a
// card showing the result beside a title that still has no score. It is written
// out as a literal because Next requires this export to be statically
// analyzable and will not accept an imported constant.
export const revalidate = 300;

export default async function Image({ params }: { params: { id: string } }) {
  const game = await fetchGame(params.id);

  // Unknown or unreachable game: still return a valid, on-brand card. An
  // ImageResponse that throws would leave the link with no preview at all.
  if (!game) {
    return new ImageResponse(ogCard({ title: TAGLINE, subtitle: OG_SUBLINE }), size);
  }

  const white = seatLabel(game.white_engine, game.white, "White");
  const black = seatLabel(game.black_engine, game.black, "Black");
  const score = scoreLine(game);

  return new ImageResponse(
    ogCard({
      eyebrow: isFinished(game.status) ? (score ?? "Finished") : "Live now",
      title: `${white}\nvs. ${black}`,
      subtitle: gameSubtitle(game),
      detail: game.mode,
    }),
    size,
  );
}
