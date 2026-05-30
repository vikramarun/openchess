"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAccount } from "wagmi";

/** "My Profile" link, shown once a wallet is connected. The wagmi hook lives in
 *  the inner component so it only runs client-side (inside WagmiProvider). */
export function ProfileLink() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return <ProfileLinkInner />;
}

function ProfileLinkInner() {
  const { address, isConnected } = useAccount();
  if (!isConnected || !address) return null;
  return (
    <Link href={`/player/${address}`} style={{ color: "var(--text)", fontWeight: 600 }}>
      My&nbsp;Profile
    </Link>
  );
}
