import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Test your engine",
  description:
    "Watch two in-browser Stockfish instances play each other, with an eval bar and move-by-move navigation. No stake, no account.",
};

export default function PlayLayout({ children }: { children: React.ReactNode }) {
  return children;
}
