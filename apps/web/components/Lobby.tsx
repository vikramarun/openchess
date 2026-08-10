"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAccount } from "wagmi";

import { SeatGame } from "@/components/SeatGame";
import { playerLabel } from "@/lib/playerLabel";
import { loadBotOptions, useBotStatus } from "@/lib/bot";
import { browserSeat, ensureRepertoireLoaded } from "@/lib/browserBot";
import { prewarmPlayerEngine } from "@/lib/playerEngine";
import { authedFetch, SESSION_EXPIRED } from "@/lib/authedFetch";
import { SERVER_HTTP } from "@/lib/config";
import { BOT_OFFLINE_MSG, MAINTENANCE_MSG } from "@/lib/copy";
import { fmtUsdc, parseUsdc, profitForStake } from "@/lib/escrow";
import {
  acceptFromGroup,
  groupOffers,
  houseOfferGroup,
  joinErrorMessage,
  seatColor,
  type OfferGroup,
} from "@/lib/offers";
import { useAuthToken } from "@/lib/useAuthToken";
import { useAvailable } from "@/lib/useBankroll";
import { useOnchainConfig } from "@/lib/useOnchainConfig";
import { TC_NAME, TIME_CONTROLS, tcLabel, type TimeControl } from "@/lib/timeControls";

function tryParse(s: string): bigint | null {
  try {
    return parseUsdc(s);
  } catch {
    return null;
  }
}

type Offer = {
  offer_id: string;
  poster_addr: string | null;
  poster_name: string | null;
  poster_engine: string | null;
  stake: string | null;
  initial_secs: number;
  increment_secs: number;
};
type LiveGame = {
  game_id: string;
  mode: string;
  white: string | null;
  black: string | null;
  white_name: string | null;
  black_name: string | null;
  white_engine: string | null;
  black_engine: string | null;
  stake: string | null;
  initial_secs: number;
  increment_secs: number;
};
type Active = {
  gameId: string;
  token: string;
  color: "white" | "black";
  stake?: string | null;
  /** Who we drew, resolved server-side, for the pre-game confirmation. */
  opponent?: { name: string; declared_engine?: string | null } | null;
  initialSecs?: number;
  incrementSecs?: number;
};
type Pending = {
  offerId: string;
  cancelKey: string | null;
  label: string;
  stakeBase: string | null;
  bot: boolean;
  initialSecs: number;
  incrementSecs: number;
};

/** One seat's display. `name` is the server-resolved username for that wallet
 *  (never a string the poster chose), so this is username → shortened wallet →
 *  fallback. See `lib/playerLabel.ts`. */
const seatLabel = (name: string | null, addr: string | null, fallback: string) =>
  playerLabel({ name, address: addr, fallback });

/** The casual-first play lobby: pick a time control to play instantly or open a
 *  challenge (your engine vs theirs), watch games in progress, or stake USDC.
 *
 *  `onActiveChange` reports whether a board is currently mounted here, so the
 *  page can drop the marketing header while you're playing. It's a callback
 *  rather than the page owning the state because the hero has to stay in the
 *  SERVER render — this component is client-only (`useMounted` in page.tsx),
 *  and moving the <h1> inside it would take the landing page's only heading
 *  out of the HTML.
 *
 *  `view` selects WHICH sections render, and nothing else: "quickplay" is the
 *  homepage's Play card, "browse" is /lobby's open-challenges and live tables.
 *  It is one component with two views rather than two components because this
 *  one owns the live-game session — the `active → <SeatGame>` swap, the
 *  pre-game confirm gate, and the join walk — and BOTH views have to be able to
 *  open a board (quickplay starts one; joining an open challenge starts one).
 *  Splitting that state in two would duplicate the money path. The early return
 *  below therefore sits ABOVE the view gate, so a board opens identically from
 *  either. */
