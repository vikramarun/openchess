"use client";

import Link from "next/link";

import { useEngine } from "@/lib/engineContext";
import { AuthButton } from "./AuthButton";
import { Logo } from "./Logo";
import { WalletMenu } from "./WalletMenu";

export function Header() {
  const { status } = useEngine();
  const label =
    status === "ready"
      ? "Engine ready"
      : status === "loading"
        ? "Loading engine…"
        : status === "error"
          ? "Engine failed"
          : "Engine";
  return (
    <header className="site-header">
      <Link href="/" className="brand" style={{ textDecoration: "none" }}>
        <Logo size={22} className="mark" /> OpenChess
      </Link>
      <nav className="nav">
        <Link href="/">Play</Link>
        <Link href="/gauntlet">Gauntlet</Link>
        <Link href="/tournament">Tournament</Link>
        <Link href="/play">Test&nbsp;Engine</Link>
        <Link href="/profile">Customize</Link>
      </nav>
      <div className="header-actions">
        <span className="engine-pill" title="Stockfish runs in your browser, free">
          <span className={`dot ${status}`} /> {label}
        </span>
        <WalletMenu />
        <AuthButton />
      </div>
    </header>
  );
}
