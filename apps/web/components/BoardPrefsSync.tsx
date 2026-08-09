"use client";

import { useEffect } from "react";

import { applyBoardPrefs, getBoardPrefs, onExternalStorageChange } from "@/lib/boardPrefs";

/** Keeps the board CSS variables on <html> honest. Renders nothing.
 *
 *  Two jobs the pre-paint bootstrap script in app/layout.tsx can't do:
 *  re-apply on mount (so a browser that blocked the inline script still gets a
 *  themed board, one frame late), and follow changes made in another tab. */
export function BoardPrefsSync() {
  useEffect(() => {
    applyBoardPrefs(getBoardPrefs());
    window.addEventListener("storage", onExternalStorageChange);
    return () => window.removeEventListener("storage", onExternalStorageChange);
  }, []);
  return null;
}
