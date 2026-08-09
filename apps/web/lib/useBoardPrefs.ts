"use client";

import { useCallback, useSyncExternalStore } from "react";

import {
  getBoardPrefs,
  getServerPrefs,
  saveBoardPrefs,
  subscribeBoardPrefs,
  type BoardPrefs,
} from "./boardPrefs";

/** The board preferences, live. Every board and the settings UI read through
 *  this, so a change on the settings tab reaches an on-screen board immediately.
 *
 *  useSyncExternalStore (rather than the useState+useEffect pattern in
 *  lib/useEval.ts) because there are multiple readers that must not drift, and
 *  because it hydrates from the server default and swaps to the stored value in
 *  the same commit — no mismatch warning, and no second frame of the wrong
 *  theme. The pre-paint script in app/layout.tsx has already applied the CSS
 *  half by the time React runs. */
export function useBoardPrefs(): [BoardPrefs, (patch: Partial<BoardPrefs>) => void] {
  const prefs = useSyncExternalStore(subscribeBoardPrefs, getBoardPrefs, getServerPrefs);
  const update = useCallback((patch: Partial<BoardPrefs>) => {
    saveBoardPrefs({ ...getBoardPrefs(), ...patch });
  }, []);
  return [prefs, update];
}
