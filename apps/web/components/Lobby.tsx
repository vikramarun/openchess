"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAccount } from "wagmi";

import { SeatGame } from "@/components/SeatGame";
import { shortAddress } from "@/lib/address";
import { loadBotOptions, useBotStatus } from "@/lib/bot";
import { browserSeat, ensureRepertoireLoaded } from "@/lib/browserBot";
import { prewarmPlayerEngine } from "@/lib/playerEngine";
import { authedFetch, SESSION_EXPIRED } from "@/lib/authedFetch";
import { SERVER_HTTP } from "@/lib/config";
import { BOT_OFFLINE_MSG, MAINTENANCE_MSG } from "@/lib/copy";
import { fmtUsdc, parseUsdc, profitForStake } from "@/lib/escrow";
import { acceptFromGroup, groupOffers, joinErrorMessage, type OfferGroup } from "@/lib/offers";
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

/** One seat's display: name if declared, else shortened wallet, else fallback. */
const seatLabel = (name: string | null, addr: string | null, fallback: string) =>
  name ?? shortAddress(addr, fallback);

/** The casual-first play lobby: pick a time control to play instantly or open a
 *  challenge (your engine vs theirs), watch games in progress, or stake USDC. */
export function Lobby() {
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

  // Poll open challenges + live games while in the lobby.
  useEffect(() => {
    if (active) return;
    let alive = true;
    const tick = async () => {
      try {
        const [o, l] = await Promise.all([
          fetch(`${SERVER_HTTP}/park/offers`).then((r) => (r.ok ? r.json() : [])),
          fetch(`${SERVER_HTTP}/games/live`).then((r) => (r.ok ? r.json() : [])),
        ]);
        if (alive) {
          setOffers(o);
          setLive(l);
        }
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
  }, [active]);

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
            color: (j.color as "white" | "black") ?? "white",
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

  const playNow = (tc: TimeControl) => {
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
        color: (j.color as "white" | "black") ?? "black",
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
      <div className="quick-play" style={{ marginBottom: 16 }}>
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
              Pick a time control. Play the OpenChess bot right now, or open a challenge for
              another player{wagerOn ? " (free or for a USDC stake)" : ""}.
              {!bot.online && (
                <>
                  {" "}
                  Want your own engine to play instead?{" "}
                  <Link href="/profile">Connect it</Link>.
                </>
              )}
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
          <div style={{ color: "#e06c6c", fontSize: 13, marginTop: 10 }}>{err}</div>
        )}
      </div>

      {/* Open challenges to join */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <b style={{ color: "var(--text-strong)" }}>Open challenges</b>
        {offers.length === 0 ? (
          <div className="muted" style={{ marginTop: 8 }}>
            No one’s waiting right now. Post a game above and the next player joins you.
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
                      {seatLabel(o.poster_name, o.poster_addr, "casual")}
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
                          <span className="tag tag-rated" title="Rated: affects Elo">
                            Rated
                          </span>
                        </>
                      ) : (
                        <>
                          Free{" "}
                          <span className="tag" title="Casual: does not affect Elo">
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
        <b style={{ color: "var(--text-strong)" }}>Live now</b>
        {live.length === 0 ? (
          <div className="muted" style={{ marginTop: 8 }}>
            No games in progress. Start one above.
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
                      const w = seatLabel(g.white_name, g.white, "");
                      const b = seatLabel(g.black_name, g.black, "");
                      const label = w && b ? `${w} vs ${b}` : "engine vs engine";
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
                        <span className="tag tag-rated">Rated</span>
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
              ⚡ Play the OpenChess bot, free
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
                  Rated. Non-custodial, settled onchain by the escrow contract.
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
              <div style={{ color: "#e0a96c", fontSize: 13 }}>
                Available {fmtUsdc(available)} USDC is under the {fmtUsdc(modalStakeBig)} stake.
                Deposit more first.
              </div>
            )}
            {err && <div style={{ color: "#e06c6c", fontSize: 13 }}>{err}</div>}
            <button className="modal-cancel muted" onClick={() => setPickTc(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}