export function Lobby({
  onActiveChange,
  view = "quickplay",
}: {
  onActiveChange?: (active: boolean) => void;
  view?: "quickplay" | "browse";
}) {
  const router = useRouter();
  const { address } = useAccount();
  const token = useAuthToken();
  const { config, wagerOn } = useOnchainConfig();
  const [offers, setOffers] = useState<Offer[]>([]);
  const [live, setLive] = useState<LiveGame[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const [pickTc, setPickTc] = useState<TimeControl | null>(null); // stake modal open
  const [modalStake, setModalStake] = useState("");
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [active, setActive] = useState<Active | null>(null);
  const [useBot, setUseBot] = useState(true); // prefer the bot when it's online

  const bot = useBotStatus(token);
  const botPlays = bot.online && useBot;

  useEffect(() => {
    onActiveChange?.(!!active);
  }, [active, onActiveChange]);

  // Poll open challenges + live games while in the lobby.
  //
  // Only in the browse view: these two tables are the only things that read
  // `offers`/`live`, and before the split every visitor who merely LANDED on the
  // homepage polled both endpoints every 3 seconds for as long as the tab
  // stayed open.
  useEffect(() => {
    if (active || view !== "browse") return;
    let alive = true;
    const tick = async () => {
      try {
        const [ro, rl] = await Promise.all([
          fetch(`${SERVER_HTTP}/park/offers`),
          fetch(`${SERVER_HTTP}/games/live`),
        ]);
        // A non-OK response (most likely a 429 when many clients share one IP)
        // carries no data — HOLD the last snapshot rather than replacing it with
        // an empty array, which would render "no open challenges / nobody live"
        // and silently degrade the house-bot Play card to its demo. Only a
        // thrown fetch is real unreachability, handled below.
        const o = ro.ok ? await ro.json() : null;
        const l = rl.ok ? await rl.json() : null;
        if (!alive) return;
        if (o !== null) setOffers(o);
        if (l !== null) setLive(l);
        // Reaching here at all means the server ANSWERED, so retract the
        // unreachable banner — without this a 3-second blip left a red error
        // latched under the Play card while the lobby quietly repopulated
        // behind it. Deliberately not gated on both responses being OK: a 429
        // is the server talking, and gating on `ok` would leave "Server
        // unreachable." pinned under a working lobby for as long as one
        // endpoint stayed throttled. Only the connectivity message is cleared —
        // a join error stays until the user acts.
        setErr((e) => (e === "Server unreachable." ? null : e));
      } catch {
        if (alive) setErr("Server unreachable.");
      }
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [active, view]);

  // Poll a posted offer until an opponent joins, then drop into the game.
  useEffect(() => {
    if (!pending) return;
    let alive = true;
    const tick = async () => {
      try {
        const r = await authedFetch(`${SERVER_HTTP}/park/offers/${pending.offerId}`);
        if (!r.ok || !alive) return;
        const j = await r.json();
        if (j.status === "matched" && j.game_id) {
          if (j.seat === "bot") {
            // The bot got the seat — the browser just watches.
            setPending(null);
            router.push(`/game/${j.game_id}`);
            return;
          }
          if (!j.token) {
            // Browser seat but no token: our session is no longer authorized
            // (expired sign-in). Never silently spectate a seat we own.
            setPending(null);
            setErr("Your sign-in expired while you were waiting. Sign in again to start a new game.");
            return;
          }
          setActive({
            gameId: j.game_id,
            token: j.token,
            // Posting no longer implies White — read the drawn side off the
            // wire. Never refuse the seat over it; see `seatColor`.
            color: seatColor(j.color),
            stake: pending.stakeBase,
            opponent: j.opponent ?? null,
            initialSecs: pending.initialSecs,
            incrementSecs: pending.incrementSecs,
          });
          setPending(null);
        }
      } catch {
        /* keep polling */
      }
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [pending, token]);

  const { available } = useAvailable(config?.escrow);

  const modalStakeBig = modalStake.trim() ? tryParse(modalStake) : 0n;
  const modalUnderfunded =
    !!modalStake.trim() && modalStakeBig != null && available != null && available < modalStakeBig;

  // The quickplay view does not poll (see above), so `offers` is empty here and
  // `houseSeat` below would always be null — the modal would promise the
  // self-play demo even with a house seat standing, then hand you a real game
  // against the bot, because playNow's own fallback fetch finds it. One read
  // when the modal opens is all the label needs, and it costs a request per
  // modal open rather than one every three seconds per visitor.
  useEffect(() => {
    if (view !== "quickplay" || !pickTc) return;
    let alive = true;
    // Re-read on every open / clock change, not just when `offers` is empty: a
    // house seat can be taken or the bot can go offline between opens, and a
    // once-only fetch would keep promising "Play the House Bot" from stale ids
    // for the whole mount, then drop the clicker into the demo instead. Hold the
    // last list on a non-OK response rather than blanking it.
    fetch(`${SERVER_HTTP}/park/offers`)
      .then((r) => (r.ok ? r.json() : null))
      .then((o) => {
        if (alive && o !== null) setOffers(o);
      })
      .catch(() => {
        /* the label falls back to the demo wording, which playNow honours */
      });
    return () => {
      alive = false;
    };
  }, [view, pickTc]);

  // Whether the House Bot has a free seat standing at the picked clock — it
  // decides what the modal's instant-play button honestly promises.
  const houseSeat = pickTc
    ? houseOfferGroup(groupOffers(offers), pickTc.initial, pickTc.inc, config?.houseWallet)
    : null;

  // "Play the bot" means a real seat against the house, not the self-play
  // demo: take the House Bot's standing free offer for this clock through the
  // normal join walk. Only when no house seat stands (all taken, or the bot is
  // down) does it fall back to /play — and the button says so.
  const playNow = async (tc: TimeControl) => {
    setErr(null);
    // ALWAYS read fresh before committing to a real seat vs the demo — the
    // cached `offers` can be seconds-to-minutes stale (the modal may have sat
    // open), and acting on a dead house-seat id gives a join error instead of
    // either a game or the demo fallback. A failed read falls back to `offers`.
    let pool = offers;
    try {
      const r = await fetch(`${SERVER_HTTP}/park/offers`);
      if (r.ok) pool = await r.json();
    } catch {
      /* keep the cached list; fall through to the demo if it yields no seat */
    }
    const group = houseOfferGroup(groupOffers(pool), tc.initial, tc.inc, config?.houseWallet);
    if (group) return acceptOffer(group);
    router.push(`/play?tc=${encodeURIComponent(tc.label)}`);
  };

  const postChallenge = async (tc: TimeControl, stakeStr: string) => {
    setErr(null);
    let stakeBase: string | undefined;
    const wantStake = stakeStr.trim().length > 0;
    if (wantStake) {
      if (!token) return setErr("Connect a wallet and sign in to stake.");
      const amt = tryParse(stakeStr);
      if (amt == null || amt <= 0n) return setErr("Enter a valid USDC stake.");
      stakeBase = amt.toString();
    }
    if (botPlays && !token) return setErr("Sign in to play with your bot.");
    // Prove the engine works BEFORE any money is committed. Building it after
    // the offer is accepted means a failed 7 MB download forfeits an escrowed
    // stake through the server's never-started reap — and nothing about that
    // failure is the player's fault. A browser seat with no working engine
    // simply must not create an offer.
    if (!botPlays) {
      try {
        setCreating(true);
        await prewarmPlayerEngine();
        await ensureRepertoireLoaded();
      } catch {
        setCreating(false);
        return setErr("Your engine couldn't load — nothing was staked. Check your connection and try again.");
      }
    }
    setCreating(true);
    try {
      const r = await authedFetch(`${SERVER_HTTP}/park/offers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stake: stakeBase,
          initial_secs: tc.initial,
          increment_secs: tc.inc,
          ...(botPlays ? { seat: "bot", uci_options: loadBotOptions() } : browserSeat()),
        }),
      });
      if (!r.ok)
        return setErr(
          r.status === 401
            ? SESSION_EXPIRED
            : r.status === 503
              ? MAINTENANCE_MSG
              : r.status === 424
                ? BOT_OFFLINE_MSG
                : `Couldn’t post the game (${r.status}).`,
        );
      const j = await r.json();
      setPending({
        offerId: j.offer_id,
        cancelKey: j.cancel_key ?? null,
        label: `${tc.label} · ${wantStake ? `${stakeStr} USDC` : "free"}`,
        stakeBase: stakeBase ?? null,
        bot: botPlays,
        initialSecs: tc.initial,
        incrementSecs: tc.inc,
      });
      setPickTc(null);
    } catch {
      setErr("Server unreachable.");
    } finally {
      setCreating(false);
    }
  };

  const acceptOffer = async (group: OfferGroup<Offer>) => {
    const o = group.offer;
    setErr(null);
    const wagered = !!o.stake;
    if (wagered && !token) return setErr("Connect a wallet and sign in to join a staked game.");
    if (botPlays && !token) return setErr("Sign in to play with your bot.");
    if (!botPlays) {
      // Same gate on the accept side: accepting locks stakes immediately.
      try {
        await prewarmPlayerEngine();
        await ensureRepertoireLoaded();
      } catch {
        return setErr("Your engine couldn't load — nothing was staked. Check your connection and try again.");
      }
    }
    try {
      // A row can stand for several identical seats (the house bot posts one
      // per concurrent autopilot), so losing the race for the first is not a
      // failure while another is free. The walk and the status wording both
      // live in lib/offers.ts, where they are tested. That is where the bug was
      // that told a user with a mid-game bot that someone stole the seat.
      const r = await acceptFromGroup(group.ids, (id) =>
        authedFetch(`${SERVER_HTTP}/park/offers/${id}/accept`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            botPlays ? { seat: "bot", uci_options: loadBotOptions() } : browserSeat(),
          ),
        }),
      );
      if (!r) return; // empty group: unreachable, but never fall through as OK
      if (!r.ok) return setErr(joinErrorMessage(r.status, { botPlays }));
      const j = await r.json();
      if (j.seat === "bot" || !j.token) {
        // The bot plays this seat; watch the game live.
        router.push(`/game/${j.game_id}`);
        return;
      }
      setActive({
        gameId: j.game_id,
        token: j.token,
        // Accepting no longer implies Black, same as the poster's path above.
        color: seatColor(j.color),
        stake: o.stake,
        opponent: j.opponent ?? { name: seatLabel(o.poster_name, o.poster_addr, "casual") },
        initialSecs: o.initial_secs,
        incrementSecs: o.increment_secs,
      });
    } catch {
      setErr("Server unreachable.");
    }
  };

  if (active) {
    return (
      <SeatGame
        gameId={active.gameId}
        token={active.token}
        color={active.color}
        stake={active.stake}
        confirmStakes
        opponentPreview={active.opponent ?? null}
        initialSecs={active.initialSecs}
        incrementSecs={active.incrementSecs}
        onDone={() => setActive(null)}
      />
    );
  }

  return (
    <>
      {/* Play: pick a time control */}
      {/* `.quick-play` is a legacy class name — it styles THIS lobby card, not
          the /play page that used to share the name (now "Test Engine"). */}
      {view === "quickplay" && (
      <div className="quick-play">
        {pending ? (
          <div>
            <div className="qp-head">
              <span className="mc-title">Waiting for an opponent…</span>
            </div>
            <div className="qp-desc muted">
              Your <b>{pending.label}</b> game is posted.{" "}
              {pending.bot
                ? "When someone joins, your bot plays it and you’ll be taken to the live board."
                : "Your engine starts automatically when someone joins."}
            </div>
            <button
              className="ghost"
              onClick={() => {
                // Withdraw the offer server-side so the lobby doesn't keep
                // showing a challenge nobody is waiting on.
                const { offerId, cancelKey } = pending;
                if (cancelKey) {
                  fetch(
                    `${SERVER_HTTP}/park/offers/${offerId}?key=${encodeURIComponent(cancelKey)}`,
                    { method: "DELETE" },
                  ).catch(() => {});
                }
                setPending(null);
              }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <>
            <div className="qp-head">
              <span className="mc-icon">♟</span>
              <span className="mc-title">Play</span>
              {bot.online ? (
                <span className="mc-tag" title={bot.engine ?? undefined}>
                  🤖 {bot.name ?? bot.engine} · {bot.busy ? "playing" : "online"}
                </span>
              ) : (
                <span className="mc-tag">free · in your browser</span>
              )}
            </div>
            <div className="qp-desc muted">
              Pick a time control. Play the House Bot right now, or open a challenge for
              another player{wagerOn ? " (free or for a USDC stake)" : ""}.
              {" "}
              Want your own engine to play instead? Customize Stockfish or connect your own{" "}
              <Link href="/profile#advanced">here</Link>.
            </div>
            {bot.online && (
              <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}>
                <span className="muted" style={{ fontSize: 13 }}>
                  Games are played by:
                </span>
                <button
                  className={useBot ? "primary" : "ghost"}
                  style={{ fontSize: 13, padding: "4px 10px" }}
                  onClick={() => setUseBot(true)}
                >
                  🤖 Your bot{bot.engine ? ` (${bot.engine})` : ""}
                </button>
                <button
                  className={!useBot ? "primary" : "ghost"}
                  style={{ fontSize: 13, padding: "4px 10px" }}
                  onClick={() => setUseBot(false)}
                >
                  🌐 Browser engine
                </button>
              </div>
            )}
            <div className="tc-grid">
              {TIME_CONTROLS.map((t) => (
                <button
                  key={t.label}
                  className="tc-tile"
                  onClick={() => {
                    setErr(null);
                    setModalStake("");
                    setPickTc(t);
                  }}
                >
                  <span className="tc-clock">{t.label}</span>
                  <span className="tc-name">{TC_NAME[t.label] ?? "Custom"}</span>
                </button>
              ))}
            </div>
          </>
        )}
        {err && !pickTc && (
          <div className="lobby-err">{err}</div>
        )}
      </div>
      )}

      {view === "browse" && (
      <>
      {/* Open challenges to join */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">Open challenges</div>
        {offers.length === 0 ? (
          <div className="muted" style={{ marginTop: 8 }}>
            {/* "above" was right when this table sat under the Play card. It
                lives on /lobby now and the card doesn't. */}
            No one’s waiting right now. <Link href="/">Post a game</Link> and the next
            player joins you.
          </div>
        ) : (
          <table className="history-table" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>Challenger</th>
                <th>Stake</th>
                <th>Time</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {groupOffers(offers).map((group) => {
                const o = group.offer;
                const mine = !!address && o.poster_addr?.toLowerCase() === address.toLowerCase();
                return (
                  <tr key={o.offer_id}>
                    <td>
                      {/* "Anonymous", not "casual": a casual offer may have no
                          wallet at all, and now that the label is resolved from
                          one, that row would otherwise read as the word
                          "casual" — which looks like a bug rather than a
                          person. */}
                      {seatLabel(o.poster_name, o.poster_addr, "Anonymous")}
                      {o.poster_engine && (
                        <span className="muted" style={{ fontSize: 12 }}>
                          {" "}
                          🤖 {o.poster_engine}
                        </span>
                      )}
                      {group.ids.length > 1 && (
                        <span
                          className="muted"
                          style={{ fontSize: 12 }}
                          title="This challenger has more than one seat free at this time control"
                        >
                          {" "}
                          · {group.ids.length} seats free
                        </span>
                      )}
                    </td>
                    <td>
                      {o.stake ? (
                        <>
                          {fmtUsdc(o.stake)} USDC{" "}
                          <span
                            className="tag tag-rated"
                            title="Ranked: USDC staked, moves your ranked Elo"
                          >
                            Ranked
                          </span>
                        </>
                      ) : (
                        <>
                          Free{" "}
                          <span
                            className="tag"
                            title="Casual: moves your casual Elo, never your ranked one"
                          >
                            Casual
                          </span>
                        </>
                      )}
                    </td>
                    <td>
                      {tcLabel(o.initial_secs, o.increment_secs)}
                      <div className="muted" style={{ fontSize: 11 }}>
                        {TC_NAME[tcLabel(o.initial_secs, o.increment_secs)] ?? "Custom"}
                      </div>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {mine ? (
                        <span className="muted">yours</span>
                      ) : o.stake && available != null && available < BigInt(o.stake) ? (
                        <span className="muted" title="Deposit more USDC to join">
                          need {fmtUsdc(o.stake)}
                        </span>
                      ) : (
                        <button className="ghost" onClick={() => acceptOffer(group)}>
                          Join &amp; play
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Live games to watch */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">Live now</div>
        {live.length === 0 ? (
          <div className="muted" style={{ marginTop: 8 }}>
            No games in progress. <Link href="/">Start one</Link>.
          </div>
        ) : (
          <table className="history-table" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>Players</th>
                <th>Stake</th>
                <th>Time</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {live.map((g) => (
                <tr key={g.game_id}>
                  <td>
                    {(() => {
                      // Each seat falls back on its own. Reading `w && b` threw
                      // away the OTHER seat's real name whenever one was
                      // anonymous, collapsing a half-known matchup to "engine vs
                      // engine" — rare while names were declared, common now
                      // that an unnamed seat is the default.
                      const w = seatLabel(g.white_name, g.white, "Anonymous");
                      const b = seatLabel(g.black_name, g.black, "Anonymous");
                      const label = `${w} vs ${b}`;
                      const engines = [g.white_engine, g.black_engine].filter(Boolean).join(" vs ");
                      return (
                        <>
                          {label}
                          {engines && (
                            <div className="muted" style={{ fontSize: 12 }}>
                              🤖 {engines}
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </td>
                  <td>
                    {g.stake ? (
                      <>
                        {fmtUsdc(g.stake)} USDC{" "}
                        <span className="tag tag-rated">Ranked</span>
                      </>
                    ) : (
                      <>
                        Free <span className="tag">Casual</span>
                      </>
                    )}
                  </td>
                  <td>
                    {tcLabel(g.initial_secs, g.increment_secs)}
                    <div className="muted" style={{ fontSize: 11 }}>
                      {TC_NAME[tcLabel(g.initial_secs, g.increment_secs)] ?? "Custom"}
                    </div>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <Link href={`/game/${g.game_id}`} className="ghost">
                      Watch
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* The quickplay card carries this error inline; browse has no card to put
          it in, and a silently empty pair of tables reads as "nobody is here"
          rather than "the server is unreachable". */}
      {err && <div className="lobby-err">{err}</div>}
      </>
      )}

      {/* Stake modal (opens after picking a time control) */}
      {pickTc && (
        <div className="modal-overlay" onClick={() => setPickTc(null)}>
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={`New ${pickTc.label} game`}
          >
            <div className="modal-title">
              {pickTc.label} · {TC_NAME[pickTc.label] ?? "Custom"}
            </div>
            <button className="primary modal-play" onClick={() => playNow(pickTc)}>
              {houseSeat ? "⚡ Play the House Bot, free" : "⚡ Watch an engine demo, free"}
            </button>
            <div className="modal-div">or open a challenge for another player</div>
            {wagerOn && (
              <input
                inputMode="decimal"
                placeholder="stake in USDC (blank = free)"
                value={modalStake}
                onChange={(e) => setModalStake(e.target.value)}
                disabled={creating}
                autoFocus
              />
            )}
            {wagerOn && modalStakeBig != null && modalStakeBig > 0n && (
              <div className="stake-callout">
                Win <b>+{fmtUsdc(profitForStake(modalStakeBig))} USDC</b>. That’s your
                opponent’s stake, less a 1% fee. A draw or a no-show returns yours.
                <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
                  Ranked. Non-custodial, settled onchain by the escrow contract.
                </div>
              </div>
            )}
            <button
              className="ghost modal-post"
              onClick={() => postChallenge(pickTc, modalStake)}
              disabled={creating || modalUnderfunded}
            >
              {creating
                ? "Posting…"
                : modalStake.trim()
                  ? "Post staked challenge"
                  : "Post free challenge"}
            </button>
            {modalUnderfunded && modalStakeBig != null && (
              <div className="lobby-warn">
                Available {fmtUsdc(available)} USDC is under the {fmtUsdc(modalStakeBig)} stake.
                Deposit more first.
              </div>
            )}
            {err && <div className="lobby-err">{err}</div>}
            <button className="modal-cancel muted" onClick={() => setPickTc(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}
