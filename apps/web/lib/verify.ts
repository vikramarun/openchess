// Client-side verification of a game result. The server (oracle) signs the
// game's result_hash; we recover the signer and check it equals the published
// oracle address — non-repudiable proof the oracle attested this result.

import { recoverMessageAddress } from "viem";

import { SERVER_HTTP } from "./config";

let oracleCache: string | null | undefined;

export async function getOracle(): Promise<string | null> {
  if (oracleCache !== undefined) return oracleCache ?? null;
  try {
    const r = await fetch(`${SERVER_HTTP}/oracle`);
    const j = await r.json();
    oracleCache = j.address ? String(j.address).toLowerCase() : null;
  } catch {
    oracleCache = null;
  }
  return oracleCache ?? null;
}

export type Verification = { signed: boolean; oracle: string | null };

export async function verifyResultSig(
  resultHash: string,
  serverSig?: string | null,
): Promise<Verification> {
  const oracle = await getOracle();
  if (!serverSig || !oracle) return { signed: false, oracle };
  try {
    const recovered = await recoverMessageAddress({
      message: resultHash,
      signature: serverSig as `0x${string}`,
    });
    return { signed: recovered.toLowerCase() === oracle.toLowerCase(), oracle };
  } catch {
    return { signed: false, oracle };
  }
}

export function shortAddr(a: string | null): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "";
}
