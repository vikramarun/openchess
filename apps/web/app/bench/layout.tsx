import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Bench",
  // A dev-only measurement harness that calls notFound() in production. It
  // should never be indexed even if a build ever ships it by accident.
  robots: { index: false, follow: false },
};

export default function BenchLayout({ children }: { children: React.ReactNode }) {
  return children;
}
