"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";

import { BrowserEngine } from "@/lib/engine";

type Status = "idle" | "loading" | "ready" | "error";
type Ctx = { status: Status; engine: BrowserEngine | null; load: () => void };

const EngineCtx = createContext<Ctx>({ status: "idle", engine: null, load: () => {} });
export const useEngine = () => useContext(EngineCtx);

/** Provides a singleton in-browser engine ("your engine"), loaded on demand via
 *  `load()` — NOT on mount. The download is ~7 MB, and most routes never
 *  search: a visitor browsing the lobby, or a phone opening a shared game
 *  link, shouldn't pay for it. The eval bar calls `load()` when it's actually
 *  on. Seat play warms its own engine (lib/playerEngine.ts, before money is
 *  committed), so no money path depends on this one. */
export function EngineProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("idle");
  const [engine, setEngine] = useState<BrowserEngine | null>(null);
  const started = useRef(false);

  const load = useCallback(() => {
    if (started.current) return;
    started.current = true;
    setStatus("loading");
    try {
      const e = new BrowserEngine();
      e.whenReady()
        .then(() => {
          setEngine(e);
          setStatus("ready");
        })
        .catch(() => setStatus("error"));
    } catch {
      setStatus("error");
    }
  }, []);

  return (
    <EngineCtx.Provider value={{ status, engine, load }}>{children}</EngineCtx.Provider>
  );
}
