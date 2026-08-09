"use client";

import { useEffect, useState } from "react";

import { isAddress } from "./address";
import { AVATAR_EVENT, avatarUrl } from "./avatar";
import { SERVER_HTTP } from "./config";

/** A wallet's uploaded profile photo URL, or null when it has none.
 *
 *  Reactive to the wallet changing and to the photo being replaced or removed
 *  elsewhere in the app — the header chip and the profile head are in different
 *  branches of the tree, so an upload on `/profile` has no other way to reach
 *  the header. Components that already fetch the profile JSON (ProfileStats)
 *  should read `avatar_updated_at` from it rather than call this and fetch it
 *  twice. */
export function useAvatar(address: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const addr = address?.toLowerCase();
    if (!isAddress(addr)) {
      setUrl(null);
      return;
    }
    let live = true;
    const load = async () => {
      try {
        const r = await fetch(`${SERVER_HTTP}/players/${encodeURIComponent(addr)}`);
        const p = r.ok ? await r.json() : null;
        if (live) setUrl(avatarUrl(addr, p?.avatar_updated_at));
      } catch {
        // A header decoration is never worth surfacing an error for; the pawn
        // fallback is a fine answer to "the server didn't respond".
        if (live) setUrl(null);
      }
    };
    void load();
    window.addEventListener(AVATAR_EVENT, load);
    return () => {
      live = false;
      window.removeEventListener(AVATAR_EVENT, load);
    };
  }, [address]);

  return url;
}
