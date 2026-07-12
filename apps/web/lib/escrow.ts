// On-chain wager wiring for the web app. The escrow address + chain are
// single-sourced from the game server's GET /config, so there's no second
// place to configure them. USDC is read from the contract's token() getter.

import { formatUnits, parseUnits } from "viem";

import { SERVER_HTTP } from "./config";

export const USDC_DECIMALS = 6;

/** Minimal ChessEscrow ABI — the user-facing bankroll + tournament claim
 *  functions and the getters the claim UI reads. */
export const ESCROW_ABI = [
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "available", stateMutability: "view", inputs: [{ name: "user", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "bankroll", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "locked", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  // Tournament payout (root-settled fields) — winner claims their signed share.
  { type: "function", name: "claimTournament", stateMutability: "nonpayable", inputs: [{ name: "tid", type: "bytes32" }, { name: "account", type: "address" }, { name: "amount", type: "uint256" }, { name: "proof", type: "bytes32[]" }], outputs: [] },
  // Reclaim a buy-in from a tournament that never settled past the timeout.
  { type: "function", name: "claimRefund", stateMutability: "nonpayable", inputs: [{ name: "tid", type: "bytes32" }, { name: "account", type: "address" }], outputs: [] },
  // tournaments(tid) → (buyIn, pool, claimedAmount, entrants, openedAt, settled, payoutRoot, exists)
  { type: "function", name: "tournaments", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }], outputs: [{ name: "buyIn", type: "uint256" }, { name: "pool", type: "uint256" }, { name: "claimedAmount", type: "uint256" }, { name: "entrants", type: "uint32" }, { name: "openedAt", type: "uint64" }, { name: "settled", type: "bool" }, { name: "payoutRoot", type: "bytes32" }, { name: "exists", type: "bool" }] },
  { type: "function", name: "tournamentClaimed", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }, { name: "", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "tournamentEntered", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }, { name: "", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "settleTimeout", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
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

/** UUID → on-chain tournament id: the 16 UUID bytes left-aligned in a bytes32
 *  (right-padded with zeros), matching the server's `game_id_to_bytes32`. */
export function tidToBytes32(uuid: string): `0x${string}` {
  const hex = uuid.replace(/-/g, "").toLowerCase();
  return `0x${hex}${"0".repeat(32)}` as `0x${string}`;
}

/** A winner's Merkle claim: the signed payout amount + its proof path. */
export type ClaimProof = { amount: bigint; proof: `0x${string}`[] };

/** Fetch a winner's Merkle claim proof for a root-settled tournament. Returns
 *  null when the address isn't a winner or the tournament isn't root-settled
 *  (the server answers 404). */
export async function fetchClaimProof(tid: string, address: string): Promise<ClaimProof | null> {
  try {
    const r = await fetch(`${SERVER_HTTP}/tournaments/${tid}/claim/${address}`);
    if (!r.ok) return null;
    const j = await r.json();
    return { amount: BigInt(j.amount), proof: (j.proof ?? []) as `0x${string}`[] };
  } catch {
    return null;
  }
}
