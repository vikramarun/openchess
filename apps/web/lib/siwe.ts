import { SERVER_HTTP } from "./config";
import { setAuth } from "./escrow";
import { withSession } from "./session";

/** Shown when the server issued a session but the browser wouldn't keep its
 *  cookie. Almost always a deployment whose game server isn't on the same site
 *  as the web app (a SameSite cookie can't cross sites), so say that rather
 *  than leave a sign-in that "worked" and then 401s everything. */
export const COOKIE_REFUSED =
  "Signed in, but this browser didn't keep the session cookie. " +
  "Allow cookies for this site and try again.";

/** Run the SIWE flow: fetch nonce, sign an EIP-4361 message, verify. The server
 *  answers with the session as an httpOnly cookie, never a token this page
 *  could read (lib/session.ts); `signMessageAsync` comes from
 *  useDynamicSigner. Resolves once the session is confirmed usable. */
export async function signInWithEthereum(
  address: string,
  chainId: number,
  signMessageAsync: (args: { message: string }) => Promise<string>,
): Promise<void> {
  const nonce = (await (await fetch(`${SERVER_HTTP}/auth/nonce`)).json()).nonce;
  // The chain id must match the actually-connected chain (hardcoding it breaks
  // Base Sepolia / any non-8453 chain). The domain (location.host) must match
  // the server's SIWE_DOMAIN.
  const message = [
    `${location.host} wants you to sign in with your Ethereum account:`,
    address,
    "",
    "Sign in to OpenChess.",
    "",
    `URI: ${location.origin}`,
    "Version: 1",
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join("\n");

  const signature = await signMessageAsync({ message });
  const resp = await fetch(`${SERVER_HTTP}/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // `cookie: true` asks for the session as a cookie and keeps the token out
    // of the body; `credentials: "include"` is what lets the browser store a
    // cookie from a cross-origin response at all.
    body: JSON.stringify({ message, signature, cookie: true }),
    credentials: "include",
  });
  if (!resp.ok) throw new Error(`sign-in failed (${resp.status})`);
  // The page can't see an httpOnly cookie, so ask the server whether it came
  // back. Recording a session the browser silently dropped would show the
  // player as signed in while every authed call 401s and signs them out again.
  const me = await fetch(`${SERVER_HTTP}/auth/me`, withSession());
  if (!me.ok) throw new Error(COOKIE_REFUSED);
  // Bind the session to the wallet it was issued for (so a disconnect or account
  // switch can invalidate it) and notify useSession subscribers.
  setAuth(address);
}
