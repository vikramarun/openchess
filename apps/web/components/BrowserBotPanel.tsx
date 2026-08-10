"use client";

import { useEffect, useState } from "react";

import { RepertoirePicker } from "@/components/RepertoirePicker";
import { TimeControls } from "@/components/TimeControls";
import {
  DEFAULT_CONFIG,
  getBrowserBotConfig,
  resetRepertoireCache,
  saveBrowserBotConfig,
  type BrowserBotConfig,
} from "@/lib/browserBot";

/** Personalize the in-browser bot — an opening repertoire and a thinking style
 *  — with no download. Settings persist locally and apply to every browser-seat
 *  game.
 *
 *  Two things deliberately absent. What a seat is CALLED is your username, on
 *  the Profile tab, resolved server-side from the wallet in the seat. And there
 *  is no "upload a Polyglot .bin": it was the most advanced control on the most
 *  beginner-facing surface, and bringing your own book is what the downloadable
 *  client is for (`chess-client --book`), alongside bringing your own engine. */
export function BrowserBotPanel() {
  const [cfg, setCfg] = useState<BrowserBotConfig>(DEFAULT_CONFIG);

  useEffect(() => {
    setCfg(getBrowserBotConfig());
  }, []);

  const update = (patch: Partial<BrowserBotConfig>) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    saveBrowserBotConfig(next);
    // Drop the warmed books so the next game plays the repertoire that's on
    // screen, not the one that was selected when the page loaded.
    if (patch.repertoire !== undefined) resetRepertoireCache();
  };

  return (
    <div className="panel" id="engine" style={{ marginBottom: 16 }}>
      <b style={{ color: "var(--text-strong)" }}>🤖 Your browser bot</b>
      <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
        Full-strength Stockfish 18 in your browser, no download. Give it an opening repertoire
        and a thinking style, and they apply to every game your browser plays.
      </div>

      <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
        {/* Openings are the one part of a bot's character that costs no
            strength — playing the Najdorf every game is theory, not a worse
            move. So it leads. */}
        <div>
          <b style={{ color: "var(--text-strong)", fontSize: 14 }}>Opening repertoire</b>
          <div className="muted" style={{ fontSize: 13, margin: "2px 0 10px" }}>
            What your bot opens with, and how it answers as Black. Free strength-wise — it&apos;s
            established theory, played instantly instead of burning clock.
          </div>
          <RepertoirePicker
            repertoire={cfg.repertoire}
            onChange={(patch) => update({ repertoire: { ...cfg.repertoire, ...patch } })}
          />
        </div>

        {/* Time is the other free lever: highly visible, almost no Elo cost. */}
        <div>
          <b style={{ color: "var(--text-strong)", fontSize: 14 }}>Thinking time</b>
          <div className="muted" style={{ fontSize: 13, margin: "2px 0 10px" }}>
            How your bot spends its clock. A bot that answers instantly is obvious to anyone
            watching, and it barely costs any strength.
          </div>
          <TimeControls
            time={cfg.time}
            onChange={(patch) => update({ time: { ...cfg.time, ...patch } })}
          />
        </div>
      </div>
    </div>
  );
}
