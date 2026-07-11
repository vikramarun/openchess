"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { BOT_OFFLINE, fetchBot, loadBotOptions, saveBotOptions, type BotStatus } from "@/lib/bot";
import { SERVER_HTTP } from "@/lib/config";
import { authToken } from "@/lib/escrow";

/** "Connect your engine": pair a UCI engine running on your machine with your
 *  wallet, once. After that the website is the remote control — start or join
 *  games in the lobby and your bot plays them. */
export default function ConnectPage() {
  const [token, setToken] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [codeErr, setCodeErr] = useState<string | null>(null);
  const [bot, setBot] = useState<BotStatus>(BOT_OFFLINE);
  const [enginePath, setEnginePath] = useState("./stockfish");
  const [bookPath, setBookPath] = useState("");
  const [name, setName] = useState("");
  const [copied, setCopied] = useState(false);
  const [opts, setOpts] = useState<Record<string, string>>({});

  useEffect(() => {
    setToken(authToken());
    setOpts(loadBotOptions());
  }, []);

  // Signed in → mint the pairing code automatically (single-use, 10 min).
  useEffect(() => {
    if (!token || code) return;
    (async () => {
      try {
        const r = await fetch(`${SERVER_HTTP}/auth/link`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        });
        if (!r.ok) return setCodeErr("Couldn't create a pairing code — try signing in again.");
        setCode((await r.json()).code);
      } catch {
        setCodeErr("Server unreachable.");
      }
    })();
  }, [token, code]);

  // Live status: flips to "online" the moment the client connects.
  useEffect(() => {
    if (!token) return;
    let alive = true;
    const tick = () => fetchBot(token).then((b) => alive && setBot(b));
    tick();
    const t = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [token]);

  const command = useMemo(() => {
    const parts = [
      "chess-client connect",
      `--server ${SERVER_HTTP}`,
      `--engine ${enginePath || "./stockfish"}`,
    ];
    if (bookPath.trim()) parts.push(`--book ${bookPath.trim()}`);
    if (name.trim()) parts.push(`--name "${name.trim().replace(/"/g, "")}"`);
    parts.push(`--code ${code ?? "<sign in to get a code>"}`);
    return parts.join(" \\\n  ");
  }, [enginePath, bookPath, name, code]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const setOpt = (k: string, v: string) => {
    const next = { ...opts, [k]: v };
    if (!v.trim()) delete next[k];
    setOpts(next);
    saveBotOptions(next);
  };

  return (
    <div className="container" style={{ maxWidth: 760 }}>
      <h1 style={{ marginBottom: 4 }}>Connect your engine</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Run any UCI engine — and optionally a Polyglot opening book — on <b>your own computer</b>{" "}
        and pair it with your wallet, once. After that this site is the remote control: start or
        join games in the <Link href="/">lobby</Link> and your bot plays them. The server stays
        the referee — legality, clocks and results are decided server-side; your machine only
        picks moves.
      </p>

      {bot.online ? (
        <div className="panel" style={{ marginBottom: 16, borderColor: "#3a7d44" }}>
          <b style={{ color: "var(--text-strong)" }}>
            ✓ {bot.name ?? bot.engine} is online{bot.busy ? " — playing right now" : ""}
          </b>
          <p className="muted" style={{ fontSize: 14, marginBottom: 8 }}>
            Engine: {bot.engine}. Head to the <Link href="/">lobby</Link>, pick a time control or
            join an open challenge — your bot plays the seat while you watch live.
          </p>

          {bot.options.length > 0 && (
            <details>
              <summary className="muted" style={{ cursor: "pointer", fontSize: 14 }}>
                Engine settings ({bot.options.length} options) — applied to every game your bot
                plays
              </summary>
              <div style={{ display: "grid", gap: 6, marginTop: 10, maxHeight: 320, overflowY: "auto" }}>
                {bot.options
                  .filter((o) => o.kind !== "button")
                  .map((o) => (
                    <label
                      key={o.name}
                      className="muted"
                      style={{
                        fontSize: 13,
                        display: "grid",
                        gridTemplateColumns: "1fr 140px",
                        gap: 8,
                        alignItems: "center",
                      }}
                    >
                      <span>
                        {o.name}
                        <span style={{ opacity: 0.6 }}>
                          {" "}
                          ({o.kind}
                          {o.min != null && o.max != null ? ` ${o.min}–${o.max}` : ""})
                        </span>
                      </span>
                      <input
                        placeholder={o.default ?? ""}
                        value={opts[o.name] ?? ""}
                        onChange={(e) => setOpt(o.name, e.target.value)}
                      />
                    </label>
                  ))}
              </div>
              <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                Blank = engine default. Saved in this browser and sent with each game (e.g.
                Threads, Hash, Skill Level).
              </p>
            </details>
          )}
        </div>
      ) : (
        <>
          <div className="panel" style={{ marginBottom: 16 }}>
            <b style={{ color: "var(--text-strong)" }}>1 · Get the client</b>
            <p className="muted" style={{ fontSize: 14 }}>
              Build the native client from source (Rust required). It drives any UCI engine
              binary — Stockfish, Lc0, or your own.
            </p>
            <pre>
              {"git clone https://github.com/vikramarun/openchess && cd openchess\ncargo build --release -p byo-client\n# binary: ./target/release/chess-client"}
            </pre>
          </div>

          <div className="panel" style={{ marginBottom: 16 }}>
            <b style={{ color: "var(--text-strong)" }}>2 · Run it</b>
            {!token && (
              <p className="muted" style={{ fontSize: 14 }}>
                <b>Sign in with your wallet first</b> (top right) — bots are wallet-bound, so your
                games count toward your profile and can carry stakes. A single-use pairing code is
                added to the command automatically.
              </p>
            )}
            <div style={{ display: "grid", gap: 10, margin: "10px 0" }}>
              <label className="muted" style={{ fontSize: 13 }}>
                Engine binary (UCI)
                <input value={enginePath} onChange={(e) => setEnginePath(e.target.value)} />
              </label>
              <label className="muted" style={{ fontSize: 13 }}>
                Opening book — optional Polyglot .bin, consulted before the engine
                <input
                  placeholder="./book.bin (optional)"
                  value={bookPath}
                  onChange={(e) => setBookPath(e.target.value)}
                />
              </label>
              <label className="muted" style={{ fontSize: 13 }}>
                Bot name shown to opponents (optional, defaults to the engine's name)
                <input
                  placeholder="e.g. TalBot 9000"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
            </div>
            <pre>{command}</pre>
            <button className="primary" onClick={copy} disabled={!code}>
              {copied ? "Copied ✓" : code ? "Copy command" : "Sign in to get the command"}
            </button>
            {codeErr && <div style={{ color: "#e06c6c", fontSize: 13, marginTop: 8 }}>{codeErr}</div>}
            {token && (
              <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
                Waiting for your bot to connect… this page updates the moment it's online. The
                code is single-use and expires in 10 minutes; reload for a fresh one. Headless
                bots can use <code>OPENCHESS_WALLET_KEY</code> instead, and{" "}
                <code>--auto</code> makes the bot matchmake unattended.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
