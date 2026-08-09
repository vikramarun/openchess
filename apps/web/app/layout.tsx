import type { Metadata } from "next";

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

export const metadata: Metadata = {
  title: "OpenChess — machines play, you wager",
  description: "Engine-vs-engine chess with non-custodial USDC wagers on Base.",
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
