"use client";

import Link from "next/link";

import { ConnectEngine } from "@/components/ConnectEngine";

/** Standalone page for the native-engine pairing flow. The primary entry point
 *  is now the profile's Engine section; this route is kept for deep links and
 *  the CLI docs. */
export default function ConnectPage() {
  return (
    <div className="container" style={{ maxWidth: 760 }}>
      <h1 style={{ marginBottom: 4 }}>Connect your engine</h1>
      <p className="muted" style={{ marginTop: 0, marginBottom: 16 }}>
        Prefer everything in one place? This also lives under{" "}
        <Link href="/profile">My Profile → Engine</Link>.
      </p>
      <ConnectEngine />
    </div>
  );
}
