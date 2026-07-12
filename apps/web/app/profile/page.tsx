"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAccount } from "wagmi";

import { BrowserBotPanel } from "@/components/BrowserBotPanel";
import { ConnectEngine } from "@/components/ConnectEngine";
import { ProfileStats } from "@/components/ProfileStats";

export default function ProfilePage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <div className="container">
      <div className="hero" style={{ paddingBottom: 8 }}>
        <h1>My Profile</h1>
      </div>
      {mounted ? <ProfileClient /> : null}
    </div>
  );
}

const headingStyle = { margin: "28px 0 4px", color: "var(--text-strong)", fontSize: 22 } as const;

function ProfileClient() {
  const { address, isConnected } = useAccount();
  const router = useRouter();
  const [addr, setAddr] = useState("");

  const lookup = () => {
    const a = addr.trim();
    if (a) router.push(`/player/${a}`);
  };

  return (
    <>
      {isConnected && address ? (
        <ProfileStats address={address} />
      ) : (
        <div className="panel">
          <b style={{ color: "var(--text-strong)" }}>Sign in to see your profile</b>
          <div className="muted" style={{ marginTop: 6 }}>
            Connect your wallet (top right) to view your rating, game history, and net winnings.
          </div>
        </div>
      )}

      {/* Engine: how the bot that plays your seats is configured. */}
      <h2 style={headingStyle}>Engine</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Set up the bot that plays your seats — a full-strength engine in your browser, or your own
        engine running on your machine.
      </p>
      <BrowserBotPanel />
      <h3 style={{ margin: "20px 0 8px", color: "var(--text-strong)", fontSize: 17 }}>
        Bring your own engine
      </h3>
      <ConnectEngine />

      {/* Look up any player by wallet. */}
      <h2 style={headingStyle}>Look up a player</h2>
      <div
        className="panel"
        style={{ display: "flex", gap: 10, alignItems: "center" }}
      >
        <span className="muted">Wallet address:</span>
        <input
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          placeholder="0x… wallet address"
          style={{ flex: 1 }}
          onKeyDown={(e) => e.key === "Enter" && lookup()}
        />
        <button className="ghost" onClick={lookup}>
          View profile
        </button>
      </div>
    </>
  );
}
