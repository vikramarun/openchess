import { SERVER_HTTP } from "./config";

/** Run the SIWE flow: fetch nonce, sign an EIP-4361 message, verify, store the
 *  session token. `signMessageAsync` comes from wagmi's useSignMessage. */
export async function signInWithEthereum(
  address: string,
  signMessageAsync: (args: { message: string }) => Promise<string>,
): Promise<string> {
  const nonce = (await (await fetch(`${SERVER_HTTP}/auth/nonce`)).json()).nonce;
  const message = [
    `${location.host} wants you to sign in with your Ethereum account:`,
    address,
    "",
    "Sign in to Chess Wager.",
    "",
    `URI: ${location.origin}`,
    "Version: 1",
    "Chain ID: 8453",
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
  return token;
}
