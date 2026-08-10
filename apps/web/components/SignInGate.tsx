"use client";

import { useDynamicContext } from "@dynamic-labs/sdk-react-core";
import Link from "next/link";
import { useState } from "react";
import { useAccount } from "wagmi";

import { dynamicConfigured } from "@/lib/dynamicEnv";
import { useLiveSeats } from "@/lib/liveSeat";
import { markSignInIntent } from "@/lib/signInIntent";
import { useAuthToken } from "@/lib/useAuthToken";
import { useMounted } from "@/lib/useMounted";
import { useOnchainConfig } from "@/lib/useOnchainConfig";

/** Three states, not two. "checking" is what stops a signed-in player from
 *  seeing a flash of the sign-in wall on every navigation: the answer lives in
 *  localStorage, which is client-only, so neither the server render nor the
 *  first client render can see a session that exists. */
export type AuthState = "checking" | "in" | "out";

/** Is this visitor signed in enough to be seated?
 *
 *  A held SIWE session answers "yes" immediately, with no wait on `/config` —
 *  that is the whole reason this isn't `!!token && configLoaded`. Every route
 *  that matters is gated on this hook, so making a returning player watch a
 *  round trip before their own lobby renders would tax the common case to serve
 *  the empty one.
 *
 *  Nothing here BLOCKS on `/config` either, and that is the more important
 *  half. `useOnchainConfig` retries a failed fetch forever with backoff, so a
 *  version of this that answered "checking" until the config landed turned an
 *  unreachable game server into a permanently blank page on every gated route —
 *  strictly worse than the sign-in prompt, which at least says what the page is.
 *  Unknown config is therefore read as the production truth (wagering on, a
 *  session required), and the `wagerOn === false` branch — a dev node with no
 *  escrow, which issues no sessions at all, where a connected wallet is the
 *  strongest credential that exists — resolves one config fetch later. */
export function useAuthState(): AuthState {
  const mounted = useMounted();
  const token = useAuthToken();
  const { config, wagerOn } = useOnchainConfig();
  const { isConnected, address } = useAccount();

  if (token) return "in";
  // The one genuinely unknowable moment: localStorage is client-only, so the
  // server render and the first client render cannot see a session that exists.
  if (!mounted) return "checking";
  if (config && !wagerOn && isConnected && address) return "in";
  return "out";
}

/** The wall a signed-out visitor gets on Play, Lobby, Gauntlet and Tournament.
 *
 *  Rendered in place of the page's content rather than redirected to, so the
 *  route keeps its own metadata and the back button behaves. Every one of those
 *  four either seats a player in a game that lands in someone's history and
 *  moves an Elo, or locks USDC — none of it can be done anonymously, and the
 *  old behaviour (let them in, fail at the last step with "Sign in to stake")
 *  spent the visitor's time before telling them.
 *
 *  Test Engine is the deliberate exception and is always linked from here: it is
 *  two engines on your own CPU, seats nobody, and is what "try it first" means
 *  in this app. */
export function SignInGate({
  title,
  children,
}: {
  /** What they're being asked to sign in FOR — the page they landed on. */
  title: string;
  /** One or two sentences on what's behind the wall. */
  children?: React.ReactNode;
}) {
  const { setShowAuthFlow } = useDynamicContext();
  return (
    <div className="panel gate">
      <div className="gate-title display d3">{title}</div>
      <p className="gate-lede muted">{children}</p>
      {dynamicConfigured ? (
        <button
          className="primary gate-cta"
          onClick={() => {
            // The gesture that authorizes wallet prompts for the rest of this
            // page-load (lib/signInIntent.ts). It also covers the visitor whose
            // wallet is ALREADY silently reconnected: for them the Dynamic modal
            // may have nothing to show, and it is the header's auto-complete
            // effect — armed by this mark — that carries them into the SIWE
            // signature.
            markSignInIntent();
            setShowAuthFlow(true);
          }}
        >
          Sign in
        </button>
      ) : (
        // providers.tsx omits Dynamic entirely without an environment id, so
        // there is no modal to open. Say so instead of rendering a dead button.
        <div className="lobby-err">Sign-in isn’t configured on this deployment.</div>
      )}
      <p className="gate-alt muted">
        Email or Google works — a wallet is created for you, and you can play free games
        without ever funding it. Or{" "}
        <Link href="/play">watch two engines play</Link> first, no account needed.
      </p>
    </div>
  );
}

