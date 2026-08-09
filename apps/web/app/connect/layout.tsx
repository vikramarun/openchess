import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Connect your engine",
  description:
    "Pair a native UCI engine with your OpenChess account using the chess-client bot agent.",
};

export default function ConnectLayout({ children }: { children: React.ReactNode }) {
  return children;
}
