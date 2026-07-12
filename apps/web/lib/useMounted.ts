"use client";

import { useEffect, useState } from "react";

/** True only after the first client render. Used to gate components that touch
 *  browser-only APIs or the client-only WagmiProvider (see app/providers.tsx),
 *  so their markup matches during SSR / static prerender. */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
