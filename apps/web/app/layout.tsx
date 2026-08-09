import type { Metadata, Viewport } from "next";
import { Noto_Sans } from "next/font/google";

import "./globals.css";
// chessground's structural CSS, vendored (its package "exports" map makes the
// published assets unreachable by import). board.css supplies the theme half —
// the board squares and piece art it would otherwise hardcode.
import "./chessground.base.css";
import "./board.css";
import { Providers } from "./providers";
import { BoardPrefsSync } from "@/components/BoardPrefsSync";
import { Header } from "@/components/Header";
import { MaintenanceBanner } from "@/components/MaintenanceBanner";
import { SiteFooter } from "@/components/SiteFooter";
import { boardBootstrapScript } from "@/lib/boardBootstrap";
import {
  BRAND_NAME,
  MARK_TILE,
  SITE_DESCRIPTION,
  SITE_TITLE,
  SITE_URL,
} from "@/lib/brand";

// globals.css has named "Noto Sans" as the first family since the UI was
// written, but nothing ever loaded it — no next/font, no @font-face, no link
// tag — so every visitor silently fell through to the system stack and the site
// rendered in SF Pro or Segoe UI depending on their OS. This loads it for real.
//
// next/font self-hosts: the file is fetched once at build time and served from
// our own origin, so there is no runtime request to Google and `font-src 'self'`
// in next.config.mjs needs no new entry. The variable axis covers 400/600/700/800
// (every weight globals.css asks for) in one file rather than four.
//
// display: "swap" is the deliberate choice for a site that shows a clock: text
// paints immediately in the fallback and reflows when the font lands, rather
// than blocking on it.
const notoSans = Noto_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

export const metadata: Metadata = {
  // Required, and not optional in practice: without it every relative OG and
  // icon URL resolves against localhost:3000, so production would advertise
  // images nobody can fetch.
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_TITLE,
    // Each route supplies only its own name; see the per-segment layouts.
    template: `%s · ${BRAND_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: BRAND_NAME,
  keywords: [
    "chess",
    "chess engine",
    "engine vs engine",
    "UCI",
    "Stockfish",
    "computer chess",
    "USDC",
    "Base",
    "onchain",
    "non-custodial",
  ],
  authors: [{ name: BRAND_NAME, url: SITE_URL }],
  creator: BRAND_NAME,
  publisher: BRAND_NAME,
  manifest: "/manifest.webmanifest",
  // Deliberately NO `alternates.canonical` here. Metadata merges down the tree,
  // so a canonical set at the root is inherited by every route that does not
  // override it — which would declare /gauntlet, /tournament and the rest
  // duplicates of the homepage and stop them being indexed separately. If a
  // self-referencing canonical is ever wanted, it has to be set per segment.
  openGraph: {
    type: "website",
    siteName: BRAND_NAME,
    url: SITE_URL,
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
};

// Next 14 wants these out of `metadata`. The app is dark-only — there is no
// prefers-color-scheme handling anywhere in globals.css — so declaring the
// scheme stops the browser from rendering form controls and scrollbars light.
export const viewport: Viewport = {
  themeColor: MARK_TILE,
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // suppressHydrationWarning is for the bootstrap script below: it stamps a
    // style attribute (and data-coords) on <html> before React hydrates, which
    // the server render has no way to predict. It suppresses one level only, so
    // a real mismatch anywhere inside the page still reports.
    // The font class only defines --font-sans; globals.css is what applies it,
    // so the whole cascade (including the vendored chessground CSS) picks it up
    // from one place. Safe alongside the bootstrap script below, which writes a
    // style attribute rather than a class.
    <html lang="en" className={notoSans.variable} suppressHydrationWarning>
      <head>
        {/* Stamps the saved board theme onto <html> before the first paint, so a
            themed board never flashes brown on the way in. Must stay inline and
            in <head>: localStorage is client-only, and React runs too late. */}
        <script dangerouslySetInnerHTML={{ __html: boardBootstrapScript() }} />
      </head>
      <body>
        <Providers>
          <BoardPrefsSync />
          <Header />
          <MaintenanceBanner />
          {children}
          {/* On every route, not just the homepage: the escrow link and the
              "stakes are real money" line must reach people who land straight
              on a shared game, a profile, or the gauntlet. */}
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
