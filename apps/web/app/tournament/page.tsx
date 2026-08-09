"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount } from "wagmi";

import { SeatGame } from "@/components/SeatGame";
import { SponsorPool } from "@/components/SponsorPool";
import { TournamentAdmission } from "@/components/TournamentAdmission";
import { authedFetch, SESSION_EXPIRED } from "@/lib/authedFetch";
import { browserSeat } from "@/lib/browserBot";
import { loadBotOptions, useBotStatus } from "@/lib/bot";
import { SERVER_HTTP } from "@/lib/config";
import { BOT_OFFLINE_MSG, MAINTENANCE_MSG } from "@/lib/copy";
import { fmtUsdc, parseUsdc } from "@/lib/escrow";
import {
  DEFAULT_PAYOUT,
  formatPayout,
  parsePayout,
  PAYOUT_PRESETS,
  presetLabel,
} from "@/lib/payouts";
import { requestSeat } from "@/lib/admission";
import {
  casualIdentity,
  entrantLabel,
  fetchTournament,
  fetchTournaments,
  rememberCasualIdentity,
  hasPrizePool,
  isOrganizer,
  kindOf,
  sameEntrant,
  type Admission,
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
          pool is distributed onchain by final standings.
        </p>
      </div>
      {mounted ? <TournamentClient /> : null}
    </div>
  );
}

/** Sentinel for the "type your own percentages" option in the prizes picker. */
const CUSTOM_PAYOUT = "custom";

/** A tournament's prize structure, by preset name when it matches one. */
const payoutLabel = (t: Tournament) => presetLabel(t.payout.bps) ?? formatPayout(t.payout.bps);

/** A non-zero pool as USDC, or null. Never throws on a malformed figure — this
 *  runs inside a render. */
function poolLabel(pool: string | null): string | null {
  if (!pool) return null;
  try {
    return BigInt(pool) > 0n ? `${fmtUsdc(pool)} USDC pool` : null;
  } catch {
    return null;
  }
}

/** The money terms: what entry costs, what's in the pot, how it splits.
 *
 *  One helper for the lobby card and the detail header so they can't drift, and
 *  because getting this wrong is easy: `buy_in` is `"0"` for a free
 *  sponsor-funded event, which is a TRUTHY string — branching on it directly
 *  renders "0 USDC entry" and tags an unranked event Ranked. Go through
 *  `kindOf`. */
function Terms({ t }: { t: Tournament }) {
  const kind = kindOf(t);
  if (kind === "casual") return <>casual</>;
  const pool = poolLabel(t.pool);
  return (
    <>
      {kind === "buyin" ? (
        <>
          {fmtUsdc(t.buy_in)} USDC entry{" "}
          <span className="tag tag-rated" title="Ranked: moves your ranked Elo">
            Ranked
          </span>
        </>
      ) : (
        // Free entry is sponsor-funded: real prize money, nothing risked — so it
        // moves casual Elo, not ranked, and carries no Ranked tag.
        <>free entry</>
      )}
      {pool ? <> · {pool}</> : null} · prizes{" "}
      <span title={formatPayout(t.payout.bps)}>{payoutLabel(t)}</span>
    </>
  );
}

