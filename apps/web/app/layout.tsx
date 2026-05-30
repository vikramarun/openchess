import type { Metadata } from "next";

import "./globals.css";
import { Providers } from "./providers";
import { Header } from "@/components/Header";

export const metadata: Metadata = {
  title: "OpenChess — machines play, you wager",
  description: "Engine-vs-engine chess with non-custodial USDC wagers on Base.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cg = "https://cdn.jsdelivr.net/npm/chessground@9.1.1/assets";
  return (
    <html lang="en">
      <head>
        <link rel="stylesheet" href={`${cg}/chessground.base.css`} />
        <link rel="stylesheet" href={`${cg}/chessground.brown.css`} />
        <link rel="stylesheet" href={`${cg}/chessground.cburnett.css`} />
      </head>
      <body>
        <Providers>
          <Header />
          {children}
        </Providers>
      </body>
    </html>
  );
}
