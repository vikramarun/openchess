"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { loadBotOptions, saveBotOptions, useBotStatus } from "@/lib/bot";
import { GITHUB_REPO, SERVER_HTTP } from "@/lib/config";
import { useAuthToken } from "@/lib/useAuthToken";

/** Prebuilt client binaries published by .github/workflows/release.yml —
 *  artifact names there are load-bearing for these URLs (the workflow's
 *  publish job asserts they exist before releasing). */
const RELEASES = `${GITHUB_REPO}/releases/latest/download`;
const DOWNLOADS = [
  { key: "macos-arm64", label: "macOS (Apple Silicon)", file: "chess-client-macos-arm64.tar.gz" },
  { key: "macos-x64", label: "macOS (Intel)", file: "chess-client-macos-x64.tar.gz" },
  { key: "linux-x64", label: "Linux (x64)", file: "chess-client-linux-x64.tar.gz" },
  { key: "windows-x64", label: "Windows (x64)", file: "chess-client-windows-x64.zip" },
] as const;

/** Best-effort platform guess for the primary download button. Browsers hide
 *  Apple Silicon vs Intel, so default Macs to arm64 (the common case) and
 *  list every platform below it. iOS UAs contain "like Mac OS X" and Android
 *  contains "Linux", so mobile must be detected FIRST — those visitors get a
 *  "runs on desktop" note instead of a binary they can't execute. */
function guessPlatform(): (typeof DOWNLOADS)[number]["key"] | "mobile" {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/iPhone|iPad|iPod|Android|Mobile/i.test(ua)) return "mobile";
  if (/Windows/i.test(ua)) return "windows-x64";
  if (/Mac/i.test(ua)) return "macos-arm64";
  return "linux-x64";
}

/** "Connect your engine": pair a UCI engine running on your machine with your
 *  wallet, once. After that the website is the remote control — start or join
 *  games in the lobby and your bot plays them. Rendered inside the profile's
 *  Engine section and on the standalone /connect page. */
export function ConnectEngine() {
  // Reactive: reflects a sign-in / sign-out that happens on the same page (e.g.
  // the header AuthButton on /profile) without a reload.
  const token = useAuthToken();
  const [code, setCode] = useState<string | null>(null);
  const [codeErr, setCodeErr] = useState<string | null>(null);
  const [enginePath, setEnginePath] = useState("stockfish");
  const [bookPath, setBookPath] = useState("");
  const [name, setName] = useState("");
  const [copied, setCopied] = useState(false);
  const [opts, setOpts] = useState<Record<string, string>>({});
  const [platform, setPlatform] =
    useState<(typeof DOWNLOADS)[number]["key"] | "mobile">("macos-arm64");

  useEffect(() => {
    setOpts(loadBotOptions());
    setPlatform(guessPlatform());
  }, []);

  // Session changed (signed out, or switched wallet) → drop the stale pairing
  // code so a fresh one mints for the new session instead of pairing the engine
  // to the previous wallet.
  useEffect(() => {
    setCode(null);
    setCodeErr(null);
  }, [token]);

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

  // Live status: flips to "online" the moment the client connects (poll fast).
  const bot = useBotStatus(token, 3000);

  const isWindows = platform === "windows-x64";
  const command = useMemo(() => {
    // PowerShell needs the .\ prefix to run a CWD executable, and neither
    // PowerShell nor cmd accept bash's backslash line continuations — so the
    // Windows command is a single line.
    const bin = isWindows ? ".\\chess-client.exe" : "./chess-client";
    const parts = [
      `${bin} connect`,
      `--server ${SERVER_HTTP}`,
      `--engine ${enginePath || "stockfish"}`,
    ];
    if (bookPath.trim()) parts.push(`--book ${bookPath.trim()}`);
    if (name.trim()) parts.push(`--name "${name.trim().replace(/"/g, "")}"`);
    parts.push(`--code ${code ?? "<sign in to get a code>"}`);
    return parts.join(isWindows ? " " : " \\\n  ");
  }, [enginePath, bookPath, name, code, isWindows]);

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
    <>
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
              A single small binary that drives any UCI engine — Stockfish, Lc0, or your own. No
              Rust toolchain needed.
            </p>
            {(() => {
              const dl = DOWNLOADS.find((d) => d.key === platform);
              return dl ? (
                <p style={{ margin: "10px 0" }}>
                  <a
                    className="primary"
                    style={{ textDecoration: "none", padding: "8px 14px", borderRadius: 6 }}
                    href={`${RELEASES}/${dl.file}`}
                  >
                    ⬇ Download for {dl.label}
                  </a>
                </p>
              ) : (
                <p className="muted" style={{ fontSize: 14 }}>
                  📱 The client runs on a desktop or server — grab the right build from your
                  computer:
                </p>
              );
            })()}
            <div className="muted" style={{ fontSize: 13 }}>
              {platform === "mobile" ? "Downloads:" : "Other platforms:"}{" "}
              {DOWNLOADS.filter((d) => d.key !== platform).map((d, i) => (
                <span key={d.key}>
                  {i > 0 && " · "}
                  <a href={`${RELEASES}/${d.file}`}>{d.label}</a>
                </span>
              ))}
            </div>
            <pre style={{ marginTop: 10 }}>
              {isWindows
                ? "# unzip, then run from a terminal in that folder"
                : "tar -xzf chess-client-*.tar.gz   # then run ./chess-client from that folder"}
            </pre>
            <p className="muted" style={{ fontSize: 13 }}>
              You also need a UCI engine on your machine —{" "}
              {isWindows ? (
                <>
                  download Stockfish from <a href="https://stockfishchess.org/download/">
                    stockfishchess.org
                  </a>{" "}
                  and point <code>--engine</code> at the unzipped .exe
                </>
              ) : (
                <>
                  e.g. <code>brew install stockfish</code> (macOS) or{" "}
                  <code>apt install stockfish</code> (Linux), or point <code>--engine</code> at
                  any engine binary
                </>
              )}
              .
            </p>
            <p className="muted" style={{ fontSize: 13 }}>
              If the download 404s, the first release hasn't been cut yet — build from source
              below. If macOS blocks the app ("developer cannot be verified"), run{" "}
              <code>xattr -d com.apple.quarantine chess-client</code> or right-click → Open once.
            </p>
            <details>
              <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>
                Prefer building from source?
              </summary>
              <pre style={{ marginTop: 8 }}>
                {`git clone ${GITHUB_REPO} && cd openchess\ncargo build --release -p byo-client\n# binary: ./target/release/chess-client`}
              </pre>
            </details>
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
    </>
  );
}
