"use client";

import Link from "next/link";
import { useCallback, useState } from "react";

import { Leaderboard } from "@/components/Leaderboard";
import { Lobby } from "@/components/Lobby";
import { RequireSignIn } from "@/components/SignInGate";
import { useMounted } from "@/lib/useMounted";

/** Everything you browse rather than start: open challenges to join, games in
 *  progress to watch, the ranked ladder, and the two staked modes.
 *
 *  Split off the homepage so the landing page could be a demo and one Play
 *  card. This is also where the 3-second polls for /park/offers and /games/live
 *  now live — before the split every visitor who merely LANDED ran both.
 *
 *  Joining from here opens a board exactly as the homepage does: <Lobby> owns
 *  the session either way (see its `view` prop), so the same `inGame` teardown
 *  applies — a live board must not sit under a page of browse tables. */
export default function LobbyPage() {
  const mounted = useMounted();
  const [inGame, setInGame] = useState(false);
  // Stable identity: Lobby reports through this from an effect, and a fresh
  // callback each render would re-run it every render.
  const onActiveChange = useCallback((active: boolean) => setInGame(active), []);

  return (
    <div className="container">
      {inGame ? (
        // The only heading this page has is hidden while you play, which would
        // leave the document with none. Visually there's a whole board saying it.
        <h1 className="sr-only">Your game</h1>
      ) : (
        <div className="page-head">
          <h1 className="display d2">Lobby</h1>
          <p className="muted">
            Join a challenge someone is already waiting on, or watch two engines settle it.
          </p>
        </div>
      )}

      {/* Signed-in only, all of it. The two tables here are a join button and a
          live-game list, and joining is the whole point of the page — showing
          the room to someone who can't enter it is the same dead end the old
          "Sign in to stake" error was, one click later. A shared game link
          (/game/[id]) stays public: that is a finished, verifiable record, not
          a door. */}
      {mounted ? (
        <RequireSignIn
          title="Sign in to see the lobby"
          lede="Open challenges, live games and the ranked ladder. Joining any of them seats you in a real game, so it needs an account."
        >
          <LobbyBody inGame={inGame} onActiveChange={onActiveChange} />
        </RequireSignIn>
      ) : null}
    </div>
  );
}

/** The signed-in half of /lobby. Split out so `RequireSignIn` wraps one child
 *  rather than three siblings, and so the mode cards and the leaderboard sit
 *  behind the same gate as the tables they belong to. */
function LobbyBody({
  inGame,
  onActiveChange,
}: {
  inGame: boolean;
  onActiveChange: (active: boolean) => void;
}) {
  return (
    <>
      <Lobby view="browse" onActiveChange={onActiveChange} />

      {!inGame && (
        <>
          <div className="mode-grid">
            <Link href="/gauntlet" className="mode-card">
              <div className="mc-top">
                <span className="mc-icon">🔥</span>
                <span className="mc-title">Gauntlet</span>
                <span className="mc-tag money">stakes</span>
              </div>
              <div className="mc-desc">
                Your engine plays back-to-back games at a fixed tier until you stop. Lock a
                balance once, net-settle onchain.
              </div>
            </Link>

            <Link href="/tournament" className="mode-card">
              <div className="mc-top">
                <span className="mc-icon">🏆</span>
                <span className="mc-title">Tournament</span>
                <span className="mc-tag money">stakes</span>
              </div>
              <div className="mc-desc">
                Pay one entry into a prize pool. Round-robin now, Swiss and knockout soon. The
                pool is distributed onchain by final standings.
              </div>
            </Link>
          </div>

          <Leaderboard />
        </>
      )}
    </>
  );
}
