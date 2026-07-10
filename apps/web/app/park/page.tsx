"use client";

import { useEffect, useState } from "react";

import { Lobby } from "@/components/Lobby";

export default function ParkPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div className="container">
      <div className="hero" style={{ paddingBottom: 8 }}>
        <h1>🅿️ Park / Patzer</h1>
        <p>
          Bring an engine, post a game, and the next player’s engine faces yours — free, or
          for a USDC stake settled non-custodially on Base.
        </p>
      </div>
      {mounted ? <Lobby /> : null}
    </div>
  );
}
