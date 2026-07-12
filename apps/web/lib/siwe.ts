import { SERVER_HTTP } from "./config";

/** Run the SIWE flow: fetch nonce, sign an EIP-4361 message, verify, store the
 *  session token. `signMessageAsync` comes from wagmi's useSignMessage. */
export async function signInWithEthereum(
  address: string,
  chainId: number,
  signMessageAsync: (args: { message: string }) => Promise<string>,
): Promise<string> {
  const nonce = (await (await fetch(`${SERVER_HTTP}/auth/nonce`)).json()).nonce;
  // The chain id must match the actually-connected chain (hardcoding it breaks
  // Base Sepolia / any non-8453 chain). The domain (location.host) must match
  // the server's SIWE_DOMAIN.
  const message = [
    `${location.host} wants you to sign in with your Ethereum account:`,
    address,
    "",
    "Sign in to Chess Wager.",
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
    body: JSON.stringify({ message, signature }),
  });
  if (!resp.ok) throw new Error(`sign-in failed (${resp.status})`);
  const { token } = await resp.json();
  localStorage.setItem("chess_token", token);
  // Bind the session to the wallet it was issued for, so a disconnect or account
  // switch can invalidate a stale token (see clearAuth / authAddress in escrow.ts).
  localStorage.setItem("chess_addr", address.toLowerCase());
  return token;
}
