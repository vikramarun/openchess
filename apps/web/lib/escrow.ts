// On-chain wager wiring for the web app. The escrow address + chain are
// single-sourced from the game server's GET /config, so there's no second
// place to configure them. USDC is read from the contract's token() getter.

import { formatUnits, parseUnits } from "viem";

import { SERVER_HTTP } from "./config";

export const USDC_DECIMALS = 6;

/** Minimal ChessEscrow ABI — only the user-facing bankroll functions. */
export const ESCROW_ABI = [
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "available", stateMutability: "view", inputs: [{ name: "user", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "bankroll", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "locked", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

/** Minimal ERC-20 ABI for USDC (approve + reads). */
export const ERC20_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export type OnchainConfig = {
  escrow: `0x${string}` | null;
  chainId: number;
  wagerEnabled: boolean;
};

let configCache: OnchainConfig | undefined;

/** Fetch the server's on-chain config (escrow address + expected chain). */
export async function fetchConfig(): Promise<OnchainConfig> {
  if (configCache !== undefined) return configCache;
  try {
    const r = await fetch(`${SERVER_HTTP}/config`);
    const j = await r.json();
    configCache = {
      escrow: j.escrow ? (j.escrow as `0x${string}`) : null,
      chainId: Number(j.chain_id ?? 8453),
      wagerEnabled: !!j.wager_enabled,
    };
  } catch {
    configCache = { escrow: null, chainId: 8453, wagerEnabled: false };
  }
  return configCache;
}

/** Fired (same-tab) whenever the stored session changes, so useAuthToken
 *  subscribers re-read instead of snapshotting a stale token. Cross-tab changes
 *  arrive via the native `storage` event. */
export const AUTH_EVENT = "chess-auth-changed";

function notifyAuthChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AUTH_EVENT));
}

/** The stored SIWE session token (set by the sign-in flow). */
export function authToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("chess_token");
}

/** The wallet address the stored session was issued for (lowercased), or null. */
export function authAddress(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("chess_addr");
}

/** Persist a SIWE session bound to the wallet it was issued for, and notify
 *  subscribers. */
export function setAuth(token: string, address: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem("chess_token", token);
  localStorage.setItem("chess_addr", address.toLowerCase());
  notifyAuthChanged();
}

/** Drop the stored SIWE session (on disconnect or account switch). */
export function clearAuth() {
  if (typeof window === "undefined") return;
  localStorage.removeItem("chess_token");
  localStorage.removeItem("chess_addr");
  notifyAuthChanged();
}

/** USDC display string (base units → "1.50"). */
export function fmtUsdc(base: bigint | string | number | undefined | null): string {
  if (base === undefined || base === null) return "—";
  try {
    return formatUnits(BigInt(base), USDC_DECIMALS);
  } catch {
    return "—";
  }
}

/** Parse a human USDC amount ("1.5") to base units. Throws on bad input. */
export function parseUsdc(human: string): bigint {
  return parseUnits(human.trim(), USDC_DECIMALS);
}
