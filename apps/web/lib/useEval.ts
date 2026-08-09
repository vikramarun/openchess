"use client";

import { useCallback, useEffect, useState } from "react";

import { sideToMoveFromFen } from "./board";
import { useEngine } from "./engineContext";
import { toWhiteRelative, type EvalScore } from "./evalScore";

/** localStorage key for the viewer's eval-bar preference. */
const PREF_KEY = "openchess.evalBar";

/** The eval-bar on/off preference, persisted per browser. Starts from the
 *  default on the server render and adopts the stored value after mount, so
 *  hydration can't mismatch. */
export function useEvalPref(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(true);
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(PREF_KEY);
      if (v !== null) setOn(v === "1");
    } catch {
      /* private mode / storage disabled — keep the default */
    }
  }, []);
  const set = useCallback((next: boolean) => {
    setOn(next);
    try {
      window.localStorage.setItem(PREF_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, []);
  return [on, set];
}

export type EvalState = {
  /** White-relative score, or null before the first result / when off. */
  score: EvalScore | null;
  /** A search for the current position is in flight. */
  thinking: boolean;
  /** The in-browser engine is still loading (first visit downloads ~7 MB). */
  loading: boolean;
  /** The engine failed to load — callers should hide the bar entirely. */
  failed: boolean;
};

/** Evaluate `fen` with the shared in-browser Stockfish, restarting whenever the
 *  viewed position changes. This runs on the VIEWER's CPU (the whole point of
 *  the browser engine), so it is opt-outable and pauses while the tab is hidden.
 *
 *  A seat that is actually playing gets most of its bar for free from the engine
 *  already playing its move (`onEval` in lib/play.ts → SeatGame) and uses this
 *  only while that engine is idle — searching here during our own turn would
 *  take CPU from the engine whose move quality, and stake, is on the line. All
 *  callers share the `useEvalPref` switch, so the bar follows the viewer. */
export function useEval(fen: string | null, enabled: boolean): EvalState {
  const { engine, status, load } = useEngine();
  const [score, setScore] = useState<EvalScore | null>(null);
  const [thinking, setThinking] = useState(false);
  const [visible, setVisible] = useState(true);

  // The shared engine is lazy (see engineContext); an enabled bar is a real
  // consumer, so it triggers the download.
  useEffect(() => {
    if (enabled) load();
  }, [enabled, load]);

  useEffect(() => {
    const sync = () => setVisible(!document.hidden);
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setScore(null);
      setThinking(false);
      return;
    }
    if (!engine || !fen || !visible) {
      setThinking(false);
      return;
    }
    const turn = sideToMoveFromFen(fen);
    let live = true;
    let handle: { stop: () => void } | null = null;
    setThinking(true);
    // Debounce: holding ◀/▶ through a move list would otherwise start (and
    // immediately supersede) a search per keypress.
    const timer = setTimeout(() => {
      handle = engine.analyse(fen, {
        onInfo: (info) => {
          if (live) setScore(toWhiteRelative(info, turn));
        },
        onDone: () => {
          if (live) setThinking(false);
        },
      });
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
      handle?.stop();
    };
    // The previous position's score stays on the bar until the new one reports,
    // which reads as the bar animating rather than snapping to level.
  }, [engine, fen, enabled, visible]);

  return {
    score,
    thinking,
    loading: status === "loading" || status === "idle",
    failed: status === "error",
  };
}
