import type { Metadata } from "next";

import { shortAddress } from "@/lib/address";
import { SERVER_HTTP } from "@/lib/config";

const ADDR_RE = /^0x[0-9a-f]{40}$/;

type Profile = { rating: number; games: number; wins: number; losses: number; draws: number };

/** Rating and record for the title, when the server can supply them. Mirrors
 *  the validate-then-fetch order ProfileStats uses: the route param is
 *  user-controlled, so it is checked against ADDR_RE before being interpolated
 *  into the API path. Any failure returns null and the caller falls back. */
async function fetchProfile(address: string): Promise<Profile | null> {
  if (!ADDR_RE.test(address)) return null;
  try {
    const r = await fetch(`${SERVER_HTTP}/players/${encodeURIComponent(address)}`, {
      next: { revalidate: 300 },
    });
    if (!r.ok) return null;
    const p = await r.json();
    return p && typeof p.rating === "number" && typeof p.games === "number" ? p : null;
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
  if (!ADDR_RE.test(address)) return { title: "Player", robots: { index: false } };

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
