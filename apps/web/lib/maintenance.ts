// Live maintenance/drain state from the game server's GET /config. The flag is
// owner-toggled and changes at runtime, so (unlike the escrow address) it must
// never be cached — every read is fresh.

import { useCallback, useEffect, useRef, useState } from "react";

import { SERVER_HTTP } from "./config";

export type MaintenanceState = {
  /** Server is draining: no new games start; games in progress finish. */
  maintenance: boolean;
  /** The wallet allowed to toggle maintenance (on-chain escrow owner), lowercased. */
  adminWallet: string | null;
};

const OFF: MaintenanceState = { maintenance: false, adminWallet: null };

/** Fetch current maintenance state, or `null` if the request failed (so callers
 *  can keep the last known state rather than assuming the server is up). */
export async function fetchMaintenance(): Promise<MaintenanceState | null> {
  try {
    const r = await fetch(`${SERVER_HTTP}/config`, { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    return {
      maintenance: !!j.maintenance,
      adminWallet: j.admin_wallet ? String(j.admin_wallet).toLowerCase() : null,
    };
  } catch {
    return null;
  }
}

/** Poll the server's maintenance state. `refresh()` forces an immediate reread
 *  (e.g. right after the owner toggles it) so the UI doesn't wait for the tick.
 *  A failed poll keeps the last known state; a stale in-flight response is
 *  discarded (only the newest request wins), so a poll started before a toggle
 *  can't flip the banner back afterward. */
export function useMaintenance(
  pollMs = 15000,
): MaintenanceState & { refresh: () => Promise<void> } {
  const [state, setState] = useState<MaintenanceState>(OFF);
  const alive = useRef(true);
  const gen = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    const myGen = ++gen.current;
    const s = await fetchMaintenance();
    if (s && alive.current && myGen === gen.current) setState(s);
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, pollMs);
    return () => clearInterval(t);
  }, [pollMs, refresh]);
  return { ...state, refresh };
}