/** `SignInGate` calls a Dynamic hook, and Dynamic's context is `undefined` when
 *  the provider is omitted (see lib/dynamicEnv.ts) — a hook read against that
 *  throws and the root error boundary blanks the page. This is the wrapper every
 *  page uses: it renders the gate only through a branch that is safe.
 *
 *  `checking` renders a placeholder of roughly the gate's height rather than
 *  nothing, so the page doesn't jump when the answer lands.
 *
 *  **THE LATCH GUARDS BOARDS, NOT SESSIONS.** Once this has admitted someone it
 *  keeps rendering its children for as long as a LIVE BOARD is mounted under it,
 *  even if the session goes away — and re-walls the page the moment the visitor
 *  is signed out with no board open. The two halves matter equally.
 *
 *  Why the hold exists: these children own live games. `<SeatGame>` lives under
 *  here, so any of the ordinary ways a token disappears mid-game — `authedFetch`
 *  dropping a stale one on a 401, the 24h session TTL lapsing, a wallet
 *  disconnect or account switch in the header firing `clearAuth` — would
 *  otherwise unmount the board and close its socket. A seat that is GONE
 *  (rather than merely idle) hands the opponent a forfeit win and the whole
 *  stake (`room.rs reap_forfeit_winner`), so a session quietly expiring would
 *  confiscate the stake of someone who was sitting right there playing. That is
 *  the same failure the decline path is careful to avoid, arriving by a
 *  different route. `SeatGame` declares itself via `useLiveSeatHold`
 *  (lib/liveSeat.ts), and while any hold is open this gate will not retract.
 *
 *  Why the re-wall exists: with no board open, "admitted" is just a stale
 *  answer. Signing out of the lobby and still seeing the lobby shipped once —
 *  and the sign-out that matters most arrives through Dynamic's profile widget,
 *  which at our layer is indistinguishable from a wallet-side disconnect, so
 *  there is no reliable "the user chose this" signal to key on. Keying on the
 *  BOARD instead makes every sign-out path honest at once, and what it protects
 *  is exactly the thing the latch was ever for.
 *
 *  Nothing else is lost: this gate is product UX, and the server is the
 *  authority — every route these pages call re-checks the session itself and
 *  401s, which `authedFetch` surfaces as "your sign-in expired". */
export function RequireSignIn({
  title,
  lede,
  children,
}: {
  title: string;
  lede: React.ReactNode;
  children: React.ReactNode;
}) {
  const state = useAuthState();
  // How many live boards are mounted right now. Subscribed, not just read: a
  // signed-out player finishing a game must see the wall come back when the
  // board unmounts, and that release is what re-renders this component.
  const liveSeats = useLiveSeats();
  // Adjusted during render rather than in an effect: an effect runs after paint,
  // so a retracting session would flash the wall over a live board for a frame
  // before this put it back. React re-renders immediately on a set during
  // render, without painting the discarded result.
  const [admitted, setAdmitted] = useState(false);
  if (state === "in" && !admitted) setAdmitted(true);
  // The un-latch, same discipline. Signed out AND no live board → the wall is
  // the truth again, whichever way the session ended (our sign-out button,
  // Dynamic's widget, a wallet disconnect, a 401 dropping the token). While a
  // board is open the latch holds and the game is untouchable — see the
  // component comment and lib/liveSeat.ts.
  if (state === "out" && admitted && liveSeats === 0) setAdmitted(false);

  if (state === "in" || admitted) return <>{children}</>;
  if (state === "checking") return <div className="gate gate-skeleton" aria-hidden="true" />;
  if (!dynamicConfigured) {
    return (
      <div className="panel gate">
        <div className="gate-title display d3">{title}</div>
        <div className="lobby-err">Sign-in isn’t configured on this deployment.</div>
      </div>
    );
  }
  return <SignInGate title={title}>{lede}</SignInGate>;
}
