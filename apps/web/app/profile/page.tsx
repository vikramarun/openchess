"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAccount } from "wagmi";

import { BoardSettings } from "@/components/BoardSettings";
import { BrowserBotPanel } from "@/components/BrowserBotPanel";
import { ConnectEngine } from "@/components/ConnectEngine";
import { ProfileStats } from "@/components/ProfileStats";
import { useMounted } from "@/lib/useMounted";

const TABS = [
  { id: "profile", label: "Profile" },
  { id: "settings", label: "Settings" },
  { id: "advanced", label: "Advanced" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function tabFromHash(): TabId {
  const h = window.location.hash.replace("#", "");
  return TABS.some((t) => t.id === h) ? (h as TabId) : "profile";
}

export default function ProfilePage() {
  const mounted = useMounted();
  return (
    <div className="container">
      <div className="hero" style={{ paddingBottom: 8 }}>
        <h1>Customize</h1>
      </div>
      {mounted ? <ProfileClient /> : null}
    </div>
  );
}

const headingStyle = { margin: "28px 0 4px", color: "var(--text-strong)", fontSize: 22 } as const;

function ProfileClient() {
  // Seeded from the hash rather than useSearchParams, which would need a
  // Suspense boundary and force this page to render dynamically. Deep links like
  // /profile#settings still work.
  const [tab, setTab] = useState<TabId>(tabFromHash);

  useEffect(() => {
    const sync = () => setTab(tabFromHash());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const select = (id: TabId) => {
    setTab(id);
    // replaceState, not a hash assignment: this shouldn't stack a history entry
    // per tab click and make Back walk through them.
    window.history.replaceState(null, "", id === "profile" ? window.location.pathname : `#${id}`);
  };

  return (
    <>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            className={`tab${tab === t.id ? " on" : ""}`}
            onClick={() => select(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "profile" && <ProfileTab />}
      {tab === "settings" && <BoardSettings />}
      {tab === "advanced" && <AdvancedTab />}
    </>
  );
}

function ProfileTab() {
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

      {/* Look up any player by wallet. */}
      <h2 style={headingStyle}>Look up a player</h2>
      <div className="panel" style={{ display: "flex", gap: 10, alignItems: "center" }}>
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

function AdvancedTab() {
  return (
    <>
      {/* Engine: how the bot that plays your seats is configured. */}
      <h2 style={{ ...headingStyle, marginTop: 8 }}>Engine</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Set up the bot that plays your seats — a full-strength engine in your browser, or your own
        engine running on your machine.
      </p>
      <BrowserBotPanel />
      <h3 style={{ margin: "20px 0 8px", color: "var(--text-strong)", fontSize: 17 }}>
        Bring your own engine
      </h3>
      <ConnectEngine />
    </>
  );
}
