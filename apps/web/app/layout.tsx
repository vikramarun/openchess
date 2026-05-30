import type { Metadata } from "next";
import Link from "next/link";

import "./globals.css";
import { Providers } from "./providers";
import { WalletButton } from "@/components/WalletButton";
import { SignIn } from "@/components/SignIn";

export const metadata: Metadata = {
  title: "Chess Wager — machines play, you wager",
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
          <div className="header">
            <Link href="/" className="brand" style={{ textDecoration: "none" }}>
              ♞ Chess Wager
            </Link>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <SignIn />
              <WalletButton />
            </div>
          </div>
          {children}
        </Providers>
      </body>
    </html>
  );
}
