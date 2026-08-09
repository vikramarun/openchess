"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";

import { SeatGame } from "@/components/SeatGame";
import { loadBotOptions, useBotStatus } from "@/lib/bot";
import { SERVER_HTTP } from "@/lib/config";
import { fmtUsdc, parseUsdc } from "@/lib/escrow";
import {
  casualIdentity,
  fetchTournament,
  fetchTournaments,
  rememberCasualIdentity,
  sameEntrant,
  type Standing,
  type Tournament,
  type TournamentGame,
} from "@/lib/tournaments";
import { useAuthToken } from "@/lib/useAuthToken";
import { useAvailable } from "@/lib/useBankroll";
import { useMounted } from "@/lib/useMounted";
import { useOnchainConfig } from "@/lib/useOnchainConfig";
import { DEFAULT_TC, TIME_CONTROLS, type TimeControl } from "@/lib/timeControls";

// Tournament/TournamentGame/Standing come from @/lib/tournaments. MyGame is this
// page's per-entrant seat view (tokens are NOT in the public tournament view —
// they're fetched from /my-games, which only ever returns the caller's own).
type MyGame = {
  game_id: string;
  color: "white" | "black";
  token: string; // empty when the seat is played by the caller's bot
  round: number;
  seat: string; // "bot" | "browser"
};

