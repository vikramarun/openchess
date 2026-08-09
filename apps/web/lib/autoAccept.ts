"use client";

/** localStorage key for "skip the pre-game confirmation". */
const PREF_KEY = "openchess.autoAccept";

/** Is the player opting out of the pre-game stakes confirmation?
 *
 *  Read imperatively rather than through a hook: the caller is the seat's
 *  socket handler, which decides whether to prompt at the moment `welcome`
 *  arrives — long after any render. */
export function autoAcceptEnabled(): boolean {
  try {
    return window.localStorage.getItem(PREF_KEY) === "1";
  } catch {
    return false; // private mode / storage disabled — prompt, don't assume
  }
}

export function setAutoAccept(on: boolean): void {
  try {
    window.localStorage.setItem(PREF_KEY, on ? "1" : "0");
  } catch {
    /* ignore — the preference just won't stick */
  }
}
