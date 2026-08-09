import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Customize",
  description:
    "Your profile, board and piece themes, browser bot settings, and engine pairing.",
  // Signed-in settings, not a landing page. robots.ts disallows it too; this
  // covers a crawler that reaches the URL without reading robots.txt.
  robots: { index: false, follow: false },
};

export default function ProfileLayout({ children }: { children: React.ReactNode }) {
  return children;
}
