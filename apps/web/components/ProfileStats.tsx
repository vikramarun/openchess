"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { AvatarEditor } from "@/components/AvatarEditor";
import { isAddress, shortAddress } from "@/lib/address";
import { avatarUrl } from "@/lib/avatar";
import { SERVER_HTTP } from "@/lib/config";
import { fmtUsdc, fmtUsdcSigned } from "@/lib/escrow";
import {
  BUCKETS,
  bucketOf,
  gamesQuery,
  hasBuckets,
  pageKey,
  pickStats,
  winRate,
  type Bucket,
  type GameItem,
  type Profile,
} from "@/lib/profileFilter";


function outcome(g: GameItem, me: string): "win" | "loss" | "draw" | "-" {
  if (g.result === "draw") return "draw";
  const iWhite = g.white?.toLowerCase() === me;
  const iBlack = g.black?.toLowerCase() === me;
  if ((iWhite && g.result === "white") || (iBlack && g.result === "black")) return "win";
  if (iWhite || iBlack) return "loss";
  return "-";
}

/** Public rating + record + game history for a wallet. Rendered by the public
 *  /player/[address] page and by the signed-in /profile hub.
 *
 *  Everything below the header is scoped by an All / Casual / Ranked switcher,
 *  because the two ladders are genuinely separate: a free game moves the casual
 *  Elo and a staked one (or a buy-in tournament) moves the ranked Elo, and
 *  summing their records answers a question nobody asked. `lib/profileFilter`
 *  owns the partitioning — including what to do when the server predates the
 *  split and sends neither bucket.
 *
 *  `editable` adds the profile-photo controls, and is only ever set on your own
 *  profile — the write itself is bound to the SIWE session server-side, so this
 *  decides what is offered, not what is allowed. */
