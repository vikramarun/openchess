"use client";

import { useEffect, useSyncExternalStore } from "react";

/** Who is holding a live board open, so the sign-in gate knows when re-walling
 *  a page would kill one.
 *
 *  `RequireSignIn` re-walls a gated page whenever the visitor stops being
 *  signed in — that is what makes signing out actually sign you OUT of the
 *  lobby, whichever control did it (our own buttons, Dynamic's profile widget,
 *  a wallet-side disconnect, a 401 dropping the token). The one thing that must
 *  survive every one of those is a LIVE BOARD: `<SeatGame>` owns a socket, and
 *  a seat that is *gone* (rather than idle) hands the opponent a forfeit win
 *  and the whole stake (`room.rs reap_forfeit_winner`). So instead of trying to
 *  classify each way a session can die as "explicit" or "passive" — Dynamic's
 *  widget logout is indistinguishable from a MetaMask lock at our layer, so
 *  that classification cannot be made safely — the board itself declares that
 *  it exists, and the gate refuses to unlatch while any hold is open.
 *
 *  Module state, not context: the holder (`SeatGame`) and the reader
 *  (`RequireSignIn`) are far apart in the tree, and a game can be mounted by
 *  routes the gate doesn't wrap. Not persisted anywhere — a hold is exactly as
 *  alive as the component that took it. */
let holds = 0;

const EVENT = "openchess:live-seats";

function notify() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

/** Take a hold; returns a release that is safe to call more than once. */
export function acquireLiveSeat(): () => void {
  holds += 1;
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    notify();
  };
}

/** Declare "this component is a live board" for the life of the mount. */
export function useLiveSeatHold(): void {
  // An effect, not a render-time acquire: effects pair setup with cleanup
  // exactly once per mount even under Strict Mode's double-invoke.
  useEffect(() => acquireLiveSeat(), []);
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}

const getSnapshot = () => holds;
// The server renders no boards.
const getServerSnapshot = () => 0;

/** Reactive count of live boards. The gate re-renders when it changes, which is
 *  what lets the wall come back the moment a finished board unmounts. */
export function useLiveSeats(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