// Entrant labels come from `entrantLabel`, which reads the server-resolved
// `labels` map. Rendering the raw id here would print a wallet in the standings
// while the board and the lobby print that same person's handle.

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
  // Prize structure for a tournament being created: a preset by label, or
  // "custom" with percentages typed in. Parsed (and validated against the same
  // rules the server enforces) before the request goes out.
  const [payoutChoice, setPayoutChoice] = useState<string>(PAYOUT_PRESETS[0].label);
  const [payoutCustom, setPayoutCustom] = useState("");
  const [admission, setAdmission] = useState<Admission>("open");
  // Joiner side of a gated tournament: the code being entered, and whether an
  // approval request is in flight.
  const [inviteCode, setInviteCode] = useState("");
  const [requesting, setRequesting] = useState(false);
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
  // Games whose board we actually sat at. A finished game's room is gone —
  // `ws_handler` drops the socket the moment `room_channels` misses — so
  // mounting SeatGame fresh on one just fast-fails to "disconnected" behind an
  // empty board. Keeping a board we're ALREADY sitting at is different: it has
  // the position and the result banner, which is the whole point of not
  // unmounting the instant your game resolves.
  const seated = useRef<Set<string>>(new Set());

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

  useEffect(() => {
    const g = openT ? liveGame(openT) : undefined;
    if (g?.game_id) seated.current.add(g.game_id);
  }, [openT, liveGame]);

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

  // The structure the create form currently describes, or the reason it isn't
  // one. Shown live under the field so a creator sees "these add up to 90%"
  // while typing rather than after the form round-trips.
  const payoutDraft = useMemo(() => {
    if (payoutChoice !== CUSTOM_PAYOUT) {
      const preset = PAYOUT_PRESETS.find((p) => p.label === payoutChoice);
      return preset ? { bps: preset.bps } : DEFAULT_PAYOUT;
    }
    return parsePayout(payoutCustom);
  }, [payoutChoice, payoutCustom]);
  const payoutErr = "error" in payoutDraft ? payoutDraft.error : null;

  const create = async () => {
    setErr(null);
    if (!name.trim()) return setErr("Give the tournament a name.");
    if ("error" in payoutDraft) return setErr(payoutDraft.error);
    let buyInBase: string | undefined;
    if (buyIn.trim()) {
      if (!token)
        return setErr("Sign in (top right) to create a tournament with an entry fee.");
      try {
        buyInBase = parseUsdc(buyIn).toString();
      } catch {
        return setErr("Enter a valid USDC entry fee.");
      }
    }
    try {
      const r = await authedFetch(`${SERVER_HTTP}/tournaments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          buy_in: buyInBase,
          initial_secs: tc.initial,
          increment_secs: tc.inc,
          payout: payoutDraft,
          admission,
        }),
      });
      if (!r.ok)
        return setErr(
          r.status === 401
            ? // A gated tournament needs an organizer who can open the gate, so
              // the server refuses an anonymous one. Otherwise it's a stale
              // session, which is what SESSION_EXPIRED explains.
              admission !== "open" && !token
              ? "Sign in (top right) to create a tournament people have to be let into."
              : SESSION_EXPIRED
            : r.status === 402
              ? // The organizer must be funded before we spend oracle gas on
                // `openTournament` — at least their own entry, and a deposit of
                // some kind even when entry is free.
                buyInBase && buyInBase !== "0"
                ? "Deposit at least the entry fee before opening a paid tournament — the organizer plays too."
                : "Deposit to your balance first — opening a prize pool costs us gas, so it needs a funded organizer."
              : r.status === 503
                ? MAINTENANCE_MSG
                : // The server validates the structure too, and it is the
                  // authority — say so rather than blaming the whole form.
                  r.status === 400
                  ? "The server refused those terms. Check the prize structure and entry fee."
                  : `Couldn’t create (${r.status}).`,
        );
      setName("");
      setBuyIn("");
    } catch {
      setErr("Server unreachable.");
    }
  };

  const join = async (t: Tournament, asBot = false, invite?: string) => {
    setErr(null);
    if ((t.buy_in || asBot) && !token)
      return setErr(
        asBot
          ? "Sign in to enter with your bot."
          : "Sign in (top right) to join a tournament with an entry fee.",
      );
    const player = t.buy_in
      ? undefined
      : casualName.trim() || `guest-${Math.floor(Date.now() % 100000)}`;
    try {
      // authedFetch, always: a CASUAL join wants the session too — it's what
      // lets the server put the finished games in this player's history and
      // move their casual Elo. Signed out stays fine (no header is attached).
      const r = await authedFetch(`${SERVER_HTTP}/tournaments/${t.id}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          player,
          ...(invite ? { invite } : {}),
          ...(asBot ? { seat: "bot", uci_options: loadBotOptions() } : { engine: browserSeat().engine }),
        }),
      });
      if (!r.ok) {
        setErr(
          r.status === 401
            ? SESSION_EXPIRED
            : r.status === 503
              ? MAINTENANCE_MSG
              : r.status === 502
                ? "Couldn’t move your entry into the pool. Check your deposited balance."
                : r.status === 424
                  ? BOT_OFFLINE_MSG
                  : r.status === 409
                    ? "That display name is already taken in this tournament."
                    : // The admission gate. The server answers 403 for every
                      // not-admitted case and never a 2xx — `fetch` counts 202
                      // as ok, so a "you're still pending" success code would be
                      // read here as a completed join. Which case it is comes
                      // from `my_admission`, not the status.
                      r.status === 403
                      ? t.admission === "invite"
                        ? "That invite code isn’t valid — it may already have been used."
                        : t.my_admission === "pending"
                          ? "Your request is still waiting on the organizer."
                          : t.my_admission === "rejected"
                            ? "The organizer declined this request."
                            : "Ask the organizer to let you in first."
                      : `Couldn’t join (${r.status}).`,
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
          r.status === 503
            ? MAINTENANCE_MSG
            : r.status === 409
              ? "Need at least 2 entrants."
              : r.status === 403
                ? "Only the organizer can start this tournament."
                : `Couldn’t start (${r.status}).`,
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
              {/* The structure is fixed at creation and can't be changed
                  afterwards, so it belongs next to the entry fee: it is half of
                  what an entrant is agreeing to. */}
              <Terms t={openT} />{" "}
              · {openT.players.length} entrant{openT.players.length === 1 ? "" : "s"}
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

        {openT.status === "open" && !entrant && (
          <div className="panel" style={{ marginBottom: 16 }}>
            <b style={{ color: "var(--text-strong)" }}>Join</b>
            {openT.admission === "approval" ? (
              <div style={{ marginTop: 8 }}>
                {openT.my_admission === "approved" ? (
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span className="muted" style={{ fontSize: 13 }}>
                      You&apos;re approved.
                    </span>
                    <button className="primary" onClick={() => join(openT)}>
                      Join
                    </button>
                    {bot.online && (
                      <button className="ghost" onClick={() => join(openT, true)}>
                        🤖 Join with bot
                      </button>
                    )}
                  </div>
                ) : openT.my_admission === "pending" ? (
                  <span className="muted" style={{ fontSize: 13 }}>
                    Waiting for the organizer to let you in. Nothing has been charged —
                    you&apos;ll join after they approve.
                  </span>
                ) : openT.my_admission === "rejected" ? (
                  <span className="muted" style={{ fontSize: 13 }}>
                    The organizer declined this request.
                  </span>
                ) : (
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <button
                      className="primary"
                      disabled={requesting || !token}
                      onClick={async () => {
                        setErr(null);
                        setRequesting(true);
                        try {
                          await requestSeat(openT.id);
                          // my_admission comes from the detail poll; pull it now
                          // rather than leaving the button looking unclicked.
                          const fresh = await fetchTournament(openT.id);
                          setTourneys((prev) => prev.map((x) => (x.id === fresh.id ? fresh : x)));
                        } catch {
                          setErr("Couldn’t send that request.");
                        } finally {
                          setRequesting(false);
                        }
                      }}
                    >
                      {requesting ? "Asking…" : "Ask to join"}
                    </button>
                    <span className="muted" style={{ fontSize: 13 }}>
                      {token
                        ? "The organizer decides. Asking costs nothing."
                        : "Sign in (top right) to ask — approval is tied to your wallet."}
                    </span>
                  </div>
                )}
              </div>
            ) : openT.admission === "invite" ? (
              <div style={{ marginTop: 8 }}>
                <div className="offer-form" style={{ margin: 0 }}>
                  <label className="of-field" style={{ flex: 1 }}>
                    <span className="muted">Invite code</span>
                    <input
                      value={inviteCode}
                      onChange={(e) => setInviteCode(e.target.value.trim())}
                      placeholder="paste the code the organizer sent you"
                    />
                  </label>
                  <button
                    className="primary"
                    disabled={!inviteCode}
                    onClick={() => join(openT, false, inviteCode)}
                  >
                    Join
                  </button>
                  {bot.online && (
                    <button
                      className="ghost"
                      disabled={!inviteCode}
                      onClick={() => join(openT, true, inviteCode)}
                    >
                      🤖 Join with bot
                    </button>
                  )}
                </div>
                <span className="muted" style={{ fontSize: 12 }}>
                  Each code lets one entrant in.
                </span>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button className="primary" onClick={() => join(openT)}>
                  Join
                </button>
                {bot.online && (
                  <button className="ghost" onClick={() => join(openT, true)}>
                    🤖 Join with bot
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {isOrganizer(openT, address) && <TournamentAdmission t={openT} />}

        {/* Anyone may add to the pool, entrant or not, while the field is still
            playing for it. Not once the tournament is `complete`: settlement is
            being signed against the pool as read, so money arriving in that
            window is raked rather than paid out (see TOURNAMENTS.md). */}
        {hasPrizePool(openT) &&
          config?.escrow &&
          wagerOn &&
          (openT.status === "open" || openT.status === "running") && (
            <div className="panel" style={{ marginBottom: 16 }}>
              <b style={{ color: "var(--text-strong)" }}>Prize pool</b>
              <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
                {poolLabel(openT.pool) ?? "Nothing in the pot yet"}
                {kindOf(openT) === "free"
                  ? " — entry is free, so the prizes are whatever sponsors put up."
                  : " — entries plus sponsorship."}
              </div>
              <SponsorPool
                tid={openT.id}
                escrow={config.escrow}
                chainId={config.chainId}
                onFunded={() => {
                  // The server polls the chain for the pool, so the figure here
                  // catches up on its own within a tick or two; this just makes
                  // the next poll happen now rather than after the interval.
                  fetchTournament(openT.id)
                    .then((t) => setTourneys((prev) => prev.map((x) => (x.id === t.id ? t : x))))
                    .catch(() => {});
                }}
              />
            </div>
          )}

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
                {current.result ? "Review the game ↗" : "Watch live ↗"}
              </a>
            )}
            <div className="muted" style={{ fontSize: 13, marginTop: 10 }}>
              Your bot plays every round automatically. Leave this tab open.
            </div>
          </div>
        )}

        {entrant &&
          current &&
          seat &&
          seat.seat !== "bot" &&
          seat.token &&
          current.game_id &&
          (!current.result || seated.current.has(current.game_id)) && (
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

        {/* The exact complement of the board branch above for a finished game:
            shown whenever we can't (or shouldn't) mount a live board for it —
            including the moment after `back()` drops our tokens and we return
            before the round has advanced. */}
        {entrant &&
          current?.result &&
          current.game_id &&
          seat?.seat !== "bot" &&
          !(seat && seat.token && seated.current.has(current.game_id)) && (
          <div className="panel" style={{ marginBottom: 16, textAlign: "center" }}>
            <b style={{ color: "var(--text-strong)" }}>
              Round {current.round + 1}:{" "}
              {current.result === "draw"
                ? "drawn"
                : sameEntrant(
                      current.result === "white" ? current.white : current.black,
                      identityIn(openT),
                    )
                  ? "you won"
                  : "you lost"}
            </b>
            <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
              Waiting for the rest of the field before the next round.{" "}
              <a href={`/game/${current.game_id}`} target="_blank" rel="noreferrer">
                Review the game ↗
              </a>
            </div>
          </div>
        )}

        {/* Anything that isn't "bot seat" or "browser seat with a token" lands
            here — a seat still loading, or the shouldn't-happen case of a
            browser seat the server handed no token. Better a stated wait than a
            blank page while the round's clock runs. */}
        {entrant && current && !current.result && !(seat?.seat === "bot") && !(seat && seat.token) && (
          <div className="panel" style={{ marginBottom: 16 }}>
            <span className="muted">Taking your seat…</span>
          </div>
        )}

        {entrant && !current && openT.status === "running" && (
          <div className="panel" style={{ marginBottom: 16, textAlign: "center" }}>
            <span className="muted">
              {myGames(openT).some((g) => g.round === openT.current_round)
                ? "Your game this round is done. Waiting for the rest of the field."
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
                ? "It was interrupted before it could settle. Reclaim your entry from the wallet menu (top right)."
                : "The pool is distributed by final standings. Small fields credit your share to your balance directly. Large fields settle a Merkle root, claimed from the wallet menu (top right)."}
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
          <li>Create or join. Every entrant pays the same entry into the onchain pool.</li>
          <li>
            The organizer starts a round-robin. Your board opens by itself each round, and a
            seat that doesn&apos;t show up within a minute forfeits.
          </li>
          <li>
            The pool is distributed by final standings, using the prize structure the
            organizer set when they created it: small fields directly, large fields via a
            Merkle claim.
          </li>
          <li>If it never settles, every entrant reclaims their entry after a timeout.</li>
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
            <span className="muted">Entry (USDC)</span>
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
          <button className="primary" onClick={create} disabled={!!payoutErr}>
            Create
          </button>
        </div>
        <div className="offer-form" style={{ marginTop: 10 }}>
          <label className="of-field">
            <span className="muted">Prizes</span>
            <select
              value={payoutChoice}
              onChange={(e) => setPayoutChoice(e.target.value)}
              style={{ minWidth: 190 }}
            >
              {PAYOUT_PRESETS.map((p) => (
                <option key={p.label} value={p.label}>
                  {p.label}
                </option>
              ))}
              <option value={CUSTOM_PAYOUT}>Custom…</option>
            </select>
          </label>
          <label className="of-field">
            <span className="muted">Who can join</span>
            <select
              value={admission}
              onChange={(e) => setAdmission(e.target.value as Admission)}
              style={{ minWidth: 170 }}
            >
              <option value="open">Anyone</option>
              <option value="invite">Invite code only</option>
              <option value="approval">I approve each entrant</option>
            </select>
          </label>
          {payoutChoice === CUSTOM_PAYOUT && (
            <label className="of-field" style={{ flex: 1 }}>
              <span className="muted">Shares, best first (%)</span>
              <input
                value={payoutCustom}
                onChange={(e) => setPayoutCustom(e.target.value)}
                placeholder="50, 30, 20"
              />
            </label>
          )}
        </div>
        {admission !== "open" && !token && (
          <div className="muted" style={{ fontSize: 12, marginTop: 4, color: "#e0a06c" }}>
            Sign in (top right) first — minting codes and approving entrants are the
            organizer&apos;s, so a gated tournament needs one.
          </div>
        )}
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {payoutErr ? (
            <span style={{ color: "#e06c6c" }}>{payoutErr}</span>
          ) : (
            <>
              Pays {formatPayout("bps" in payoutDraft ? payoutDraft.bps : [])} of the pool.
              Entrants level on score split their places&apos; share equally, and a field
              smaller than the structure shares the whole pool between whoever turned up.
            </>
          )}
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
            None yet. Create one above, or watch engines free in <Link href="/play">Test Engine</Link>.
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
                      <Terms t={t} />{" "}
                      {t.admission !== "open" && (
                        <>
                          ·{" "}
                          <span
                            className="tag"
                            title={
                              t.admission === "invite"
                                ? "You need an invite code from the organizer"
                                : "The organizer approves each entrant"
                            }
                          >
                            {t.admission === "invite" ? "invite only" : "approval"}
                          </span>{" "}
                        </>
                      )}
                      · {t.players.length} entrant{t.players.length === 1 ? "" : "s"}
                      {t.total_rounds > 0 &&
                        ` · round ${Math.min(t.current_round + 1, t.total_rounds)}/${t.total_rounds}`}
                      {t.status !== "open" && leader && leader.score > 0 && (
                        <> · leader {entrantLabel(t, leader.player)} {leader.score}</>
                      )}
                    </div>
                  </div>
                  <div className="tc-actions">
                    {t.status === "open" &&
                      !joined &&
                      t.admission === "open" &&
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
  // Only show money when the server sent a table for THIS field — the prizes
  // array is index-aligned with standings, and a mismatched length means an
  // older server or a stale poll. Guessing would put numbers on screen that the
  // contract has no intention of sending.
  const prizes = t.buy_in && t.prizes.length === t.standings.length ? t.prizes : null;
  return (
    <div className="panel">
      <b style={{ color: "var(--text-strong)" }}>Standings</b>
      {t.buy_in && (
        <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
          Prizes: {payoutLabel(t)}
          {prizes ? (decided ? " · final" : " · if it ended now") : ""}
        </div>
      )}
      <table className="standings">
        <thead>
          <tr>
            <th>#</th>
            <th>Entrant</th>
            <th>Score</th>
            <th>Played</th>
            {prizes && <th>Prize</th>}
          </tr>
        </thead>
        <tbody>
          {t.standings.map((s: Standing, i: number) => (
            <tr key={s.player} className={sameEntrant(s.player, me) ? "me" : undefined}>
              {/* Equal scores share the place — honest only because the pool
                  shares the money to match. While payouts went strictly by
                  position, two gold medals here meant 65% and 25% in the
                  wallets, decided by who joined first. */}
              <td title={s.tied ? "Level on score: shares the prize for these places" : undefined}>
                {decided && s.rank === 1 ? "🥇" : s.rank}
                {s.tied && <span className="muted">*</span>}
              </td>
              <td>
                {entrantLabel(t, s.player)}
                {s.bot && <span className="muted"> 🤖</span>}
                {sameEntrant(s.player, me) && <span className="muted"> (you)</span>}
              </td>
              <td>{s.score}</td>
              <td className="muted">
                {s.played}
                {t.total_rounds > 0 ? `/${t.players.length - 1}` : ""}
              </td>
              {prizes && (
                <td className={prizes[i] === "0" ? "muted" : undefined}>
                  {prizes[i] === "0" ? "—" : `${fmtUsdc(prizes[i])} USDC`}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {t.standings.some((s) => s.tied) && (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          * Level on score{t.buy_in ? ", so they split the prize for those places equally" : ""}.
        </div>
      )}
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
                  {entrantLabel(t, g.white)}
                </span>
                <span className="muted"> vs </span>
                <span className={g.result === "black" ? "won" : g.result === "white" ? "lost" : ""}>
                  {entrantLabel(t, g.black)}
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
