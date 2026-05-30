"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";

import { BrowserEngine } from "@/lib/engine";

type Status = "idle" | "loading" | "ready" | "error";
type Ctx = { status: Status; engine: BrowserEngine | null; load: () => void };

const EngineCtx = createContext<Ctx>({ status: "idle", engine: null, load: () => {} });
export const useEngine = () => useContext(EngineCtx);

/** Provides a singleton in-browser engine ("your engine"). Auto-loads on mount
 *  because it's free — it runs on the user's CPU, not our servers. */
export function EngineProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("idle");
  const [engine, setEngine] = useState<BrowserEngine | null>(null);
  const started = useRef(false);

  const load = () => {
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
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <EngineCtx.Provider value={{ status, engine, load }}>{children}</EngineCtx.Provider>
  );
}
