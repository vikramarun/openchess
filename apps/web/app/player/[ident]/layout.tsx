import type { Metadata } from "next";

import { isAddress, isUsernameShape, shortAddress } from "@/lib/address";
import { SITE_URL } from "@/lib/brand";
import { SERVER_HTTP } from "@/lib/config";

type Profile = {
  address: string;
  rating: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  username?: string | null;
};

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Rating and record for the title, when the server can supply them. Mirrors
 *  the validate-then-fetch order ProfileStats uses: the route param is
 *  user-controlled, so it is validated before being interpolated into the API
 *  path. Any failure returns null and the caller falls back.
 *
 *  Every field is checked, not just rating: the description interpolates all
 *  five, so one missing key from a partial payload would put the literal string
 *  "undefined" into a page's meta description. `username` is deliberately NOT
 *  among them — it is optional on the payload and absent from an older server,
 *  and requiring it would make every player page silently lose its title the
 *  day the web app deploys ahead of the server, which is the normal order here. */
async function fetchProfile(ident: string): Promise<Profile | null> {
  if (!isAddress(ident.toLowerCase()) && !isUsernameShape(ident)) return null;
  try {
    const r = await fetch(`${SERVER_HTTP}/players/${encodeURIComponent(ident)}`, {
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
  params: { ident: string };
}): Promise<Metadata> {
  const ident = params.ident;
  const lower = ident.toLowerCase();
  // Don't echo an unvalidated route param back into the title — a param that is
  // neither shape would render as mangled text like "notana…ress". The page
  // itself rejects these with its own message; the tab just says "Player".
  // Echoing `ident` below is safe ONLY because it has passed this gate.
  if (!isAddress(lower) && !isUsernameShape(ident)) {
    return { title: "Player", robots: { index: false } };
  }

  const profile = await fetchProfile(ident);
  // Prefer the handle, then the shortened address, then whatever legal thing was
  // asked for. A username the server doesn't know 404s the fetch, so this falls
  // back to a generic title rather than throwing — a crawler on a dead name must
  // not 500 the page.
  const label = profile?.username ?? (isAddress(lower) ? shortAddress(lower, "Player") : ident);

  const title = profile ? `${label} — ${profile.rating}` : label;
  const description = profile
    ? `${profile.games} games · ${profile.wins}W ${profile.losses}L ${profile.draws}D · rated ${profile.rating} on OpenChess.`
    : `Engine record and rating for ${label} on OpenChess.`;

  // One profile now has up to three URLs — /player/Alice, /player/alice and
  // /player/0xabc… all resolve — which without this declares three indexable
  // duplicates and keeps three `revalidate: 300` cache entries. Per SEGMENT, on
  // purpose: a canonical at the ROOT would be inherited by every route and
  // declare the whole site a duplicate of the homepage (see CLAUDE.md). Nothing
  // else catches this, since all three URLs render correctly.
  const canonical = `${SITE_URL}/player/${profile?.username ?? profile?.address ?? lower}`;

  return { title, description, alternates: { canonical }, openGraph: { title, description } };
}

export default function PlayerLayout({ children }: { children: React.ReactNode }) {
  return children;
}
