// Live maintenance/drain state from the game server's GET /config. The flag is
// owner-toggled and changes at runtime, so (unlike the escrow address) it must
// never be cached — every read is fresh.

import { useCallback, useEffect, useState } from "react";

import { SERVER_HTTP } from "./config";

export type MaintenanceState = {
  /** Server is draining: no new games start; games in progress finish. */
  maintenance: boolean;
  /** The wallet allowed to toggle maintenance (on-chain escrow owner), lowercased. */
  adminWallet: string | null;
};

const OFF: MaintenanceState = { maintenance: false, adminWallet: null };

export async function fetchMaintenance(): Promise<MaintenanceState> {
  try {
    const r = await fetch(`${SERVER_HTTP}/config`, { cache: "no-store" });
    const j = await r.json();
    return {
      maintenance: !!j.maintenance,
      adminWallet: j.admin_wallet ? String(j.admin_wallet).toLowerCase() : null,
    };
  } catch {
    return OFF;
  }
}

/** Poll the server's maintenance state. `refresh()` forces an immediate reread
 *  (e.g. right after the owner toggles it) so the UI doesn't wait for the tick. */
export function useMaintenance(pollMs = 4000): MaintenanceState & { refresh: () => Promise<void> } {
  const [state, setState] = useState<MaintenanceState>(OFF);
  const refresh = useCallback(async () => {
    setState(await fetchMaintenance());
  }, []);
  useEffect(() => {
    let alive = true;
    const tick = () => fetchMaintenance().then((s) => alive && setState(s));
    tick();
    const t = setInterval(tick, pollMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [pollMs]);
  return { ...state, refresh };
}
