"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAccount } from "wagmi";

import { BankrollPanel } from "@/components/BankrollPanel";
import { SeatGame } from "@/components/SeatGame";
import { SERVER_HTTP } from "@/lib/config";
import { authToken, fetchConfig, fmtUsdc, parseUsdc, type OnchainConfig } from "@/lib/escrow";
import { useAvailable } from "@/lib/useBankroll";
import { TIME_CONTROLS, type TimeControl } from "@/lib/timeControls";

function tryParse(s: string): bigint | null {
  try {
    return parseUsdc(s);
  } catch {
    return null;
  }
}
const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const TC_NAME: Record<string, string> = {
  "1+0": "Bullet",
  "3+0": "Blitz",
  "5+0": "Blitz",
  "10+0": "Rapid",
};

type Offer = {
  offer_id: string;
  poster_addr: string | null;
  stake: string | null;
  initial_secs: number;
  increment_secs: number;
};
type LiveGame = {
  game_id: string;
  mode: string;
  white: string | null;
  black: string | null;
  stake: string | null;
  initial_secs: number;
  increment_secs: number;
};
type Active = { gameId: string; token: string; color: "white" | "black"; stake?: string | null };
type Pending = { offerId: string; label: string; stakeBase: string | null };

/** The casual-first play lobby: pick a time control to play instantly or open a
 *  challenge (your engine vs theirs), watch games in progress, or stake USDC. */
export function Lobby() {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const [config, setConfig] = useState<OnchainConfig | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [live, setLive] = useState<LiveGame[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const [pickTc, setPickTc] = useState<TimeControl | null>(null); // stake modal open
  const [modalStake, setModalStake] = useState("");
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [active, setActive] = useState<Active | null>(null);

  useEffect(() => {
    fetchConfig().then(setConfig);
  }, []);
  useEffect(() => {
    setToken(authToken());
  }, [address, isConnected]);

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
        if (alive) setErr("server unreachable");
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
        const r = await fetch(`${SERVER_HTTP}/park/offers/${pending.offerId}`, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        if (!r.ok || !alive) return;
        const j = await r.json();
        if (j.status === "matched" && j.game_id && j.token) {
          setActive({
            gameId: j.game_id,
            token: j.token,
            color: (j.color as "white" | "black") ?? "white",
            stake: pending.stakeBase,
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
  const wagerOn = !!config?.wagerEnabled && !!config?.escrow;

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
    setCreating(true);
    try {
      const r = await fetch(`${SERVER_HTTP}/park/offers`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ stake: stakeBase, initial_secs: tc.initial, increment_secs: tc.inc }),
      });
      if (!r.ok) return setErr(`Couldn't post the game (${r.status}).`);
      const j = await r.json();
      setPending({
        offerId: j.offer_id,
        label: `${tc.label} · ${wantStake ? `${stakeStr} USDC` : "free"}`,
        stakeBase: stakeBase ?? null,
      });
      setPickTc(null);
    } catch {
      setErr("Server unreachable.");
    } finally {
      setCreating(false);
    }
  };

  const acceptOffer = async (o: Offer) => {
    setErr(null);
    const wagered = !!o.stake;
    if (wagered && !token) return setErr("Connect a wallet and sign in to join a staked game.");
    try {
      const r = await fetch(`${SERVER_HTTP}/park/offers/${o.offer_id}/accept`, {
        method: "POST",
        headers: wagered ? { authorization: `Bearer ${token}` } : {},
      });
      if (!r.ok)
        return setErr(
          r.status === 502
            ? "Couldn't lock stakes on-chain — check both players have deposited enough."
            : `Couldn't join (${r.status}).`,
        );
      const j = await r.json();
      setActive({
        gameId: j.game_id,
        token: j.token,
        color: (j.color as "white" | "black") ?? "black",
        stake: o.stake,
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
        onDone={() => setActive(null)}
      />
    );
  }

  return (
    <>
      {/* Play: pick a time control */}
      <div className="quick-play" style={{ marginBottom: 16 }}>
        {pending ? (
          <div>
            <div className="qp-head">
              <span className="mc-title">Waiting for an opponent…</span>
            </div>
            <div className="qp-desc muted">
              Your <b>{pending.label}</b> game is posted. Your engine starts automatically when
              someone joins.
            </div>
            <button className="ghost" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        ) : (
          <>
            <div className="qp-head">
              <span className="mc-icon">♟</span>
              <span className="mc-title">Play</span>
              <span className="mc-tag">free · in your browser</span>
            </div>
            <div className="qp-desc muted">
              Pick a time control — play instantly against the house, or open a challenge for
              another player{wagerOn ? " (free or for a USDC stake)" : ""}.
            </div>
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
            No one’s waiting right now — post a game above and the next player joins you.
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
              {offers.map((o) => {
                const mine = !!address && o.poster_addr?.toLowerCase() === address.toLowerCase();
                return (
                  <tr key={o.offer_id}>
                    <td>{o.poster_addr ? short(o.poster_addr) : "casual"}</td>
                    <td>{o.stake ? `${fmtUsdc(o.stake)} USDC` : "Free"}</td>
                    <td>
                      {o.initial_secs / 60}+{o.increment_secs}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {mine ? (
                        <span className="muted">yours</span>
                      ) : o.stake && available != null && available < BigInt(o.stake) ? (
                        <span className="muted" title="Deposit more USDC to join">
                          need {fmtUsdc(o.stake)}
                        </span>
                      ) : (
                        <button className="ghost" onClick={() => acceptOffer(o)}>
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
                    {g.white && g.black ? `${short(g.white)} vs ${short(g.black)}` : "engine vs engine"}
                  </td>
                  <td>{g.stake ? `${fmtUsdc(g.stake)} USDC` : "Free"}</td>
                  <td>
                    {g.initial_secs / 60}+{g.increment_secs}
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

      {/* Optional: deposit for staked play */}
      {wagerOn && config?.escrow && (
        <BankrollPanel escrow={config.escrow} chainId={config.chainId} />
      )}

      {/* Stake modal (opens after picking a time control) */}
      {pickTc && (
        <div className="modal-overlay" onClick={() => setPickTc(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">
              {pickTc.label} · {TC_NAME[pickTc.label] ?? "Custom"}
            </div>
            <button className="primary modal-play" onClick={() => playNow(pickTc)}>
              ⚡ Play now — free, vs the house
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
                Available {fmtUsdc(available)} USDC &lt; stake {fmtUsdc(modalStakeBig)} — deposit
                more first.
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
