"use client";

import { useDynamicContext } from "@dynamic-labs/sdk-react-core";
import Link from "next/link";
import { useAccount } from "wagmi";

import { dynamicConfigured } from "@/lib/dynamicEnv";
import { useAuthToken } from "@/lib/useAuthToken";
import { useMounted } from "@/lib/useMounted";
import { useOnchainConfig } from "@/lib/useOnchainConfig";

/** Three states, not two. "checking" is what stops a signed-in player from
 *  seeing a flash of the sign-in wall on every navigation: the answer depends on
 *  localStorage (client-only) and on `/config` (a fetch), and neither exists
 *  during the server render. */
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
        <button className="primary gate-cta" onClick={() => setShowAuthFlow(true)}>
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
 *  nothing, so the page doesn't jump when the answer lands. */
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
  if (state === "in") return <>{children}</>;
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
