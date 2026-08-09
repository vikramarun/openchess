import type { Metadata } from "next";

import { isAddress, shortAddress } from "@/lib/address";
import { SERVER_HTTP } from "@/lib/config";

type Profile = { rating: number; games: number; wins: number; losses: number; draws: number };

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Rating and record for the title, when the server can supply them. Mirrors
 *  the validate-then-fetch order ProfileStats uses: the route param is
 *  user-controlled, so it is validated before being interpolated into the API
 *  path. Any failure returns null and the caller falls back.
 *
 *  Every field is checked, not just rating: the description interpolates all
 *  five, so one missing key from a partial payload would put the literal string
 *  "undefined" into a page's meta description. */
async function fetchProfile(address: string): Promise<Profile | null> {
  if (!isAddress(address)) return null;
  try {
    const r = await fetch(`${SERVER_HTTP}/players/${encodeURIComponent(address)}`, {
      next: { revalidate: 300 },
    });
    if (!r.ok) return null;
    const p = await r.json();
    if (!p || !isNum(p.rating) || !isNum(p.games)) return null;
    if (!isNum(p.wins) || !isNum(p.losses) || !isNum(p.draws)) return null;
    return p as Profile;
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: { address: string };
}): Promise<Metadata> {
  const address = params.address.toLowerCase();
  // Don't echo an unvalidated route param back into the title — a non-address
  // would render as mangled text like "notana…ress". The page itself rejects
  // these with its own message; the tab just says "Player".
  if (!isAddress(address)) return { title: "Player", robots: { index: false } };

  const short = shortAddress(address, "Player");
  const profile = await fetchProfile(address);

  const title = profile ? `${short} — ${profile.rating}` : short;
  const description = profile
    ? `${profile.games} games · ${profile.wins}W ${profile.losses}L ${profile.draws}D · rated ${profile.rating} on OpenChess.`
    : `Engine record and rating for ${short} on OpenChess.`;

  return { title, description, openGraph: { title, description } };
}

export default function PlayerLayout({ children }: { children: React.ReactNode }) {
  return children;
}
