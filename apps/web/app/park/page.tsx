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

/** Parse a USDC amount to base units, or null if invalid. */
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
  stake: string | null;
  initial_secs: number;
  increment_secs: number;
};

type Active = {
  gameId: string;
  token: string;
  color: "white" | "black";
  stake?: string | null;
};

export default function ParkPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div className="container">
      <div className="hero" style={{ paddingBottom: 8 }}>
        <h1>🅿️ Park / Patzer</h1>
        <p>
          Post a game at a price. Someone accepts, both stake, the winner takes the pot
          minus a small rake — settled non-custodially on Base.
        </p>
      </div>
      {mounted ? <ParkClient /> : null}
    </div>
  );
}

function ParkClient() {
  const { address, isConnected } = useAccount();
  const [config, setConfig] = useState<OnchainConfig | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [err, setErr] = useState<string | null>(null);

  // Create-offer form
  const [stake, setStake] = useState("");
  const [tc, setTc] = useState<TimeControl>(DEFAULT_TC);
  const [creating, setCreating] = useState(false);
  const [pendingOffer, setPendingOffer] = useState<string | null>(null); // waiting for accept

  const [active, setActive] = useState<Active | null>(null);

  useEffect(() => {
    fetchConfig().then(setConfig);
  }, []);
  // Re-read the SIWE token (set by the header Sign-in) on mount + when the
  // connected wallet changes.
  useEffect(() => {
    setToken(authToken());
  }, [address, isConnected]);

  // Poll the open-offer lobby.
  useEffect(() => {
    if (active) return;
    let live = true;
    const tick = async () => {
      try {
        const r = await fetch(`${SERVER_HTTP}/park/offers`);
        if (r.ok && live) setOffers(await r.json());
      } catch {
        if (live) setErr("server unreachable");
      }
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [active]);

  // While we have a pending (posted) offer, poll it until an opponent accepts.
  useEffect(() => {
    if (!pendingOffer) return;
    let live = true;
    const tick = async () => {
      try {
        const r = await fetch(`${SERVER_HTTP}/park/offers/${pendingOffer}`, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        if (!r.ok || !live) return;
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
      live = false;
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
      if (!token) return setErr("Sign in (top right) to post a staked game.");
      try {
        const amt = parseUsdc(stake);
        if (amt <= 0n) return setErr("Stake must be positive.");
        stakeBase = amt.toString();
      } catch {
        return setErr("Enter a valid USDC stake.");
      }
    }
    setCreating(true);
    try {
      const r = await fetch(`${SERVER_HTTP}/park/offers`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          stake: stakeBase,
          initial_secs: tc.initial,
          increment_secs: tc.inc,
        }),
      });
      if (!r.ok) {
        setErr(`Couldn't post offer (${r.status}).`);
        return;
      }
      const j = await r.json();
      setPendingOffer(j.offer_id);
    } catch {
      setErr("Server unreachable.");
    } finally {
      setCreating(false);
    }
  };

  const acceptOffer = async (o: Offer) => {
    setErr(null);
    const wagered = !!o.stake;
    if (wagered && !token) {
      setErr("Sign in (top right) to accept a staked game.");
      return;
    }
    try {
      const r = await fetch(`${SERVER_HTTP}/park/offers/${o.offer_id}/accept`, {
        method: "POST",
        headers: wagered ? { authorization: `Bearer ${token}` } : {},
      });
      if (!r.ok) {
        setErr(
          r.status === 502
            ? "Couldn't lock stakes on-chain — check both players have deposited enough."
            : `Couldn't accept (${r.status}).`,
        );
        return;
      }
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

  // ---- Playing one's seat in the browser ----
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

  // ---- Lobby ----
  return (
    <>
      <div className="panel" style={{ marginBottom: 16 }}>
        <b style={{ color: "var(--text-strong)" }}>How it works</b>
        <ol className="muted" style={{ lineHeight: 1.8, marginBottom: 0 }}>
          <li>Connect a wallet and deposit USDC into the escrow once.</li>
          <li>Post an offer at a stake + time control (your seat is bound to your wallet).</li>
          <li>An opponent accepts and stakes; both engines play in-browser.</li>
          <li>The signed result settles on-chain — winner takes the pot.</li>
        </ol>
      </div>

      {!wagerOn && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <span className="muted">
            This server isn’t configured for on-chain wagering, so only casual (free) games
            can be posted here. Try <Link href="/play">Quick Play</Link> to watch engines
            battle for free.
          </span>
        </div>
      )}

      {wagerOn && config?.escrow && (
        <div style={{ marginBottom: 16 }}>
          <BankrollPanel escrow={config.escrow} chainId={config.chainId} />
        </div>
      )}

      <div className="panel" style={{ marginBottom: 16 }}>
        <b style={{ color: "var(--text-strong)" }}>Post a game</b>
        <div className="offer-form">
          <label className="of-field">
            <span className="muted">Stake (USDC)</span>
            <input
              inputMode="decimal"
              placeholder={wagerOn ? "e.g. 1.00 (blank = casual)" : "casual only"}
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
            {creating ? "Posting…" : wantStake ? "Post staked game" : "Post casual game"}
          </button>
        </div>
        {postUnderfunded && stakeBig != null && (
          <div style={{ color: "#e0a96c", fontSize: 13, marginTop: 6 }}>
            Available balance {fmtUsdc(available)} USDC &lt; stake {fmtUsdc(stakeBig)} — deposit
            more above.
          </div>
        )}
        {pendingOffer && (
          <div className="muted" style={{ marginTop: 8 }}>
            Waiting for an opponent to accept… your engine will start automatically.{" "}
            <button
              className="ghost"
              style={{ padding: "2px 8px" }}
              onClick={() => setPendingOffer(null)}
            >
              Stop waiting
            </button>
          </div>
        )}
        {err && <div style={{ color: "#e06c6c", fontSize: 13, marginTop: 6 }}>{err}</div>}
      </div>

      <div className="panel">
        <b style={{ color: "var(--text-strong)" }}>Open offers</b>
        {offers.length === 0 ? (
          <div className="muted" style={{ marginTop: 8 }}>
            No open offers right now — post one above.
          </div>
        ) : (
          <table className="history-table" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>Poster</th>
                <th>Stake</th>
                <th>Time</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {offers.map((o) => {
                const mine =
                  !!address && o.poster_addr?.toLowerCase() === address.toLowerCase();
                return (
                  <tr key={o.offer_id}>
                    <td>{o.poster_addr ? `${o.poster_addr.slice(0, 8)}…` : "casual"}</td>
                    <td>{o.stake ? `${fmtUsdc(o.stake)} USDC` : "—"}</td>
                    <td>
                      {o.initial_secs / 60}+{o.increment_secs}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {mine ? (
                        <span className="muted">your offer</span>
                      ) : o.stake && available != null && available < BigInt(o.stake) ? (
                        <span className="muted" title="Deposit more USDC to accept">
                          need {fmtUsdc(o.stake)}
                        </span>
                      ) : (
                        <button className="ghost" onClick={() => acceptOffer(o)}>
                          Accept &amp; play
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
    </>
  );
}
