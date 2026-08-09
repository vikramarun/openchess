import type { Metadata, Viewport } from "next";

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
import { boardBootstrapScript } from "@/lib/boardBootstrap";
import {
  BRAND_NAME,
  MARK_TILE,
  SITE_DESCRIPTION,
  SITE_TITLE,
  SITE_URL,
} from "@/lib/brand";

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
  alternates: { canonical: "/" },
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
    // style attribute on <html> before React hydrates, which the server render
    // has no way to predict. It suppresses one level only, so a real mismatch
    // anywhere inside the page still reports.
    <html lang="en" suppressHydrationWarning>
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
        </Providers>
      </body>
    </html>
  );
}