export default function TournamentPage() {
  const mounted = useMounted();
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

const shortName = (p: string) =>
  p.startsWith("0x") && p.length === 42 ? `${p.slice(0, 6)}…${p.slice(-4)}` : p;

const isFinished = (t: Tournament) =>
  t.status === "complete" || t.status === "settled" || t.status === "abandoned";

function TournamentClient() {
  const { address } = useAccount();
  const token = useAuthToken();
  const { config, wagerOn } = useOnchainConfig();
  const [tourneys, setTourneys] = useState<Tournament[]>([]);
  const [err, setErr] = useState<string | null>(null);

  // create form
  const [name, setName] = useState("");
  const [buyIn, setBuyIn] = useState("");
  const [tc, setTc] = useState<TimeControl>(DEFAULT_TC);
  const [casualName, setCasualName] = useState("");

  // Casual entrant identity, mirrored from localStorage so a reload doesn't turn
  // an entrant into a stranger. Buy-in tournaments key on the wallet instead.
  const [identities, setIdentities] = useState<Record<string, string>>({});
  // The tournament whose detail page is open (standings, pairings, my game).
  const [openTid, setOpenTid] = useState<string | null>(null);
  // Rounds the player explicitly backed out of, per tournament. Leaving a round
  // keeps you out of it — but a NEW round pulls you back in, because not being
  // at the board when it dispatches is how you forfeit.
  const [leftRound, setLeftRound] = useState<Record<string, number>>({});
  // My own seat tokens for the open tournament (game_id -> seat).
  const [myTokens, setMyTokens] = useState<Record<string, MyGame>>({});

  const bot = useBotStatus(token);
  const { available } = useAvailable(config?.escrow);

  const identityIn = useCallback(
    (t: Tournament): string | null =>
      t.buy_in ? (address ? address.toLowerCase() : null) : identities[t.id] ?? null,
    [address, identities],
  );
  const isEntrant = useCallback(
    (t: Tournament) => {
      const me = identityIn(t);
      return !!me && t.players.some((p) => sameEntrant(p, me));
    },
    [identityIn],
  );
  // Only the organizer may start a buy-in tournament (the server enforces it and
  // 403s everyone else) — casual ones anyone can start. Offering a button that
  // is guaranteed to fail just teaches people the page is broken.
  const canStart = useCallback(
    (t: Tournament) => !t.buy_in || sameEntrant(t.organizer, identityIn(t)),
    [identityIn],
  );
  const myGames = useCallback(
    (t: Tournament): TournamentGame[] => {
      const me = identityIn(t);
      if (!me) return [];
      return t.games.filter((g) => sameEntrant(g.white, me) || sameEntrant(g.black, me));
    },
    [identityIn],
  );

  // Poll the lobby. One request for the whole list; while a tournament is open,
  // refresh just that one so a new round shows up fast without re-fetching every
  // tournament ever created.
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        if (openTid) {
          const t = await fetchTournament(openTid);
          if (live) setTourneys((prev) => prev.map((x) => (x.id === openTid ? t : x)));
          return;
        }
        const details = await fetchTournaments();
        if (live) setTourneys(details);
      } catch {
        /* transient — the next tick retries */
      }
    };
    tick();
    const iv = setInterval(tick, 3000);
    return () => {
      live = false;
      clearInterval(iv);
    };
  }, [openTid]);

  // Hydrate remembered casual identities once the lobby is known.
  useEffect(() => {
    setIdentities((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const t of tourneys) {
        if (next[t.id]) continue;
        const saved = casualIdentity(t.id);
        if (saved) {
          next[t.id] = saved;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [tourneys]);

  const openT = useMemo(() => tourneys.find((t) => t.id === openTid) ?? null, [tourneys, openTid]);

  // My game in the round currently being played, if any. Deliberately still
  // returns it once it has FINISHED: the round doesn't advance until every
  // pairing in it does, and unmounting the board the instant your own game
  // resolves means you never get to see how it ended.
  const currentGame = useCallback(
    (t: Tournament): TournamentGame | undefined =>
      t.status === "running"
        ? myGames(t).find((g) => g.round === t.current_round && !g.forfeit)
        : undefined,
    [myGames],
  );
  // …but only a game still in progress should pull the board open.
  const liveGame = useCallback(
    (t: Tournament): TournamentGame | undefined => {
      const g = currentGame(t);
      return g && !g.result ? g : undefined;
    },
    [currentGame],
  );

  // Open the board automatically when a round I'm in is dispatched.
  //
  // This is the whole reason tournament games used to die unplayed: the server
  // gives a room ~60s for both seats to connect, and a seat that never shows up
  // forfeits. Requiring the entrant to notice a button appear and click it
  // inside that window meant anyone who blinked lost the game — and every round
  // after it, since the schedule marches on regardless.
  useEffect(() => {
    if (openTid) return;
    const next = tourneys.find(
      (t) => isEntrant(t) && liveGame(t) && (leftRound[t.id] ?? -1) < t.current_round,
    );
    if (next) setOpenTid(next.id);
  }, [tourneys, openTid, isEntrant, liveGame, leftRound]);

  // Keep my seat tokens in sync while a tournament is open. Retries so a blip
  // can't strand the player on "taking your seat…", and re-runs each round.
  const openMe = openT ? identityIn(openT) : null;
  useEffect(() => {
    if (!openT || !isEntrant(openT)) return;
    const me = openMe;
    if (!me) return;
    const tid = openT.id;
    const buyIn = openT.buy_in;
    let alive = true;
    const load = async () => {
      const url = buyIn
        ? `${SERVER_HTTP}/tournaments/${tid}/my-games`
        : `${SERVER_HTTP}/tournaments/${tid}/my-games?player=${encodeURIComponent(me)}`;
      try {
        const r = await fetch(url, { headers: buyIn && token ? { authorization: `Bearer ${token}` } : {} });
        if (!r.ok || !alive) return;
        const games: MyGame[] = await r.json();
        setMyTokens((prev) => {
          const map = { ...prev };
          for (const g of games) map[g.game_id] = g;
          return map;
        });
      } catch {
        /* retry on the next tick */
      }
    };
    load();
    const iv = setInterval(load, 2500);
    return () => {
      alive = false;
      clearInterval(iv);
    };
    // openT is re-created by every poll; key off the fields that actually matter.
    // `openMe` has to be in here: it resolves from localStorage a render AFTER
    // the lobby loads, and without it a casual entrant who opened the page
    // before that landed would sit on "Taking your seat…" for the whole round.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openT?.id, openMe, openT?.current_round, openT?.games.length, token, address]);

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

  const join = async (t: Tournament, asBot = false) => {
    setErr(null);
    if ((t.buy_in || asBot) && !token)
      return setErr(
        asBot
          ? "Sign in to enter with your bot."
          : "Sign in (top right) to join a buy-in tournament.",
      );
    const player = t.buy_in
      ? undefined
      : casualName.trim() || `guest-${Math.floor(Date.now() % 100000)}`;
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
              : r.status === 409
                ? "That display name is already taken in this tournament."
                : `Couldn't join (${r.status}).`,
        );
        return;
      }
      // Store the entrant id the SERVER recorded — it sanitizes and caps the
      // display name, and remembering our own version would leave us looking up
      // an entrant that doesn't exist.
      const recorded: string | undefined = (await r.json().catch(() => null))?.player;
      if (!t.buy_in && recorded) {
        rememberCasualIdentity(t.id, recorded);
        setIdentities((m) => ({ ...m, [t.id]: recorded }));
      }
      setOpenTid(t.id);
    } catch {
      setErr("Server unreachable.");
    }
  };

  const startT = async (t: Tournament) => {
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
            ? "Need at least 2 entrants."
            : r.status === 403
              ? "Only the organizer can start this tournament."
              : `Couldn't start (${r.status}).`,
        );
      else setOpenTid(t.id);
    } catch {
      setErr("Server unreachable.");
    }
  };

  // ---- One tournament, open ----
  if (openT) {
    const me = identityIn(openT);
    const entrant = isEntrant(openT);
    const current = currentGame(openT);
    const seat = current?.game_id ? myTokens[current.game_id] : undefined;
    const back = () => {
      // Only count as "left" a round that HAD a live game to leave. Recording it
      // unconditionally suppressed auto-open for the round that hadn't started
      // yet: join -> back out to the lobby to wait -> organizer starts round 0 ->
      // `leftRound = 0` is not < `current_round = 0`, so the board never opened
      // and the seat was reaped as a no-show. That is the forfeit this whole
      // mechanism exists to prevent, reached by the most ordinary click there is.
      if (liveGame(openT)) setLeftRound((m) => ({ ...m, [openT.id]: openT.current_round }));
      setOpenTid(null);
      setMyTokens({}); // seat tokens are per-tournament; don't carry them over
    };

    return (
      <>
        <div className="panel" style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 12 }}>
          <button className="ghost" onClick={back}>
            ← All tournaments
          </button>
          <div style={{ flex: 1 }}>
            <b style={{ color: "var(--text-strong)" }}>{openT.name}</b>{" "}
            <span className={`status-pill ${openT.status}`}>{openT.status}</span>
            <div className="muted" style={{ fontSize: 13 }}>
              {openT.buy_in ? `${fmtUsdc(openT.buy_in)} USDC buy-in` : "casual"} ·{" "}
              {openT.players.length} entrant{openT.players.length === 1 ? "" : "s"}
              {openT.total_rounds > 0 &&
                ` · round ${Math.min(openT.current_round + 1, openT.total_rounds)} of ${openT.total_rounds}`}
            </div>
          </div>
          {openT.status === "open" && entrant && canStart(openT) && (
            <button className="primary" onClick={() => startT(openT)}>
              Start
            </button>
          )}
          {openT.status === "open" && entrant && !canStart(openT) && (
            <span className="muted" style={{ fontSize: 13 }}>
              waiting for the organizer to start
            </span>
          )}
        </div>

        {entrant && current && seat?.seat === "bot" && (
          <div className="panel" style={{ textAlign: "center", marginBottom: 16 }}>
            <div style={{ color: "var(--text-strong)", marginBottom: 6 }}>
              {current.result
                ? `🤖 Your bot finished round ${openT.current_round + 1}`
                : `🤖 Your bot is playing round ${openT.current_round + 1}`}
            </div>
            {!current.result && <div className="spinner" style={{ margin: "8px auto" }} />}
            {current.game_id && (
              <a
                className="primary"
                href={`/game/${current.game_id}`}
                target="_blank"
                rel="noreferrer"
                style={{ display: "inline-block", marginTop: 8 }}
              >
                Watch live ↗
              </a>
            )}
            <div className="muted" style={{ fontSize: 13, marginTop: 10 }}>
              Your bot plays every round automatically — leave this tab open.
            </div>
          </div>
        )}

        {entrant && current && seat && seat.seat !== "bot" && seat.token && current.game_id && (
          <div style={{ marginBottom: 16 }}>
            <SeatGame
              key={current.game_id}
              gameId={current.game_id}
              token={seat.token}
              color={seat.color}
              subtitle={`${openT.name} · round ${current.round + 1} of ${openT.total_rounds}`}
              // The server advances the round once every game in it finishes;
              // the poll then moves `current` to the next round's game.
              onResult={() => {}}
            />
          </div>
        )}

        {/* Anything that isn't "bot seat" or "browser seat with a token" lands
            here — a seat still loading, or the shouldn't-happen case of a
            browser seat the server handed no token. Better a stated wait than a
            blank page while the round's clock runs. */}
        {entrant && current && !(seat?.seat === "bot") && !(seat && seat.token) && (
          <div className="panel" style={{ marginBottom: 16 }}>
            <span className="muted">Taking your seat…</span>
          </div>
        )}

        {entrant && !current && openT.status === "running" && (
          <div className="panel" style={{ marginBottom: 16, textAlign: "center" }}>
            <span className="muted">
              {myGames(openT).some((g) => g.round === openT.current_round)
                ? "Your game this round is done — waiting for the rest of the field."
                : "You sit out this round. The next one starts automatically."}
            </span>
          </div>
        )}

        {entrant && isFinished(openT) && (
          <div className="panel" style={{ marginBottom: 16, textAlign: "center" }}>
            <b style={{ color: "var(--text-strong)" }}>
              {openT.status === "abandoned" ? "Tournament abandoned" : "Tournament finished 🎉"}
            </b>
            <p className="muted" style={{ marginBottom: 0 }}>
              {openT.status === "abandoned"
                ? "It was interrupted before it could settle — reclaim your buy-in from the wallet menu (top right)."
                : "The pool is distributed by final standings. Small fields credit your share to your bankroll directly; large fields settle a Merkle root — claim it from the wallet menu (top right)."}
            </p>
          </div>
        )}

        <div className="tourney-detail">
          <StandingsTable t={openT} me={me} />
          <PairingsList t={openT} me={me} />
        </div>

        {err && <div style={{ color: "#e06c6c", fontSize: 13, marginTop: 6 }}>{err}</div>}
      </>
    );
  }

  // ---- Lobby ----
  return (
    <>
      <div className="panel" style={{ marginBottom: 16 }}>
        <b style={{ color: "var(--text-strong)" }}>How it works</b>
        <ol className="muted" style={{ lineHeight: 1.8, marginBottom: 0 }}>
          <li>Create or join; your uniform buy-in locks into the on-chain pool.</li>
          <li>
            The organizer starts a round-robin. Your board opens by itself each round — a seat
            that doesn&apos;t show up within a minute forfeits.
          </li>
          <li>
            The pool is distributed by final standings — small fields directly, large fields via
            a Merkle claim.
          </li>
          <li>If it never settles, every entrant reclaims their buy-in after a timeout.</li>
        </ol>
      </div>

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
            None yet — create one above. Watch engines free in <Link href="/play">Test Engine</Link>.
          </div>
        ) : (
          <div className="tourney-list">
            {tourneys.map((t) => {
              const joined = isEntrant(t);
              const leader = t.standings[0];
              return (
                <div key={t.id} className="tourney-card">
                  <div className="tc-main">
                    <div className="tc-name">
                      {t.name} <span className={`status-pill ${t.status}`}>{t.status}</span>
                    </div>
                    <div className="muted" style={{ fontSize: 13 }}>
                      {t.buy_in ? `${fmtUsdc(t.buy_in)} USDC buy-in` : "casual"} · {t.players.length}{" "}
                      entrant{t.players.length === 1 ? "" : "s"}
                      {t.total_rounds > 0 &&
                        ` · round ${Math.min(t.current_round + 1, t.total_rounds)}/${t.total_rounds}`}
                      {t.status !== "open" && leader && leader.score > 0 && (
                        <> · leader {shortName(leader.player)} {leader.score}</>
                      )}
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
                    {t.status === "open" && joined && canStart(t) && (
                      <button className="ghost" onClick={() => startT(t)}>
                        Start
                      </button>
                    )}
                    {/* Always openable — standings and pairings are for everyone,
                        entrant or not, playing or long finished. */}
                    <button className={joined ? "primary" : "ghost"} onClick={() => setOpenTid(t.id)}>
                      {joined && t.status === "running" ? "Play" : "View"}
                    </button>
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

function StandingsTable({ t, me }: { t: Tournament; me: string | null }) {
  if (t.standings.length === 0)
    return (
      <div className="panel">
        <b style={{ color: "var(--text-strong)" }}>Standings</b>
        <div className="muted" style={{ marginTop: 8 }}>
          No entrants yet.
        </div>
      </div>
    );
  const decided = isFinished(t) && t.status !== "abandoned";
  return (
    <div className="panel">
      <b style={{ color: "var(--text-strong)" }}>Standings</b>
      <table className="standings">
        <thead>
          <tr>
            <th>#</th>
            <th>Entrant</th>
            <th>Score</th>
            <th>Played</th>
          </tr>
        </thead>
        <tbody>
          {t.standings.map((s: Standing) => (
            <tr key={s.player} className={sameEntrant(s.player, me) ? "me" : undefined}>
              <td>{decided && s.rank === 1 ? "🥇" : s.rank}</td>
              <td>
                {shortName(s.player)}
                {s.bot && <span className="muted"> 🤖</span>}
                {sameEntrant(s.player, me) && <span className="muted"> (you)</span>}
              </td>
              <td>{s.score}</td>
              <td className="muted">
                {s.played}
                {t.total_rounds > 0 ? `/${t.players.length - 1}` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PairingsList({ t, me }: { t: Tournament; me: string | null }) {
  if (t.games.length === 0)
    return (
      <div className="panel">
        <b style={{ color: "var(--text-strong)" }}>Pairings</b>
        <div className="muted" style={{ marginTop: 8 }}>
          {t.status === "open"
            ? "The schedule is drawn when the tournament starts."
            : "No pairings yet."}
        </div>
      </div>
    );
  const rounds = new Map<number, TournamentGame[]>();
  for (const g of t.games) rounds.set(g.round, [...(rounds.get(g.round) ?? []), g]);
  return (
    <div className="panel">
      <b style={{ color: "var(--text-strong)" }}>Pairings</b>
      {[...rounds.keys()]
        .sort((a, b) => a - b)
        .map((round) => (
          <div key={round} className="pairing-round">
            <div className="muted" style={{ fontSize: 12, margin: "10px 0 4px" }}>
              Round {round + 1}
              {round === t.current_round && t.status === "running" && " · in progress"}
            </div>
            {(rounds.get(round) ?? []).map((g, i) => (
              <div
                key={g.game_id ?? `${round}-${i}`}
                className={`pairing${sameEntrant(g.white, me) || sameEntrant(g.black, me) ? " me" : ""}`}
              >
                <span className={g.result === "white" ? "won" : g.result === "black" ? "lost" : ""}>
                  {shortName(g.white)}
                </span>
                <span className="muted"> vs </span>
                <span className={g.result === "black" ? "won" : g.result === "white" ? "lost" : ""}>
                  {shortName(g.black)}
                </span>
                <span className="muted" style={{ marginLeft: 8 }}>
                  {g.forfeit
                    ? "forfeit"
                    : g.result === "draw"
                      ? "½–½"
                      : g.result === "white"
                        ? "1–0"
                        : g.result === "black"
                          ? "0–1"
                          : "playing…"}
                </span>
                {g.game_id && !g.forfeit && (
                  <a
                    href={`/game/${g.game_id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="muted"
                    style={{ marginLeft: 8 }}
                  >
                    watch ↗
                  </a>
                )}
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}
