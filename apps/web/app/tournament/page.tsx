"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";

import { BankrollPanel } from "@/components/BankrollPanel";
import { SeatGame } from "@/components/SeatGame";
import { BOT_OFFLINE, fetchBot, loadBotOptions, type BotStatus } from "@/lib/bot";
import { SERVER_HTTP } from "@/lib/config";
import { authToken, fetchConfig, fmtUsdc, parseUsdc, type OnchainConfig } from "@/lib/escrow";
import { useAvailable } from "@/lib/useBankroll";
import { DEFAULT_TC, TIME_CONTROLS, type TimeControl } from "@/lib/timeControls";

type TGame = {
  game_id: string;
  white: string;
  black: string;
  round: number;
  // seat tokens are NOT in the public view — fetched per-entrant via /my-games
};
type MyGame = {
  game_id: string;
  color: "white" | "black";
  token: string; // empty when the seat is played by the caller's bot
  round: number;
  seat: string; // "bot" | "browser"
};
type Tourney = {
  id: string;
  name: string;
  buy_in: string | null;
  status: string;
  players: string[];
  games: TGame[];
  current_round: number;
  total_rounds: number;
};

export default function TournamentPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <div className="container">
      <div className="hero" style={{ paddingBottom: 8 }}>
        <h1>🏆 Tournament</h1>
        <p>
          Buy in to a prize pool. A round-robin runs (Swiss &amp; knockout coming), and the
          pool is distributed on-chain by final standings.
        </p>
      </div>
      {mounted ? <TournamentClient /> : null}
    </div>
  );
}

