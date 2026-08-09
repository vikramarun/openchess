/** Tournament prize structures: basis points per finishing place, best first.
 *
 *  The rules here MIRROR the server's `PayoutSpec::validate`
 *  (crates/server/src/matchmaking.rs). The server is the authority — this copy
 *  exists so a creator gets a sentence explaining what's wrong instead of a bare
 *  400 after the form round-trips. If the two ever disagree, the server wins and
 *  this is the bug.
 */

export type PayoutSpec = { bps: number[] };

/** What a tournament gets when nobody chooses: top-heavy 65/25/10. */
export const DEFAULT_PAYOUT: PayoutSpec = { bps: [6500, 2500, 1000] };

/** At most this many places — the server's `MAX_TOURNAMENT_PLAYERS`. */
const MAX_PLACES = 128;

export const PAYOUT_PRESETS: { label: string; bps: number[] }[] = [
  { label: "Top 3 (65/25/10)", bps: [6500, 2500, 1000] },
  { label: "Top 3 (50/30/20)", bps: [5000, 3000, 2000] },
  { label: "Winner takes all", bps: [10000] },
  { label: "Flat top 4", bps: [2500, 2500, 2500, 2500] },
];

/** `null` when the structure is payable, else why it isn't. */
export function validatePayout(bps: number[]): string | null {
  if (bps.length === 0) return "A prize structure has to pay someone.";
  if (bps.length > MAX_PLACES) return `At most ${MAX_PLACES} places.`;
  if (bps.some((b) => !Number.isInteger(b) || b < 0 || b > 10000))
    return "Every share has to be between 0% and 100%.";
  for (let i = 1; i < bps.length; i++)
    if (bps[i] > bps[i - 1]) return "A lower place can’t be paid more than a higher one.";
  const total = bps.reduce((a, b) => a + b, 0);
  if (total !== 10000)
    // Not "at most": the whole pool is distributed, and the contract rakes
    // whatever a structure fails to allocate straight to the fee recipient. A
    // creator who means to pay 90% is asking to donate 10% to the house.
    return `Shares have to add up to 100% — these add up to ${fmtPct(total)}.`;
  return null;
}

/** A share as a percentage, trimmed: 6500 → "65%", 3333 → "33.33%". */
function fmtPct(bps: number): string {
  const v = bps / 100;
  return `${Number.isInteger(v) ? v : Number(v.toFixed(2))}%`;
}

/** A structure as a human string: "65% / 25% / 10%". Zero-weight tail places are
 *  dropped — they pay nothing and naming them just makes the label longer. */
export function formatPayout(bps: number[]): string {
  const paid = bps.filter((b) => b > 0);
  return paid.length === 0 ? "—" : paid.map(fmtPct).join(" / ");
}

/** Parse a creator's "50, 30, 20" (percentages, any of `,` `/` whitespace) into
 *  basis points. Returns the error string rather than throwing, so the form can
 *  render it inline. */
export function parsePayout(input: string): PayoutSpec | { error: string } {
  const parts = input
    .split(/[,/\s]+/)
    .map((s) => s.trim().replace(/%$/, ""))
    .filter(Boolean);
  if (parts.length === 0) return { error: "Enter the shares, e.g. 50, 30, 20." };
  const bps: number[] = [];
  for (const part of parts) {
    const pct = Number(part);
    if (!Number.isFinite(pct) || pct < 0) return { error: `“${part}” isn’t a percentage.` };
    // Percent → basis points. Two decimal places of percent is the resolution
    // the server stores, so anything finer is rounded here rather than silently
    // dropped there.
    const b = Math.round(pct * 100);
    if (Math.abs(pct * 100 - b) > 1e-9)
      return { error: `“${part}%” is finer than the 0.01% the structure can hold.` };
    bps.push(b);
  }
  const why = validatePayout(bps);
  return why ? { error: why } : { bps };
}

/** Which preset (if any) a structure corresponds to — so a tournament created
 *  with a preset shows its name rather than the raw percentages. */
export function presetLabel(bps: number[]): string | null {
  const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  return PAYOUT_PRESETS.find((p) => same(p.bps, bps))?.label ?? null;
}
