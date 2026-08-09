"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useAccount } from "wagmi";

import { BoardSettings } from "@/components/BoardSettings";
import { BrowserBotPanel } from "@/components/BrowserBotPanel";
import { ConnectEngine } from "@/components/ConnectEngine";
import { PlayerSearch } from "@/components/PlayerSearch";
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
      <div className="page-head">
        <h1 className="display d2">Customize</h1>
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
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    const sync = () => setTab(tabFromHash());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const select = (id: TabId) => {
    setTab(id);
    // replaceState, not a hash assignment: this shouldn't stack a history entry
    // per tab click and make Back walk through them. Keep pathname + search so
    // landing here with a query string doesn't lose it on the first tab click.
    const bare = window.location.pathname + window.location.search;
    window.history.replaceState(null, "", id === "profile" ? bare : `${bare}#${id}`);
  };

  // Roving tabindex: a tablist takes ONE tab stop, and arrows move within it.
  // Without this the roles below would announce a tab widget that then behaves
  // like a row of ordinary buttons.
  const onKeyDown = (e: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const to =
      e.key === "ArrowRight" ? (i + 1) % TABS.length
      : e.key === "ArrowLeft" ? (i - 1 + TABS.length) % TABS.length
      : e.key === "Home" ? 0
      : e.key === "End" ? TABS.length - 1
      : -1;
    if (to < 0) return;
    e.preventDefault();
    select(TABS[to].id);
    tabRefs.current[to]?.focus();
  };

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Customize" onKeyDown={onKeyDown}>
        {TABS.map((t, i) => (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            // Only the selected tab's panel is mounted, so only it can name a
            // panel: an aria-controls pointing at an id that isn't in the
            // document is worse than none at all.
            aria-controls={tab === t.id ? `panel-${t.id}` : undefined}
            tabIndex={tab === t.id ? 0 : -1}
            className={`tab${tab === t.id ? " on" : ""}`}
            onClick={() => select(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Only the selected panel is mounted, rather than all three with the
          inactive ones hidden (the ARIA APG shape). Mounting them all would keep
          a second chessground instance and ConnectEngine alive permanently, for
          tabs nobody is looking at.
          No tabIndex: every panel here already contains focusable controls, so
          making the panel itself a tab stop would just add a dead one. */}
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "profile" && <ProfileTab />}
        {tab === "settings" && <BoardSettings />}
        {tab === "advanced" && <AdvancedTab />}
      </div>
    </>
  );
}

function ProfileTab() {
  const { address, isConnected } = useAccount();

  return (
    <>
      {isConnected && address ? (
        <ProfileStats ident={address} editable />
      ) : (
        <div className="panel">
          <b style={{ color: "var(--text-strong)" }}>Sign in to see your profile</b>
          <div className="muted" style={{ marginTop: 6 }}>
            Connect your wallet (top right) to view your rating, game history, and net USDC.
          </div>
        </div>
      )}

      {/* Look up any player by username, or paste a wallet. */}
      <h2 style={headingStyle}>Find a player</h2>
      <div className="panel">
        <PlayerSearch />
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
        Set up the bot that plays your seats: a full-strength engine in your browser, or your own
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