function TournamentClient() {
  const { address, isConnected } = useAccount();
  const [config, setConfig] = useState<OnchainConfig | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [tourneys, setTourneys] = useState<Tourney[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [bot, setBot] = useState<BotStatus>(BOT_OFFLINE);
  // Tournaments this browser entered with its connected bot (→ spectate).
  const [joinedAsBot, setJoinedAsBot] = useState<Record<string, boolean>>({});

  // create form
  const [name, setName] = useState("");
  const [buyIn, setBuyIn] = useState("");
  const [tc, setTc] = useState<TimeControl>(DEFAULT_TC);
  const [casualName, setCasualName] = useState("");

  // identity per tournament (casual name) + which I'm actively playing
  const [joinedAs, setJoinedAs] = useState<Record<string, string>>({});
  const [playingTid, setPlayingTid] = useState<string | null>(null);
  // My own seat tokens for the tournament I'm playing (game_id -> {token,color}).
  const [myTokens, setMyTokens] = useState<Record<string, MyGame>>({});

  useEffect(() => {
    fetchConfig().then(setConfig);
  }, []);
  useEffect(() => {
    setToken(authToken());
  }, [address, isConnected]);

  // Poll the connected bot's status while signed in.
  useEffect(() => {
    if (!token) return setBot(BOT_OFFLINE);
    let alive = true;
    const tick = () => fetchBot(token).then((b) => alive && setBot(b));
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [token]);

  // Poll tournaments. In the lobby, refresh the whole list; while playing or
  // spectating, refresh ONLY the active tournament (so new rounds appear) rather
  // than an ever-growing N+1 fan-out over every tournament ever created.
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        if (playingTid) {
          const d = await (await fetch(`${SERVER_HTTP}/tournaments/${playingTid}`)).json();
          if (live)
            setTourneys((prev) => [
              ...prev.filter((t) => t.id !== playingTid),
              { id: playingTid, ...d } as Tourney,
            ]);
          return;
        }
        const ids: { tournament_id: string }[] = await (
          await fetch(`${SERVER_HTTP}/tournaments`)
        ).json();
        const details = await Promise.all(
          ids.map(async ({ tournament_id }) => {
            const d = await (await fetch(`${SERVER_HTTP}/tournaments/${tournament_id}`)).json();
            return { id: tournament_id, ...d } as Tourney;
          }),
        );
        if (live) setTourneys(details);
      } catch {
        /* ignore */
      }
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [playingTid]);

  const { available } = useAvailable(config?.escrow);
  const wagerOn = !!config?.wagerEnabled && !!config?.escrow;

  const identityIn = (t: Tourney): string | null => {
    if (t.buy_in) return address ? address.toLowerCase() : null;
    return joinedAs[t.id] ?? null;
  };
  const myGames = (t: Tourney): TGame[] => {
    const me = identityIn(t);
    if (!me) return [];
    return t.games.filter(
      (g) => g.white.toLowerCase() === me || g.black.toLowerCase() === me,
    );
  };

  const create = async () => {
    setErr(null);
    if (!name.trim()) return setErr("Give the tournament a name.");
    let buyInBase: string | undefined;
    if (buyIn.trim()) {
      if (!token) return setErr("Sign in (top right) to create a buy-in tournament.");
      try {
        buyInBase = parseUsdc(buyIn).toString();
      } catch {
        return setErr("Enter a valid USDC buy-in.");
      }
    }
    try {
      const r = await fetch(`${SERVER_HTTP}/tournaments`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(buyInBase && token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          name: name.trim(),
          buy_in: buyInBase,
          initial_secs: tc.initial,
          increment_secs: tc.inc,
        }),
      });
      if (!r.ok) return setErr(`Couldn't create (${r.status}).`);
      setName("");
      setBuyIn("");
    } catch {
      setErr("Server unreachable.");
    }
  };

  const join = async (t: Tourney, asBot = false) => {
    setErr(null);
    if ((t.buy_in || asBot) && !token)
      return setErr(
        asBot ? "Sign in to enter with your bot." : "Sign in (top right) to join a buy-in tournament.",
      );
    const player = t.buy_in ? undefined : casualName.trim() || `guest-${Math.floor(Date.now() % 100000)}`;
    try {
      const r = await fetch(`${SERVER_HTTP}/tournaments/${t.id}/join`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...((t.buy_in || asBot) && token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          player,
          ...(asBot ? { seat: "bot", uci_options: loadBotOptions() } : {}),
        }),
      });
      if (!r.ok) {
        setErr(
          r.status === 502
            ? "Couldn't move your buy-in into the pool — check your deposited balance."
            : r.status === 424
              ? "Your bot is offline — check the chess-client window."
              : `Couldn't join (${r.status}).`,
        );
        return;
      }
      if (!t.buy_in && player) setJoinedAs((m) => ({ ...m, [t.id]: player.toLowerCase() }));
      if (asBot) setJoinedAsBot((m) => ({ ...m, [t.id]: true }));
    } catch {
      setErr("Server unreachable.");
    }
  };

  const startT = async (t: Tourney) => {
    setErr(null);
    if (t.buy_in && !token) return setErr("Sign in (top right) to start your tournament.");
    try {
      const r = await fetch(`${SERVER_HTTP}/tournaments/${t.id}/start`, {
        method: "POST",
        headers: t.buy_in && token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!r.ok)
        setErr(
          r.status === 409
            ? "Need at least 2 players."
            : r.status === 403
              ? "Only the organizer can start this tournament."
              : `Couldn't start (${r.status}).`,
        );
    } catch {
      setErr("Server unreachable.");
    }
  };

  /// Fetch only MY seat tokens (never exposed in the public view) and enter play.
  const enterPlay = async (t: Tourney) => {
    setErr(null);
    const me = identityIn(t);
    if (!me) return setErr("Join the tournament first.");
    try {
      const url = t.buy_in
        ? `${SERVER_HTTP}/tournaments/${t.id}/my-games`
        : `${SERVER_HTTP}/tournaments/${t.id}/my-games?player=${encodeURIComponent(me)}`;
      const r = await fetch(url, {
        headers: t.buy_in && token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!r.ok) return setErr(`Couldn't load your games (${r.status}).`);
      const games: MyGame[] = await r.json();
      const map: Record<string, MyGame> = {};
      for (const g of games) map[g.game_id] = g;
      setMyTokens(map);
      setPlayingTid(t.id);
    } catch {
      setErr("Server unreachable.");
    }
  };

  // ---- Playing / watching my tournament ----
  const activeT = useMemo(
    () => tourneys.find((t) => t.id === playingTid) ?? null,
    [tourneys, playingTid],
  );
  // My games so far (they arrive one per round). The current game is the one in
  // the round in progress; earlier rounds are done, later ones aren't dispatched.
  const mine = activeT ? myGames(activeT) : [];
  const current =
    activeT && activeT.status !== "open"
      ? mine.find((g) => g.round === activeT.current_round)
      : undefined;
  const currentId = current?.game_id ?? null;
  // Am I a bot entrant here? Prefer the authoritative server seat (survives a
  // page reload); fall back to the client-side join flag until my-games loads.
  const currentSeat = currentId ? myTokens[currentId]?.seat : undefined;
  const iAmBot = playingTid
    ? currentSeat
      ? currentSeat === "bot"
      : !!joinedAsBot[playingTid]
    : false;

  // Keep my seat tokens in sync as new rounds start (browser entrants only — a
  // bot entrant plays via its agent and just spectates). Retries until the
  // token loads, so a transient blip can't strand the player on "Loading…".
  useEffect(() => {
    if (!playingTid || !currentId || iAmBot || myTokens[currentId]) return;
    const t = tourneys.find((x) => x.id === playingTid);
    if (!t) return;
    const me = t.buy_in ? (address ? address.toLowerCase() : null) : joinedAs[t.id] ?? null;
    if (!me) return;
    let alive = true;
    let iv: ReturnType<typeof setInterval> | undefined;
    const fetchTokens = async () => {
      const url = t.buy_in
        ? `${SERVER_HTTP}/tournaments/${t.id}/my-games`
        : `${SERVER_HTTP}/tournaments/${t.id}/my-games?player=${encodeURIComponent(me)}`;
      try {
        const r = await fetch(url, {
          headers: t.buy_in && token ? { authorization: `Bearer ${token}` } : {},
        });
        if (!r.ok || !alive) return;
        const games: MyGame[] = await r.json();
        setMyTokens((prev) => {
          const map = { ...prev };
          for (const g of games) map[g.game_id] = g;
          return map;
        });
        if (games.some((g) => g.game_id === currentId) && iv) clearInterval(iv);
      } catch {
        /* retry on the next tick */
      }
    };
    fetchTokens();
    iv = setInterval(fetchTokens, 2500);
    return () => {
      alive = false;
      if (iv) clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playingTid, currentId, iAmBot]);

  if (playingTid && activeT) {
    const done = activeT.status === "settled" || activeT.status === "complete";
    const backBtn = (
      <button className="primary" onClick={() => setPlayingTid(null)}>
        Back to tournaments
      </button>
    );

    // Bot entrant: the agent plays; the browser watches the current round's game.
    if (iAmBot) {
      return (
        <div className="panel" style={{ textAlign: "center" }}>
          {current ? (
            <>
              <div style={{ color: "var(--text-strong)", marginBottom: 6 }}>
                🤖 Your bot is playing round {activeT.current_round + 1} of {activeT.total_rounds}
              </div>
              <div className="spinner" style={{ margin: "8px auto" }} />
              <a
                className="primary"
                href={`/game/${current.game_id}`}
                target="_blank"
                rel="noreferrer"
                style={{ display: "inline-block", marginTop: 8 }}
              >
                Watch live ↗
              </a>
              <div className="muted" style={{ fontSize: 13, marginTop: 10 }}>
                Your bot plays every round automatically — leave this tab open.
              </div>
            </>
          ) : done ? (
            <>
              <b style={{ color: "var(--text-strong)" }}>Tournament finished 🎉</b>
              <p className="muted">
                Standings decide the pool; a winning share is credited to your bankroll.
              </p>
              {backBtn}
            </>
          ) : (
            <span className="muted">Waiting for your bot’s next round…</span>
          )}
        </div>
      );
    }

    // Browser entrant: play the current round's game.
    const seat = current ? myTokens[current.game_id] : undefined;
    if (current && seat && seat.token) {
      return (
        <SeatGame
          key={current.game_id}
          gameId={current.game_id}
          token={seat.token}
          color={seat.color}
          subtitle={`${activeT.name} · round ${current.round + 1} of ${activeT.total_rounds}`}
          // The server advances the round once every game in it finishes; the
          // poll then moves `current` to the next round's game. Nothing to do here.
          onResult={() => {}}
        />
      );
    }
    if (current) {
      return (
        <div className="panel">
          <span className="muted">Loading your game…</span>
        </div>
      );
    }
    // No current game: between rounds, a bye, or finished.
    return (
      <div className="panel" style={{ textAlign: "center" }}>
        {done ? (
          <>
            <b style={{ color: "var(--text-strong)" }}>You’ve finished your games 🎉</b>
            <p className="muted">
              Standings are tallied as every pairing completes. A winning share of the pool is
              credited to your bankroll (large fields settle a Merkle root — claim from your
              profile).
            </p>
          </>
        ) : (
          <p className="muted">Waiting for your next round to start…</p>
        )}
        {backBtn}
      </div>
    );
  }

  // ---- Lobby ----
  return (
    <>
      <div className="panel" style={{ marginBottom: 16 }}>
        <b style={{ color: "var(--text-strong)" }}>How it works</b>
        <ol className="muted" style={{ lineHeight: 1.8, marginBottom: 0 }}>
          <li>Create or join; your uniform buy-in locks into the on-chain pool.</li>
          <li>The organizer starts a round-robin; you play your pairings in-browser.</li>
          <li>The pool is distributed by final standings — small fields directly, large fields via a Merkle claim.</li>
          <li>If it never settles, every entrant reclaims their buy-in after a timeout.</li>
        </ol>
      </div>

      {wagerOn && config?.escrow && (
        <div style={{ marginBottom: 16 }}>
          <BankrollPanel escrow={config.escrow} chainId={config.chainId} />
        </div>
      )}

      <div className="panel" style={{ marginBottom: 16 }}>
        <b style={{ color: "var(--text-strong)" }}>Create a tournament</b>
        <div className="offer-form">
          <label className="of-field" style={{ flex: 1 }}>
            <span className="muted">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Friday Arena" />
          </label>
          <label className="of-field">
            <span className="muted">Buy-in (USDC)</span>
            <input
              inputMode="decimal"
              value={buyIn}
              onChange={(e) => setBuyIn(e.target.value)}
              placeholder={wagerOn ? "blank = casual" : "casual only"}
              disabled={!wagerOn}
              style={{ width: 140 }}
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
          <button className="primary" onClick={create}>
            Create
          </button>
        </div>
        <label className="of-field" style={{ marginTop: 10 }}>
          <span className="muted">Display name for casual tournaments</span>
          <input
            value={casualName}
            onChange={(e) => setCasualName(e.target.value)}
            placeholder="your handle (casual only)"
            style={{ maxWidth: 280 }}
          />
        </label>
        {err && <div style={{ color: "#e06c6c", fontSize: 13, marginTop: 6 }}>{err}</div>}
      </div>

      <div className="panel">
        <b style={{ color: "var(--text-strong)" }}>Tournaments</b>
        {tourneys.length === 0 ? (
          <div className="muted" style={{ marginTop: 8 }}>
            None yet — create one above. Watch engines free in <Link href="/play">Quick Play</Link>.
          </div>
        ) : (
          <div className="tourney-list">
            {tourneys.map((t) => {
              const me = identityIn(t);
              const joined = !!me && t.players.some((p) => p.toLowerCase() === me);
              const mine = myGames(t);
              return (
                <div key={t.id} className="tourney-card">
                  <div className="tc-main">
                    <div className="tc-name">
                      {t.name}{" "}
                      <span className={`status-pill ${t.status}`}>{t.status}</span>
                    </div>
                    <div className="muted" style={{ fontSize: 13 }}>
                      {t.buy_in ? `${fmtUsdc(t.buy_in)} USDC buy-in` : "casual"} · {t.players.length}{" "}
                      player{t.players.length === 1 ? "" : "s"}
                      {t.games.length > 0 && ` · ${t.games.length} games`}
                    </div>
                  </div>
                  <div className="tc-actions">
                    {t.status === "open" &&
                      !joined &&
                      (t.buy_in && available != null && available < BigInt(t.buy_in) ? (
                        <span className="muted" title="Deposit more USDC to join">
                          need {fmtUsdc(t.buy_in)}
                        </span>
                      ) : (
                        <>
                          <button className="ghost" onClick={() => join(t)}>
                            Join
                          </button>
                          {bot.online && (
                            <button className="ghost" onClick={() => join(t, true)}>
                              🤖 Join with bot
                            </button>
                          )}
                        </>
                      ))}
                    {t.status === "open" && joined && (
                      <button className="ghost" onClick={() => startT(t)}>
                        Start
                      </button>
                    )}
                    {t.status !== "open" && mine.length > 0 && (
                      <button className="primary" onClick={() => enterPlay(t)}>
                        {joinedAsBot[t.id]
                          ? "Watch my bot"
                          : `Play my ${mine.length} game${mine.length === 1 ? "" : "s"}`}
                      </button>
                    )}
                    {t.status !== "open" && joined && mine.length === 0 && (
                      <span className="muted">no games</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
