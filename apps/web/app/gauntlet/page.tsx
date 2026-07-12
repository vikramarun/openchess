"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";

import { BankrollPanel } from "@/components/BankrollPanel";
import { SeatGame } from "@/components/SeatGame";
import { loadBotOptions, useBotStatus } from "@/lib/bot";
import { SERVER_HTTP } from "@/lib/config";
import { authToken, fetchConfig, fmtUsdc, parseUsdc, type OnchainConfig } from "@/lib/escrow";
import { useAvailable } from "@/lib/useBankroll";
import { DEFAULT_TC, TIME_CONTROLS, type TimeControl } from "@/lib/timeControls";

type Stats = {
  status: string;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  stake: string | null;
};
type Cur = { gameId: string; token: string; color: "white" | "black" };

export default function GauntletPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <div className="container">
      <div className="hero" style={{ paddingBottom: 8 }}>
        <h1>🔥 Gauntlet</h1>
        <p>
          Your engine keeps playing back-to-back games at a fixed tier until you stop. Lock a
          bankroll once; every game settles against it on-chain.
        </p>
      </div>
      {mounted ? <GauntletClient /> : null}
    </div>
  );
}

function GauntletClient() {
  const { address, isConnected } = useAccount();
  const [config, setConfig] = useState<OnchainConfig | null>(null);
  const [token, setToken] = useState<string | null>(null);

  const [stake, setStake] = useState("");
  const [tc, setTc] = useState<TimeControl>(DEFAULT_TC);
  const [session, setSession] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [cur, setCur] = useState<Cur | null>(null);
  const [round, setRound] = useState(0); // bump to re-queue after a game
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [useBot, setUseBot] = useState(true); // prefer the connected bot when online
  // Set while the connected bot (not this browser) is playing the current game.
  const [spectate, setSpectate] = useState<{ gameId: string; atGames: number } | null>(null);
  // Latest games-count, read without re-triggering the queue loop.
  const gamesRef = useRef(0);

  useEffect(() => {
    fetchConfig().then(setConfig);
  }, []);
  useEffect(() => {
    setToken(authToken());
  }, [address, isConnected]);

  const bot = useBotStatus(token);
  const botPlays = bot.online && useBot;
  useEffect(() => {
    gamesRef.current = stats?.games ?? 0;
  }, [stats]);

  const { available } = useAvailable(config?.escrow);
  const wagerOn = !!config?.wagerEnabled && !!config?.escrow;
  const wantStake = stake.trim().length > 0;
  const running = !!session && stats?.status !== "stopped";
  const stakeBig = (() => {
    if (!wantStake) return 0n;
    try {
      return parseUsdc(stake);
    } catch {
      return null;
    }
  })();
  const startUnderfunded =
    wantStake && stakeBig != null && available != null && available < stakeBig;

  // Queue loop: while running with no active game, search for an opponent and
  // start the next game when matched.
  useEffect(() => {
    if (!session || cur || spectate || stats?.status === "stopped") return;
    let live = true;
    let poll: ReturnType<typeof setInterval> | undefined;
    (async () => {
      try {
        setSearching(true);
        const r = await fetch(`${SERVER_HTTP}/queue`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // A bot seat is always wallet-bound, so it needs auth even casually.
            ...((wantStake || botPlays) && token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            stake: wantStake ? parseUsdc(stake).toString() : undefined,
            initial_secs: tc.initial,
            increment_secs: tc.inc,
            session_id: session,
            ...(botPlays ? { seat: "bot", uci_options: loadBotOptions() } : {}),
          }),
        });
        if (!r.ok) {
          if (r.status === 409) {
            // The session is stopped (e.g. auto-stopped after a no-move
            // forfeit): don't retry — let the stopped-state UI take over.
            setSearching(false);
            setErr(null);
            await refreshStats();
            return;
          }
          setErr(
            r.status === 424
              ? "Your bot went offline — reconnect the chess-client window."
              : `Couldn't join the queue (${r.status}).`,
          );
          setSearching(false);
          // Don't give up — retry shortly (the bot may reconnect, the server may
          // recover). The `live` guard stops retries once the gauntlet is stopped.
          setTimeout(() => {
            if (live) setRound((n) => n + 1);
          }, 5000);
          return;
        }
        const { ticket_id } = await r.json();
        poll = setInterval(async () => {
          try {
            const t = await (await fetch(`${SERVER_HTTP}/queue/${ticket_id}`)).json();
            if (t.status === "matched" && live) {
              clearInterval(poll);
              setSearching(false);
              if (t.seat === "bot" || !t.token) {
                // The connected bot plays this game; the browser watches and
                // re-queues when the session's game count ticks up.
                setSpectate({ gameId: t.game_id, atGames: gamesRef.current });
              } else {
                setCur({ gameId: t.game_id, token: t.token, color: t.color });
              }
            }
          } catch {
            /* keep polling */
          }
        }, 1500);
      } catch {
        setErr("Server unreachable.");
        setSearching(false);
        setTimeout(() => {
          if (live) setRound((n) => n + 1);
        }, 5000);
      }
    })();
    return () => {
      live = false;
      clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, cur, spectate, round]);

  // While the bot is playing, poll the session: when its game count ticks up
  // (this game finished) — or the gauntlet is stopped — drop back to re-queue.
  useEffect(() => {
    if (!spectate || !session) return;
    let alive = true;
    const t = setInterval(async () => {
      try {
        const s = await (await fetch(`${SERVER_HTTP}/gauntlet/${session}`)).json();
        if (!alive) return;
        setStats(s);
        if ((s.games ?? 0) > spectate.atGames || s.status === "stopped") {
          setSpectate(null);
          setRound((r) => r + 1);
        }
      } catch {
        /* keep polling */
      }
    }, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [spectate, session]);

  const refreshStats = async () => {
    if (!session) return;
    try {
      const s = await (await fetch(`${SERVER_HTTP}/gauntlet/${session}`)).json();
      setStats(s);
    } catch {
      /* ignore */
    }
  };

  const start = async () => {
    setErr(null);
    if (wantStake && !token) return setErr("Sign in (top right) to run a staked gauntlet.");
    let stakeBase: string | undefined;
    if (wantStake) {
      try {
        const amt = parseUsdc(stake);
        if (amt <= 0n) return setErr("Stake must be positive.");
        stakeBase = amt.toString();
      } catch {
        return setErr("Enter a valid USDC stake.");
      }
    }
    try {
      const r = await fetch(`${SERVER_HTTP}/gauntlet/start`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(wantStake && token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          stake: stakeBase,
          initial_secs: tc.initial,
          increment_secs: tc.inc,
        }),
      });
      if (!r.ok) return setErr(`Couldn't start (${r.status}).`);
      const j = await r.json();
      setSession(j.session_id);
      setStats({ status: "running", games: 0, wins: 0, losses: 0, draws: 0, stake: stakeBase ?? null });
    } catch {
      setErr("Server unreachable.");
    }
  };

  const stop = async () => {
    if (!session) return;
    try {
      await fetch(`${SERVER_HTTP}/gauntlet/${session}/stop`, {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
    } catch {
      /* ignore */
    }
    setStats((s) => (s ? { ...s, status: "stopped" } : s));
    setCur(null);
    setSpectate(null);
    setSession(null);
    setSearching(false);
  };

  // Active game in the gauntlet.
  if (session && cur) {
    return (
      <>
        <GauntletScore stats={stats} onStop={stop} />
        <SeatGame
          key={cur.gameId}
          gameId={cur.gameId}
          token={cur.token}
          color={cur.color}
          stake={stats?.stake}
          subtitle={`Gauntlet game ${(stats?.games ?? 0) + 1} · ${cur.color === "white" ? "White" : "Black"}`}
          onResult={async () => {
            await refreshStats();
            // Brief pause to show the result, then queue the next game.
            setTimeout(() => {
              setCur(null);
              setRound((r) => r + 1);
            }, 3500);
          }}
        />
      </>
    );
  }

  // Bot mode: the connected agent is playing this game; the browser watches and
  // re-queues automatically when it finishes.
  if (session && spectate) {
    return (
      <>
        <GauntletScore stats={stats} onStop={stop} />
        <div className="panel" style={{ textAlign: "center" }}>
          <div style={{ color: "var(--text-strong)", marginBottom: 6 }}>
            🤖 {bot.name ?? "Your bot"} is playing game {(stats?.games ?? 0) + 1}
          </div>
          <div className="spinner" style={{ margin: "8px auto" }} />
          <a
            className="primary"
            href={`/game/${spectate.gameId}`}
            target="_blank"
            rel="noreferrer"
            style={{ display: "inline-block", marginTop: 8 }}
          >
            Watch live ↗
          </a>
          <div className="muted" style={{ fontSize: 13, marginTop: 10 }}>
            Re-queues automatically when this game finishes — leave this tab open.
          </div>
        </div>
      </>
    );
  }

  // Searching for the next opponent.
  if (session && running) {
    return (
      <>
        <GauntletScore stats={stats} onStop={stop} />
        <div className="panel" style={{ textAlign: "center" }}>
          <div className="spinner" />
          <div className="muted" style={{ marginTop: 8 }}>
            {searching ? "Searching for an opponent at your tier…" : "Preparing next game…"}
          </div>
        </div>
        {err && <div style={{ color: "#e06c6c", fontSize: 13, marginTop: 6 }}>{err}</div>}
      </>
    );
  }

  // Auto-stopped: the session still exists but is no longer running — the
  // engine forfeited a game without moving, so the server stopped the run to
  // protect the stake. Explain it and offer a clean restart.
  if (session && !running) {
    return (
      <>
        <GauntletScore stats={stats} onStop={stop} />
        <div className="panel" style={{ textAlign: "center" }}>
          <div style={{ color: "var(--text-strong)", marginBottom: 6 }}>Gauntlet stopped</div>
          <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
            Your engine forfeited a game without making a move — it may be offline or
            misconfigured. The gauntlet stopped so it can’t keep losing your stake.
            Reconnect your bot, then start a new run.
          </div>
          <button
            className="primary"
            onClick={() => {
              setSession(null);
              setStats(null);
              setCur(null);
              setSpectate(null);
              setErr(null);
            }}
          >
            Start a new gauntlet
          </button>
        </div>
      </>
    );
  }

  // Idle: start form.
  return (
    <>
      <div className="panel" style={{ marginBottom: 16 }}>
        <b style={{ color: "var(--text-strong)" }}>How it works</b>
        <ol className="muted" style={{ lineHeight: 1.8, marginBottom: 0 }}>
          <li>Pick a tier and time control; deposit USDC once.</li>
          <li>Your engine is paired with the next arrival at that tier and plays in-browser.</li>
          <li>Win/lose/draw is tracked; it re-queues automatically until you stop.</li>
          <li>Each game settles on-chain against your bankroll.</li>
        </ol>
      </div>

      {wagerOn && config?.escrow && (
        <div style={{ marginBottom: 16 }}>
          <BankrollPanel escrow={config.escrow} chainId={config.chainId} />
        </div>
      )}

      <div className="panel" style={{ marginBottom: 16 }}>
        <b style={{ color: "var(--text-strong)" }}>Run a gauntlet</b>
        <div className="offer-form">
          <label className="of-field">
            <span className="muted">Stake per game (USDC)</span>
            <input
              inputMode="decimal"
              placeholder={wagerOn ? "e.g. 1.00 (blank = casual)" : "casual only"}
              value={stake}
              onChange={(e) => setStake(e.target.value)}
              disabled={!wagerOn}
            />
          </label>
          <label className="of-field">
            <span className="muted">Time control</span>
            <div className="tc-row">
              {TIME_CONTROLS.map((t) => (
                <button
                  key={t.label}
                  type="button"
                  className={`tc-pill${tc.label === t.label ? " active" : ""}`}
                  onClick={() => setTc(t)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </label>
          {bot.online && (
            <label className="of-field">
              <span className="muted">Who plays</span>
              <div className="tc-row">
                <button
                  type="button"
                  className={`tc-pill${useBot ? " active" : ""}`}
                  onClick={() => setUseBot(true)}
                >
                  🤖 My bot{bot.engine ? ` (${bot.engine})` : ""}
                </button>
                <button
                  type="button"
                  className={`tc-pill${!useBot ? " active" : ""}`}
                  onClick={() => setUseBot(false)}
                >
                  In-browser engine
                </button>
              </div>
            </label>
          )}
          <button className="primary" onClick={start} disabled={startUnderfunded}>
            {wantStake ? "Start staked gauntlet" : "Start casual gauntlet"}
          </button>
          {botPlays && (
            <p className="muted" style={{ fontSize: 13, margin: "6px 0 0" }}>
              🤖 Your connected bot will play every game unattended — leave the tab open and it
              climbs the tier on its own.
            </p>
          )}
        </div>
        {startUnderfunded && stakeBig != null && (
          <div style={{ color: "#e0a96c", fontSize: 13, marginTop: 6 }}>
            Available balance {fmtUsdc(available)} USDC &lt; stake {fmtUsdc(stakeBig)} per game —
            deposit more above.
          </div>
        )}
        {err && <div style={{ color: "#e06c6c", fontSize: 13, marginTop: 6 }}>{err}</div>}
        <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
          Prefer the native client? <code>chess-client gauntlet --count 20 --stake 1000000</code>.
          Watch engines free in <Link href="/play">Quick Play</Link>.
        </p>
      </div>
    </>
  );
}

function GauntletScore({ stats, onStop }: { stats: Stats | null; onStop: () => void }) {
  return (
    <div className="panel gauntlet-score" style={{ marginBottom: 16 }}>
      <div className="gs-stats">
        <div className="bk">
          <span className="bk-v">{stats?.games ?? 0}</span>
          <span className="bk-l">Games</span>
        </div>
        <div className="bk">
          <span className="bk-v" style={{ color: "var(--accent)" }}>{stats?.wins ?? 0}</span>
          <span className="bk-l">Wins</span>
        </div>
        <div className="bk">
          <span className="bk-v">{stats?.losses ?? 0}</span>
          <span className="bk-l">Losses</span>
        </div>
        <div className="bk">
          <span className="bk-v">{stats?.draws ?? 0}</span>
          <span className="bk-l">Draws</span>
        </div>
        {stats?.stake && (
          <div className="bk">
            <span className="bk-v">{fmtUsdc(stats.stake)}</span>
            <span className="bk-l">Stake / game</span>
          </div>
        )}
      </div>
      <button className="ghost" onClick={onStop}>
        Stop gauntlet
      </button>
    </div>
  );
}