export function ProfileStats({ address, editable }: { address: string; editable?: boolean }) {
  const me = address.toLowerCase();
  const [p, setP] = useState<Profile | null>(null);
  const [bucket, setBucket] = useState<Bucket>("all");
  // Fetched pages, keyed by WALLET AND ladder — each ladder is its own server
  // page (the 50-row limit applies after the filter), so they can't be derived
  // from one another, and the wallet has to be in the key because it can change
  // under a mounted component: `/profile` passes it as a prop from the
  // connected account, so switching wallets changes it with no navigation at
  // all. Keyed on the ladder alone, the "already fetched" check below would
  // then skip the refetch and leave the previous wallet's games on screen,
  // under a header that had already updated to the new one.
  const [games, setGames] = useState<Record<string, GameItem[]>>({});
  const page = pageKey(me, bucket);
  const [err, setErr] = useState<string | null>(null);
  // Bumped after a photo change to refetch the profile: the new
  // `avatar_updated_at` is what busts the cached image URL.
  const [reload, setReload] = useState(0);
  const onPhotoChanged = useCallback(() => setReload((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    // Validate the wallet before interpolating it into the API path — a route
    // param is user-controlled, so reject anything that isn't a hex address.
    if (!isAddress(me)) {
      setErr("That isn’t a valid wallet address.");
      return;
    }
    (async () => {
      try {
        const seg = encodeURIComponent(me);
        const pr = await fetch(`${SERVER_HTTP}/players/${seg}`).then((r) => r.json());
        if (live) setP(pr);
      } catch {
        if (live) setErr("Couldn’t load the profile. Is the server running?");
      }
    })();
    return () => {
      live = false;
    };
    // `reload` refetches this half only: a photo change moves
    // `avatar_updated_at`, and nothing else here depends on it.
  }, [me, reload]);

  useEffect(() => {
    let live = true;
    if (!isAddress(me)) return;
    if (games[page]) return; // already fetched this wallet's ladder
    (async () => {
      try {
        const seg = encodeURIComponent(me);
        const gr = await fetch(`${SERVER_HTTP}/players/${seg}/games${gamesQuery(bucket)}`).then(
          (r) => r.json(),
        );
        if (live) setGames((g) => ({ ...g, [page]: Array.isArray(gr) ? gr : [] }));
      } catch {
        if (live) setErr("Couldn’t load the profile. Is the server running?");
      }
    })();
    return () => {
      live = false;
    };
    // No `reload`: changing your photo doesn't change 50 games of history.
  }, [me, bucket, page, games]);

  const stats = pickStats(p, bucket);
  const rows = games[page];
  const netClass = Number(stats.net) > 0 ? "pos" : Number(stats.net) < 0 ? "neg" : "";
  const photo = avatarUrl(me, p?.avatar_updated_at);
  // Free games stake nothing, so a Net USDC tile on the casual view is a
  // permanent 0.00 that reads like a bug. Drop it (and the Stake column) there.
  const showNet = bucket !== "casual";
  // An old server sends no buckets; offering a switcher that can't switch
  // anything would be worse than not offering one.
  const split = hasBuckets(p);

  return (
    <>
      <div className="profile-head">
        <div className="avatar">
          {/* Plain <img>: next/image would want this remote host in its config
              and buys nothing for one already-256px square. Empty alt — the
              wallet right next to it is the label, so a screen reader
              announcing the photo again would only be noise. */}
          {photo ? <img src={photo} alt="" /> : "♟"}
        </div>
        <div>
          <div className="who">{shortAddress(me)}</div>
          <div className="muted" style={{ fontSize: 13, wordBreak: "break-all" }}>
            {me}
          </div>
          {editable && (
            <AvatarEditor hasPhoto={Boolean(p?.avatar_updated_at)} onChanged={onPhotoChanged} />
          )}
        </div>
        {/* Both ladders, always. They're two facts about this wallet, not two
            views of one — swapping which is on screen would make the headline
            number change meaning as you click the switcher. */}
        <div className="rating-pair">
          <div className="stat" style={{ opacity: bucket === "casual" ? 0.5 : 1 }}>
            <div className="v">{p ? p.rating : "…"}</div>
            <div className="l">Ranked Elo</div>
          </div>
          {p?.casual_rating !== undefined && (
            <div className="stat" style={{ opacity: bucket === "casual" ? 1 : 0.5 }}>
              <div className="v">{p.casual_rating}</div>
              <div className="l">Casual Elo</div>
            </div>
          )}
        </div>
      </div>

      {err && <div className="panel" style={{ color: "var(--danger)" }}>{err}</div>}

      {split && (
        // A group of buttons, not a tablist: /profile already owns a real
        // `role="tablist"` directly above this, and a second one would nest two
        // roving-tabindex widgets inside each other.
        <div className="seg" role="group" aria-label="Game type">
          {BUCKETS.map((b) => (
            <button
              key={b.id}
              type="button"
              className={`seg-btn${bucket === b.id ? " on" : ""}`}
              aria-pressed={bucket === b.id}
              onClick={() => setBucket(b.id)}
            >
              {b.label}
            </button>
          ))}
        </div>
      )}

      <div className={`stat-grid${showNet ? "" : " cols-3"}`}>
        <div className="stat">
          <div className="v">{p ? stats.games : "…"}</div>
          <div className="l">Games</div>
        </div>
        <div className="stat">
          <div className="v">{p ? `${winRate(stats)}%` : "…"}</div>
          <div className="l">Win rate</div>
        </div>
        <div className="stat">
          <div className="v">
            {p ? (
              <span>
                <span style={{ color: "var(--accent)" }}>{stats.wins}</span> /{" "}
                <span style={{ color: "var(--danger)" }}>{stats.losses}</span> / {stats.draws}
              </span>
            ) : (
              "…"
            )}
          </div>
          <div className="l">W / L / D</div>
        </div>
        {showNet && (
          <div className="stat">
            <div className={`v ${netClass}`}>{p ? fmtUsdcSigned(stats.net) : "…"}</div>
            <div className="l">Net USDC</div>
          </div>
        )}
      </div>

      <div className="panel">
        <div style={{ fontWeight: 700, color: "var(--text-strong)", marginBottom: 10 }}>
          Game History
        </div>
        {!rows ? (
          <div className="muted">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="muted">
            {bucket === "ranked"
              ? "No finished ranked games yet — stake a game or enter a buy-in tournament."
              : bucket === "casual"
                ? "No finished casual games yet."
                : "No finished games yet."}
          </div>
        ) : (
          <div className="table-scroll">
            <table className="history-table">
            <thead>
              <tr>
                <th>Mode</th>
                {/* Only in the combined view: inside a single ladder every row
                    carries the same tag, which is noise. */}
                {bucket === "all" && <th>Type</th>}
                <th>Opponent</th>
                <th>Result</th>
                {showNet && <th>Stake</th>}
                <th>Moves</th>
                <th>Date</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => {
                const oc = outcome(g, me);
                const opp = g.white?.toLowerCase() === me ? g.black : g.white;
                const ranked = bucketOf(g) === "ranked";
                return (
                  <tr key={g.game_id}>
                    <td>{g.mode}</td>
                    {bucket === "all" && (
                      <td>
                        <span className={`tag${ranked ? " tag-rated" : ""}`}>
                          {ranked ? "Ranked" : "Casual"}
                        </span>
                      </td>
                    )}
                    <td>
                      {opp ? (
                        <Link href={`/player/${opp.toLowerCase()}`}>{shortAddress(opp)}</Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <span className={`pill ${oc}`}>
                        {oc === "win" ? "W" : oc === "loss" ? "L" : oc === "draw" ? "½" : "-"}
                      </span>{" "}
                      <span className="muted">{g.reason}</span>
                    </td>
                    {showNet && <td>{g.stake ? fmtUsdc(g.stake) : "—"}</td>}
                    <td>{g.moves}</td>
                    <td className="muted">
                      {g.finished_at ? new Date(g.finished_at).toLocaleDateString() : "—"}
                    </td>
                    <td>
                      <Link href={`/game/${g.game_id}`}>Review ▸</Link>
                    </td>
                  </tr>
                );
              })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
