"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";

import { BankrollPanel } from "@/components/BankrollPanel";
import { SeatGame } from "@/components/SeatGame";
import { SERVER_HTTP } from "@/lib/config";
import { authToken, fetchConfig, fmtUsdc, parseUsdc, type OnchainConfig } from "@/lib/escrow";
import { useAvailable } from "@/lib/useBankroll";
import { DEFAULT_TC, TIME_CONTROLS, type TimeControl } from "@/lib/timeControls";

type TGame = {
  game_id: string;
  white: string;
  black: string;
  white_token: string;
  black_token: string;
};
type Tourney = {
  id: string;
  name: string;
  buy_in: string | null;
  status: string;
  players: string[];
  games: TGame[];
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

  // create form
  const [name, setName] = useState("");
  const [buyIn, setBuyIn] = useState("");
  const [tc, setTc] = useState<TimeControl>(DEFAULT_TC);
  const [casualName, setCasualName] = useState("");

  // identity per tournament (casual name) + which I'm actively playing
  const [joinedAs, setJoinedAs] = useState<Record<string, string>>({});
  const [playingTid, setPlayingTid] = useState<string | null>(null);
  const [playedIds, setPlayedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchConfig().then(setConfig);
  }, []);
  useEffect(() => {
    setToken(authToken());
  }, [address, isConnected]);

  // Poll tournament list + details.
  useEffect(() => {
    if (playingTid) return;
    let live = true;
    const tick = async () => {
      try {
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

  const join = async (t: Tourney) => {
    setErr(null);
    if (t.buy_in && !token) return setErr("Sign in (top right) to join a buy-in tournament.");
    const player = t.buy_in ? undefined : casualName.trim() || `guest-${Math.floor(Date.now() % 100000)}`;
    try {
      const r = await fetch(`${SERVER_HTTP}/tournaments/${t.id}/join`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(t.buy_in && token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ player }),
      });
      if (!r.ok) {
        setErr(
          r.status === 502
            ? "Couldn't move your buy-in into the pool — check your deposited balance."
            : `Couldn't join (${r.status}).`,
        );
        return;
      }
      if (!t.buy_in && player) setJoinedAs((m) => ({ ...m, [t.id]: player.toLowerCase() }));
    } catch {
      setErr("Server unreachable.");
    }
  };

  const startT = async (t: Tourney) => {
    setErr(null);
    try {
      const r = await fetch(`${SERVER_HTTP}/tournaments/${t.id}/start`, { method: "POST" });
      if (!r.ok) setErr(r.status === 409 ? "Need at least 2 players." : `Couldn't start (${r.status}).`);
    } catch {
      setErr("Server unreachable.");
    }
  };

  // ---- Playing my bracket ----
  const activeT = useMemo(
    () => tourneys.find((t) => t.id === playingTid) ?? null,
    [tourneys, playingTid],
  );
  if (playingTid && activeT) {
    const mine = myGames(activeT);
    const next = mine.find((g) => !playedIds.has(g.game_id));
    if (next) {
      const me = identityIn(activeT)!;
      const color = next.white.toLowerCase() === me ? "white" : "black";
      const seatToken = color === "white" ? next.white_token : next.black_token;
      const idx = mine.findIndex((g) => g.game_id === next.game_id);
      return (
        <SeatGame
          key={next.game_id}
          gameId={next.game_id}
          token={seatToken}
          color={color}
          subtitle={`${activeT.name} · game ${idx + 1} of ${mine.length}`}
          onResult={() =>
            setTimeout(() => setPlayedIds((s) => new Set(s).add(next.game_id)), 3500)
          }
        />
      );
    }
    // all my games done
    return (
      <div className="panel" style={{ textAlign: "center" }}>
        <b style={{ color: "var(--text-strong)" }}>You’ve finished your games 🎉</b>
        <p className="muted">
          Standings are tallied as every pairing completes. If you finish in the money, your
          share of the pool is credited to your bankroll (large fields settle a Merkle root —
          claim from your profile). Withdraw any time from the bankroll panel.
        </p>
        <button className="primary" onClick={() => { setPlayingTid(null); setPlayedIds(new Set()); }}>
          Back to tournaments
        </button>
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
                        <button className="ghost" onClick={() => join(t)}>
                          Join
                        </button>
                      ))}
                    {t.status === "open" && joined && (
                      <button className="ghost" onClick={() => startT(t)}>
                        Start
                      </button>
                    )}
                    {t.status !== "open" && mine.length > 0 && (
                      <button
                        className="primary"
                        onClick={() => {
                          setPlayedIds(new Set());
                          setPlayingTid(t.id);
                        }}
                      >
                        Play my {mine.length} game{mine.length === 1 ? "" : "s"}
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
