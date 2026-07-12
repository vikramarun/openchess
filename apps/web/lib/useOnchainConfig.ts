"use client";

import { useEffect, useState } from "react";

import { fetchConfig, type OnchainConfig } from "./escrow";

/** The server's on-chain config (escrow address + expected chain + wager flag),
 *  fetched once (fetchConfig is module-memoized) and shared by the header and
 *  every wager surface. `wagerOn` is the single source of the "wagering is live"
 *  gate — escrow configured AND enabled — instead of each page re-deriving it. */
export function useOnchainConfig(): { config: OnchainConfig | null; wagerOn: boolean } {
  const [config, setConfig] = useState<OnchainConfig | null>(null);
  useEffect(() => {
    fetchConfig().then(setConfig);
  }, []);
  const wagerOn = !!config?.wagerEnabled && !!config?.escrow;
  return { config, wagerOn };
}
