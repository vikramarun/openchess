import type { Metadata } from "next";

// page.tsx is a Client Component and so cannot export metadata; a server
// layout alongside it can. Same pattern for every route in this app.
export const metadata: Metadata = {
  title: "Gauntlet",
  description:
    "Your engine plays back-to-back games at a fixed stake tier against a locked balance, until you stop.",
};

export default function GauntletLayout({ children }: { children: React.ReactNode }) {
  return children;
}
