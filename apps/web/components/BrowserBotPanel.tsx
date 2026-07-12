"use client";

import { useEffect, useRef, useState } from "react";

import {
  clearUserBook,
  DEFAULT_CONFIG,
  getBrowserBotConfig,
  saveBrowserBotConfig,
  saveUserBook,
  userBookInfo,
  type BookInfo,
  type BrowserBotConfig,
} from "@/lib/browserBot";

/** Shared small-button style used across this panel. */
const SMALL_BTN = { fontSize: 13, padding: "4px 10px" } as const;

/** Personalize the in-browser bot — a display name and an uploaded Polyglot
 *  opening book — with no download. Settings persist locally and apply to
 *  every browser-seat game. */
export function BrowserBotPanel({ onNameChange }: { onNameChange?: (name: string) => void }) {
  const [cfg, setCfg] = useState<BrowserBotConfig>(DEFAULT_CONFIG);
  const [book, setBook] = useState<BookInfo | null>(null);
  const [bookErr, setBookErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCfg(getBrowserBotConfig());
    userBookInfo().then(setBook);
  }, []);

  const update = (patch: Partial<BrowserBotConfig>) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    saveBrowserBotConfig(next);
    if (patch.name !== undefined) onNameChange?.(next.name);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBookErr(null);
    setBusy(true);
    try {
      setBook(await saveUserBook(file));
    } catch (e) {
      setBookErr(e instanceof Error ? e.message : "couldn't read that book");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <b style={{ color: "var(--text-strong)" }}>🤖 Your browser bot</b>
      <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
        Full-strength Stockfish 18 in your browser — no download. Give it a name and an opening
        book; applies to every game your browser plays.
      </div>

      <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
        <label className="muted" style={{ fontSize: 13 }}>
          Bot name (shown to opponents)
          <input
            placeholder="e.g. My Bot"
            value={cfg.name}
            maxLength={48}
            onChange={(e) => update({ name: e.target.value })}
          />
        </label>

        <div className="muted" style={{ fontSize: 13 }}>
          Opening book (Polyglot <code>.bin</code>) — played before the engine, instantly
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
            <input
              ref={fileRef}
              type="file"
              accept=".bin"
              style={{ display: "none" }}
              onChange={(e) => onFile(e.target.files?.[0])}
            />
            <button
              className="ghost"
              style={SMALL_BTN}
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              {busy ? "Reading…" : book ? "Replace book" : "Upload book"}
            </button>
            {book && (
              <>
                <span style={{ color: "var(--text-strong)" }}>
                  {book.name} · {book.positions.toLocaleString()} positions
                </span>
                <button
                  className="ghost"
                  style={SMALL_BTN}
                  onClick={() => clearUserBook().then(() => setBook(null))}
                >
                  Remove
                </button>
              </>
            )}
          </div>
          {book && (
            <label
              className="muted"
              style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}
            >
              Leave book after ply
              <input
                type="number"
                min={0}
                max={60}
                value={cfg.bookMaxPly}
                onChange={(e) => update({ bookMaxPly: Number(e.target.value) })}
                style={{ width: 64 }}
              />
            </label>
          )}
          {bookErr && <div style={{ color: "#e06c6c", fontSize: 13, marginTop: 6 }}>{bookErr}</div>}
        </div>
      </div>
    </div>
  );
}
