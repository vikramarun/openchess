"use client";

import Link from "next/link";

import { useEngine } from "@/lib/engineContext";
import { AuthButton } from "./AuthButton";
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
        <span className="king">♞</span> OpenChess
      </Link>
      <nav className="nav">
        <Link href="/">Play</Link>
        <Link href="/play">Quick&nbsp;Play</Link>
        <Link href="/profile">My&nbsp;Profile</Link>
      </nav>
      <div className="header-actions">
        <span className="engine-pill" title="Stockfish runs in your browser — free">
          <span className={`dot ${status}`} /> {label}
        </span>
        <WalletMenu />
        <AuthButton />
      </div>
    </header>
  );
}
