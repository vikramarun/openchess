/** Which tournaments this browser has sponsored, per wallet.
 *
 *  Why this exists: `GET /tournaments/claimable/{addr}` finds tournaments the
 *  wallet is an ENTRANT of (`players @> addr`). A sponsor is not an entrant, and
 *  the server never sees the sponsorship at all — `sponsorTournament` is a
 *  transaction the sponsor's own browser sends. So without a local record, a
 *  sponsor whose tournament was abandoned has no route in the UI back to their
 *  own money, and an abandoned tournament drops out of the lobby after a day.
 *
 *  Deliberately NOT the source of truth: the chain is (`sponsorship(tid, addr)`),
 *  and the reclaim button reads it before offering anything. This is only a list
 *  of tournaments worth asking about, so losing it (private mode, another
 *  device) costs discoverability, never the funds — `refundSponsorship` is
 *  permissionless and can always be called directly.
 */

import { readMigrated, writeKey } from "./storage";

type Store = Record<string, string[]>; // lowercased wallet -> tournament ids

function read(): Store {
  try {
    const raw = readMigrated("sponsored");
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

/** Tournament ids this wallet has sponsored from this browser. */
export function sponsoredTournaments(address: string | undefined): string[] {
  if (!address) return [];
  try {
    const list = read()[address.toLowerCase()];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Record a successful sponsorship. Idempotent — topping the same pool up twice
 *  must not list it twice. */
export function rememberSponsorship(address: string, tid: string): void {
  try {
    const store = read();
    const key = address.toLowerCase();
    const list = Array.isArray(store[key]) ? store[key] : [];
    if (!list.includes(tid)) store[key] = [...list, tid];
    else store[key] = list;
    writeKey("sponsored", JSON.stringify(store));
  } catch {
    /* private mode — the reclaim just won't be auto-discovered */
  }
}
