// The escrow's per-tournament record, read in whichever layout the deployed
// contract has.
//
// A public mapping getter returns the struct's fields flat, so when the escrow
// gained `startedAt` (the two-clock lifecycle) the SAME `tournaments(bytes32)`
// call started returning 9 words instead of v2's 8. A fixed-ABI decode cannot
// serve both: against the new contract an 8-field decode read `startedAt` as
// `settled` (and threw — a timestamp is not a bool) and read `payoutRoot` as
// `exists` (so every open tournament looked nonexistent). The server reads it
// the same way (`decode_tournament` in crates/ledger), and the two contracts
// must both work while the redeploy is rolled out.

export type TournamentRecord = {
  buyIn: bigint;
  pool: bigint;
  openedAt: number;
  /** `null` on v2, which has no start transition — its one clock runs from
   *  `openedAt`. `0` means not started yet. */
  startedAt: number | null;
  settled: boolean;
  payoutRoot: `0x${string}`;
  exists: boolean;
};

/** Decode a raw `tournaments(bytes32)` return. Throws on any other width —
 *  a guess here is a refund button that reverts, or one that never appears. */
export function decodeTournament(data: `0x${string}`): TournamentRecord {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  if (hex.length % 64 !== 0) throw new Error(`tournaments() returned ${hex.length / 2} bytes, not whole words`);
  const words: string[] = [];
  for (let i = 0; i < hex.length; i += 64) words.push(hex.slice(i, i + 64));
  const big = (i: number) => BigInt(`0x${words[i]}`);
  const num = (i: number) => Number(big(i));
  const bool = (i: number) => big(i) !== 0n;
  const bytes32 = (i: number) => `0x${words[i]}` as `0x${string}`;
  switch (words.length) {
    case 8: // v2: buyIn pool claimed entrants openedAt settled payoutRoot exists
      return {
        buyIn: big(0),
        pool: big(1),
        openedAt: num(4),
        startedAt: null,
        settled: bool(5),
        payoutRoot: bytes32(6),
        exists: bool(7),
      };
    case 9: // two-clock: … openedAt startedAt settled payoutRoot exists
      return {
        buyIn: big(0),
        pool: big(1),
        openedAt: num(4),
        startedAt: num(5),
        settled: bool(6),
        payoutRoot: bytes32(7),
        exists: bool(8),
      };
    default:
      throw new Error(`tournaments() returned ${words.length} words; expected 8 (v2) or 9`);
  }
}

/** The instant after which entrants (and sponsors) may take their money back,
 *  as unix seconds — `claimRefund` / `refundSponsorship` succeed once
 *  `now > refundOpensAt(...)`. `null` when it can't be known yet (the
 *  two-clock contract's `entryWindow` hasn't been read).
 *
 *  - v2: one clock, `openedAt + settleTimeout`.
 *  - Two-clock, never started: refunds open when the right to start lapses,
 *    at `openedAt + entryWindow` — hours, not a day.
 *  - Two-clock, started: `startedAt + settleTimeout`. */
export function refundOpensAt(
  t: TournamentRecord,
  settleTimeout: number,
  entryWindow: number | null,
): number | null {
  if (t.startedAt === null) return t.openedAt + settleTimeout;
  if (t.startedAt === 0) return entryWindow === null ? null : t.openedAt + entryWindow;
  return t.startedAt + settleTimeout;
}
