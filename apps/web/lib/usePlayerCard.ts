"use client";

import { useEffect, useState } from "react";

import { isAddress } from "./address";
import { AVATAR_EVENT, avatarUrl } from "./avatar";
import { SERVER_HTTP } from "./config";
import { USERNAME_EVENT } from "./usernameApi";

export type PlayerCard = {
  /** Uploaded photo URL, or null when the wallet has none. */
  photo: string | null;
  /** Claimed handle, or null. */
  username: string | null;
};

const EMPTY: PlayerCard = { photo: null, username: null };

/** A wallet's header identity: its photo and its handle.
 *
 *  One request for both, because both come off the same `/players/{addr}` row —
 *  a second hook polling the identical endpoint for the other half would double
 *  the header's traffic to say one thing.
 *
 *  Reactive to the wallet changing and to either field being changed elsewhere
 *  in the app: the header chip and the profile head sit in different branches of
 *  the tree, so an edit on `/profile` has no other way to reach the header.
 *  Components that already fetch the profile JSON (`ProfileStats`) should read
 *  the fields off it rather than call this and fetch it twice. */
export function usePlayerCard(address: string | undefined): PlayerCard {
  const [card, setCard] = useState<PlayerCard>(EMPTY);

  useEffect(() => {
    const addr = address?.toLowerCase();
    if (!isAddress(addr)) {
      setCard(EMPTY);
      return;
    }
    let live = true;
    const load = async () => {
      try {
        const r = await fetch(`${SERVER_HTTP}/players/${encodeURIComponent(addr)}`);
        const p = r.ok ? await r.json() : null;
        if (live) {
          setCard({
            photo: avatarUrl(addr, p?.avatar_updated_at),
            username: typeof p?.username === "string" ? p.username : null,
          });
        }
      } catch {
        // A header decoration is never worth surfacing an error for; the pawn
        // and the short address are fine answers to "the server didn't respond".
        if (live) setCard(EMPTY);
      }
    };
    void load();
    window.addEventListener(AVATAR_EVENT, load);
    window.addEventListener(USERNAME_EVENT, load);
    return () => {
      live = false;
      window.removeEventListener(AVATAR_EVENT, load);
      window.removeEventListener(USERNAME_EVENT, load);
    };
  }, [address]);

  return card;
}
