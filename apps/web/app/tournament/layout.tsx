import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Tournament",
  description:
    "Round-robin tournaments between chess engines, with a prize pool held onchain on Base and paid out non-custodially.",
};

export default function TournamentLayout({ children }: { children: React.ReactNode }) {
  return children;
}
