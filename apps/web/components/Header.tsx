"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { AuthButton } from "./AuthButton";
import { Logo } from "./Logo";
import { activeTab } from "./TabBar";
import { WalletMenu } from "./WalletMenu";

/** The desktop navigation. Below 1100px `.nav` is display:none and
 *  components/TabBar.tsx takes over — see the ≤1100px block in globals.css.
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
  const pathname = usePathname() ?? "/";
  const section = activeTab(pathname);

  // Gauntlet is not a tab of its own, so activeTab folds it into /tournament.
  // Here it has its own link and has to win on its own path, or /gauntlet would
  // light Tournament instead. Prefix, not equality: on a future /gauntlet/<id>
  // an exact match would light NEITHER link — Tournament is suppressed and
  // Gauntlet wouldn't claim it.
  const onGauntlet = pathname === "/gauntlet" || pathname.startsWith("/gauntlet/");
  const isOn = (href: string) =>
    href === "/gauntlet" ? onGauntlet : section === href && !onGauntlet;

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
        {/* No engine-status pill here. It used to sit left of the wallet, and it
            was wrong twice over. It reported the SINGLETON eval engine
            (lib/engineContext), which most routes never load — so "Engine
            ready" on a page with an eval bar and a dim "Engine" everywhere
            else described a worker the visitor has no relationship with, not
            whether they can play. And it cost ~144px of a row that also has to
            hold six nav links, the wordmark, the bankroll pill and an account
            chip whose width is a username: signed in at 1100px the nav ran
            under it. Engine status now lives where an engine is the subject —
            /play's Test Engine card — and each seat reports its own
            (SeatGame's "Status:" line), which is the one a player is waiting
            on. */}
        <div className="header-actions">
          <WalletMenu />
          <AuthButton />
        </div>
      </div>
    </header>
  );
}
