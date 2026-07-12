"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";

import { SERVER_HTTP } from "@/lib/config";
import { authToken } from "@/lib/escrow";
import { useMaintenance } from "@/lib/maintenance";

/** Mount gate: the wagmi hook lives in the inner component, which only renders
 *  on the client where the (client-only) WagmiProvider is present. */
export function MaintenanceBanner() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return <MaintenanceBannerInner />;
}

/** Global maintenance strip. Everyone sees the banner while the server drains;
 *  the escrow owner additionally gets a toggle to start/stop the drain. */
function MaintenanceBannerInner() {
  const { address, isConnected } = useAccount();
  const { maintenance, adminWallet, refresh } = useMaintenance();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isAdmin =
    isConnected && !!address && !!adminWallet && address.toLowerCase() === adminWallet;

  // Nothing to show for a normal visitor when the server is up.
  if (!maintenance && !isAdmin) return null;

  async function toggle(on: boolean) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`${SERVER_HTTP}/admin/maintenance`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authToken() ?? ""}`,
        },
        body: JSON.stringify({ on }),
      });
      if (!r.ok) {
        setErr(
          r.status === 403
            ? "Not authorized — sign in with the owner wallet."
            : `Failed (${r.status}).`,
        );
        return;
      }
      await refresh();
    } catch {
      setErr("Network error.");
    } finally {
      setBusy(false);
    }
  }

  // Owner-only slim bar when the server is running normally.
  if (!maintenance) {
    return (
      <div className="maint-bar maint-admin">
        <span className="maint-muted">Owner controls</span>
        <button className="maint-btn" disabled={busy} onClick={() => toggle(true)}>
          {busy ? "…" : "Pause new games"}
        </button>
        {err && <span className="maint-err">{err}</span>}
      </div>
    );
  }

  return (
    <div className="maint-bar maint-on">
      <span className="maint-msg">
        <strong>Maintenance mode.</strong> No new games can be started — games
        already in progress will finish normally.
      </span>
      {isAdmin && (
        <>
          <button className="maint-btn" disabled={busy} onClick={() => toggle(false)}>
            {busy ? "…" : "Resume"}
          </button>
          {err && <span className="maint-err">{err}</span>}
        </>
      )}
    </div>
  );
}
