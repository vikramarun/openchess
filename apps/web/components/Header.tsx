"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useEngine } from "@/lib/engineContext";
import { AuthButton } from "./AuthButton";
import { Logo } from "./Logo";
import { activeTab } from "./TabBar";
import { WalletMenu } from "./WalletMenu";

/** The desktop navigation. Below 720px `.nav` is display:none and
 *  components/TabBar.tsx takes over — see the ≤720px block in globals.css.
 *
 *  Six destinations here against the tab bar's five: Gauntlet gets its own link
 *  where there is room for it, and folds under the tab bar's "Events" where
 *  there isn't. `activeTab` is shared with the bar so both agree on which
 *  section a route belongs to; the extra Gauntlet entry is highlighted on its
 *  own path instead. */
const LINKS: { href: string; label: string }[] = [
  { href: "/", label: "Play" },
  { href: "/lobby", label: "Lobby" },
  { href: "/gauntlet", label: "Gauntlet" },
  { href: "/tournament", label: "Tournament" },
  { href: "/play", label: "Test Engine" },
  { href: "/profile", label: "Customize" },
];

export function Header() {
  const { status } = useEngine();
  const pathname = usePathname() ?? "/";
  const section = activeTab(pathname);
  const label =
    status === "ready"
      ? "Engine ready"
      : status === "loading"
        ? "Loading engine…"
        : status === "error"
          ? "Engine failed"
          : "Engine";

  const isOn = (href: string) =>
    // Gauntlet is not a tab of its own, so activeTab folds it into /tournament.
    // Here it has its own link and has to win on its own path, or /gauntlet
    // would light Tournament instead.
    href === "/gauntlet" ? pathname === "/gauntlet" : section === href && pathname !== "/gauntlet";

  return (
    <header className="site-header">
      {/* Inner wrapper so the brand lines up with .container's column while the
          header's background and bottom border stay full-bleed. .brand / .nav /
          .header-actions are unchanged flex children — this is their flex parent
          now instead of <header> itself. */}
      <div className="header-inner">
        <Link href="/" className="brand">
          <Logo size={22} className="mark" /> OpenChess
        </Link>
        <nav className="nav" aria-label="Main">
          {LINKS.map(({ href, label: text }) => (
            <Link
              key={href}
              href={href}
              className={isOn(href) ? "on" : undefined}
              aria-current={isOn(href) ? "page" : undefined}
            >
              {text}
            </Link>
          ))}
        </nav>
        <div className="header-actions">
          <span className="engine-pill" title="Stockfish runs in your browser, free">
            <span className={`dot ${status}`} /> {label}
          </span>
          <WalletMenu />
          <AuthButton />
        </div>
      </div>
    </header>
  );
}
