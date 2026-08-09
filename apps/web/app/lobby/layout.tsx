import type { Metadata } from "next";

// page.tsx is a Client Component and so cannot export metadata; a server
// layout alongside it can. Same pattern for every route in this app.
export const metadata: Metadata = {
  title: "Lobby",
  description:
    "Open challenges waiting for an opponent, games in progress you can watch, and the ranked ladder.",
};

export default function LobbyLayout({ children }: { children: React.ReactNode }) {
  return children;
}
