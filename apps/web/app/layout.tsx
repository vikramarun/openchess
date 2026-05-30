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
  // Subresource Integrity: a CDN compromise can't inject altered CSS.
  return (
    <html lang="en">
      <head>
        <link
          rel="stylesheet"
          href={`${cg}/chessground.base.css`}
          integrity="sha384-xC640aoNTmtjZ0u134MQFxX+je+vedHUFNkXCvU7TQRU6ZJgXpTl8bUDKaIDraBz"
          crossOrigin="anonymous"
        />
        <link
          rel="stylesheet"
          href={`${cg}/chessground.brown.css`}
          integrity="sha384-FNiviQs+kF/vWoOm7Bi/QYTWBeQIH/DskHImXQ5g6zGjcJwj1eoUahVUSwYEXfH1"
          crossOrigin="anonymous"
        />
        <link
          rel="stylesheet"
          href={`${cg}/chessground.cburnett.css`}
          integrity="sha384-t0l6ORC8cGo8/GMWCsKb4kVgvWzfwkDU8W9CXOh6Ai8dvgfMdhWl5UYMddaI835A"
          crossOrigin="anonymous"
        />
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
