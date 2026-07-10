"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAccount } from "wagmi";

import { BankrollPanel } from "@/components/BankrollPanel";
import { SeatGame } from "@/components/SeatGame";
import { SERVER_HTTP } from "@/lib/config";
import { authToken, fetchConfig, fmtUsdc, parseUsdc, type OnchainConfig } from "@/lib/escrow";
import { useAvailable } from "@/lib/useBankroll";
import { DEFAULT_TC, TIME_CONTROLS, type TimeControl } from "@/lib/timeControls";

function tryParse(s: string): bigint | null {
  try {
    return parseUsdc(s);
  } catch {
    return null;
  }
}
const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

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

/** The casual-first play lobby: post/join open challenges (your engine vs
 *  theirs), watch games in progress, or run an instant engine-vs-engine game.
 *  Staking is optional — a blank stake is a free casual game. */
export function Lobby() {
  const { address, isConnected } = useAccount();
  const [config, setConfig] = useState<OnchainConfig | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [live, setLive] = useState<LiveGame[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const [stake, setStake] = useState("");
  const [tc, setTc] = useState<TimeControl>(DEFAULT_TC);
  const [creating, setCreating] = useState(false);
  const [pendingOffer, setPendingOffer] = useState<string | null>(null);
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

  // Poll a posted offer until an opponent accepts, then drop into the game.
  useEffect(() => {
    if (!pendingOffer) return;
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`${SERVER_HTTP}/park/offers/${pendingOffer}`, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        if (!r.ok || !alive) return;
        const j = await r.json();
        if (j.status === "matched" && j.game_id && j.token) {
          setActive({
            gameId: j.game_id,
            token: j.token,
            color: (j.color as "white" | "black") ?? "white",
            stake: stake ? parseUsdc(stake).toString() : null,
          });
          setPendingOffer(null);
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
  }, [pendingOffer, token, stake]);

  const { available } = useAvailable(config?.escrow);
  const wagerOn = !!config?.wagerEnabled && !!config?.escrow;
  const wantStake = stake.trim().length > 0;
  const stakeBig = wantStake ? tryParse(stake) : 0n;
  const postUnderfunded =
    wantStake && stakeBig != null && available != null && available < stakeBig;

  const createOffer = async () => {
    setErr(null);
    let stakeBase: string | undefined;
    if (wantStake) {
      if (!token) return setErr("Connect a wallet and sign in to post a staked game.");
      const amt = tryParse(stake);
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
      setPendingOffer((await r.json()).offer_id);
    } catch {
      setErr("Server unreachable.");
    } finally {
      setCreating(false);
    }
  };

  const acceptOffer = async (o: Offer) => {
    setErr(null);
    const wagered = !!o.stake;
    if (wagered && !token) return setErr("Connect a wallet and sign in to accept a staked game.");
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
      {/* Create / play now */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="lobby-head">
          <b style={{ color: "var(--text-strong)" }}>Start a game</b>
          <Link href="/play" className="ghost play-now">
            ⚡ Play now vs the house
          </Link>
        </div>
        <div className="muted" style={{ fontSize: 13, margin: "4px 0 10px" }}>
          Your in-browser engine plays. Post an open challenge and the next player’s engine
          faces yours{wagerOn ? " — leave the stake blank for a free game" : " (free)"}.
        </div>
        <div className="offer-form">
          <label className="of-field">
            <span className="muted">Stake (USDC)</span>
            <input
              inputMode="decimal"
              placeholder={wagerOn ? "blank = free casual game" : "casual only"}
              value={stake}
              onChange={(e) => setStake(e.target.value)}
              disabled={!wagerOn || creating || !!pendingOffer}
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
                  disabled={creating || !!pendingOffer}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </label>
          <button
            className="primary"
            onClick={createOffer}
            disabled={creating || !!pendingOffer || postUnderfunded}
          >
            {creating ? "Posting…" : wantStake ? "Post staked game" : "Post free game"}
          </button>
        </div>
        {postUnderfunded && stakeBig != null && (
          <div style={{ color: "#e0a96c", fontSize: 13, marginTop: 6 }}>
            Available {fmtUsdc(available)} USDC &lt; stake {fmtUsdc(stakeBig)} — deposit more below.
          </div>
        )}
        {pendingOffer && (
          <div className="muted" style={{ marginTop: 8 }}>
            Waiting for an opponent… your engine starts automatically when someone joins.{" "}
            <button className="ghost" style={{ padding: "2px 8px" }} onClick={() => setPendingOffer(null)}>
              Cancel
            </button>
          </div>
        )}
        {err && <div style={{ color: "#e06c6c", fontSize: 13, marginTop: 6 }}>{err}</div>}
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
    </>
  );
}
