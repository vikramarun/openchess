"use client";

import { useEffect, useState } from "react";

import { fetchConfig, type OnchainConfig } from "./escrow";

/** The server's onchain config (escrow address + expected chain + wager flag),
 *  shared by the header and every wager surface. `wagerOn` is the single source
 *  of the "wagering is live" gate — escrow configured AND enabled — instead of
 *  each page re-deriving it. A successful fetch is module-memoized; a failed
 *  one retries with backoff, because the header mounts once per tab and a
 *  page load during a server deploy must not hide the wallet all session. */
export function useOnchainConfig(): { config: OnchainConfig | null; wagerOn: boolean } {
  const [config, setConfig] = useState<OnchainConfig | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delay = 2000;
    const attempt = () => {
      fetchConfig().then((c) => {
        if (!live) return;
        if (c) {
          setConfig(c);
        } else {
          timer = setTimeout(attempt, delay);
          delay = Math.min(delay * 2, 30_000);
        }
      });
    };
    attempt();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, []);
  const wagerOn = !!config?.wagerEnabled && !!config?.escrow;
  return { config, wagerOn };
}
