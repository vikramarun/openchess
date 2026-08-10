"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";

import { IconBoard, IconChip, IconSwords, IconTrophy, IconUser } from "./icons";

/** The primary navigation on phones.
 *
 *  Below 1100px the header's `.nav` is `display: none` and this is the only way
 *  to reach four of the five destinations. It replaces a masked horizontal
 *  scroller whose last link ("Customize") sat 77px off the right edge at 375px
 *  — a destination you could only reach by discovering that a row with no
 *  scrollbar scrolls.
 *
 *  Labels are capped at 8 characters: five tabs on a 320px viewport is 64px
 *  each, and "Tournament" at 11px is ~66px and wraps. */
type Tab = {
  href: string;
  label: string;
  Icon: ComponentType<{ className?: string; size?: number }>;
  /** Extra path prefixes that light this tab. */
  also?: string[];
};

export const TABS: Tab[] = [
  { href: "/", label: "Play", Icon: IconBoard, also: ["/game"] },
  { href: "/lobby", label: "Lobby", Icon: IconSwords, also: ["/park"] },
  // Gauntlet and Tournament are both "compete for a pot", and five tabs is the
  // ceiling at 320px. Gauntlet keeps its own top-nav link on desktop and a card
  // on /lobby; here it lights Events rather than claiming a sixth slot.
  { href: "/tournament", label: "Events", Icon: IconTrophy, also: ["/gauntlet"] },
  { href: "/play", label: "Engine", Icon: IconChip, also: ["/connect", "/bench"] },
  { href: "/profile", label: "You", Icon: IconUser, also: ["/player"] },
];

/** Which tab a path belongs to, or null for a route that is on no tab.
 *
 *  Exported and pure so scripts/tabs.test.ts can check it without a DOM —
 *  nothing in this suite renders a page.
 *
 *  Two traps it encodes. "/" prefix-matches every route, so home is exact-match
 *  only and names /game explicitly. And `"/player/0xabc".startsWith("/play")`
 *  is TRUE — matching on the bare href would light "Engine" on every profile
 *  page in the app — which is why prefix matches require the trailing slash. */
export function activeTab(pathname: string): string | null {
  for (const t of TABS) {
    if (t.href === "/") {
      if (pathname === "/") return t.href;
    } else if (pathname === t.href || pathname.startsWith(`${t.href}/`)) {
      return t.href;
    }
    for (const p of t.also ?? []) {
      if (pathname === p || pathname.startsWith(`${p}/`)) return t.href;
    }
  }
  return null;
}

export function TabBar() {
  const pathname = usePathname() ?? "/";
  const active = activeTab(pathname);

  return (
    <nav className="tabbar" aria-label="Primary">
      {TABS.map(({ href, label, Icon }) => {
        const on = href === active;
        return (
          <Link
            key={href}
            href={href}
            className={`tabbar-item${on ? " on" : ""}`}
            aria-current={on ? "page" : undefined}
          >
            <Icon className="tabbar-icon" />
            <span className="tabbar-label">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
