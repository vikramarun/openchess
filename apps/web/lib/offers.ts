// Grouping for the lobby's open-challenge table.
//
// One poster can legitimately stand several identical challenges at once: the
// house bot runs SEATS autopilots per time control (scripts/house-bot.sh), so
// the park holds two open "House Bot · 3+0 · free" offers whenever both seats
// are idle. Listed raw that reads as duplicated rows; collapsed, it reads as
// what it is — a time control with more than one seat free.
//
// The group also carries every offer id behind the row, so a click that loses
// the race for the first seat can take the next one instead of erroring.

import { SESSION_EXPIRED } from "./authedFetch";
import { BOT_OFFLINE_MSG, MAINTENANCE_MSG } from "./copy";

export type OfferLike = {
  offer_id: string;
  poster_addr: string | null;
  poster_name: string | null;
  poster_engine: string | null;
  stake: string | null;
  initial_secs: number;
  increment_secs: number;
};

export type OfferGroup<T extends OfferLike> = {
  /** Representative offer — every member shares poster, stake and clock. */
  offer: T;
  /** Offer ids in the group, in list order: try them in turn when joining. */
  ids: string[];
};

/** Merge key. Only offers from a KNOWN wallet may merge: `poster_addr` is null
 *  on anonymous casual offers, where two unrelated humans can easily share a
 *  declared name (or none at all) and merging them would hand a joiner a seat
 *  at somebody else's board. Anonymous offers key on their own id, so they
 *  always stand alone.
 *
 *  The declared name and engine are part of the key, not just the terms: one
 *  wallet can stand two offers that differ in what they claim to run — a bot
 *  seat takes its engine from the agent's registration while a browser seat
 *  declares `browserEngineLabel()`, and a rename between posts does it too.
 *  Merging those would show one row's engine and seat you at the other's
 *  board, which is a misrepresented opponent rather than a cosmetic slip once
 *  a stake is involved. (The house bot's seats share a NAME and engine, so
 *  they still collapse.)
 *
 *  JSON-encoded rather than joined on a separator: these are user-supplied
 *  labels, and a separator inside one must not be able to forge another
 *  offer's key. */
function mergeKey(o: OfferLike): string {
  if (!o.poster_addr) return `id:${o.offer_id}`;
  return JSON.stringify([
    o.poster_addr.toLowerCase(),
    o.poster_name,
    o.poster_engine,
    o.stake,
    o.initial_secs,
    o.increment_secs,
  ]);
}

/** Collapse identical offers from the same wallet, preserving first-seen order. */
export function groupOffers<T extends OfferLike>(offers: T[]): OfferGroup<T>[] {
  const byKey = new Map<string, OfferGroup<T>>();
  for (const o of offers) {
    const key = mergeKey(o);
    const existing = byKey.get(key);
    if (existing) existing.ids.push(o.offer_id);
    else byKey.set(key, { offer: o, ids: [o.offer_id] });
  }
  return [...byKey.values()];
}

/** The name scripts/house-bot.sh posts under (its NAME default). If the house
 *  bot is ever renamed, the lobby's play-now button quietly downgrades to its
 *  fallback — it can never seat anyone at the wrong board. */
export const HOUSE_BOT_NAME = "House Bot";

/** The house bot's free standing seat for a time control, if one is open.
 *
 *  Free offers only: this feeds a button labeled "free", and a spoofed name is
 *  therefore worth at most a casual game against the spoofer — the same thing
 *  clicking their row in the table would get. `poster_addr` must be present
 *  because the house bot is wallet-bound; anonymous offers never qualify. */
export function houseOfferGroup<T extends OfferLike>(
  groups: OfferGroup<T>[],
  initialSecs: number,
  incrementSecs: number,
): OfferGroup<T> | null {
  return (
    groups.find(
      (g) =>
        g.offer.poster_name === HOUSE_BOT_NAME &&
        g.offer.poster_addr != null &&
        !g.offer.stake &&
        g.offer.initial_secs === initialSecs &&
        g.offer.increment_secs === incrementSecs,
    ) ?? null
  );
}

/** The side to seat a player on, from whatever the server sent.
 *
 *  Colour is drawn per game now (server-side `coin_flip`), so neither posting
 *  nor accepting implies a side and the value has to come off the wire. But by
 *  the time either lobby path reads it the GAME ALREADY EXISTS and, if staked,
 *  escrow is locked — so a missing or unrecognised colour must never stop us
 *  taking the seat. A seat that never attaches reaps as a forfeit and hands the
 *  opponent the whole stake (`room.rs reap_forfeit_winner`), whereas a seat
 *  shown the wrong way round costs a flipped board, a mirrored clock and a
 *  wrong result banner — all of it recoverable with a reload, none of it the
 *  game. `playSeat` drives off the token and the server's frames and never
 *  reads this, so the moves themselves are right either way.
 *
 *  Hence: parse it, and fall back to a side rather than to nothing. */
export function seatColor(color: unknown): "white" | "black" {
  return color === "black" ? "black" : "white";
}

/** Statuses meaning "this particular offer id is no longer joinable", so the
 *  next seat in the group is worth trying: 404 (the row is gone) and 409 (it
 *  is no longer `open`).
 *
 *  409 has to be in here even though the server overloads it — see
 *  `joinErrorMessage`. A just-accepted offer KEEPS its row in the park with
 *  status "matching"/"matched" and is only removed on cancel, TTL sweep, or a
 *  poster bot going offline, so the very race this walk exists for answers 409.
 *  Narrowing this to 404 looks like a tightening and silently disables the
 *  retry. */
const RETRYABLE_JOIN_STATUS = new Set([404, 409]);

/** Try a group's seats in order, stopping at the first that is taken — or at
 *  the first failure that says something other than "not this one".
 *
 *  `attempt` is injected rather than closed over so the walk is testable
 *  without a server: it is handed one offer id and returns that POST's
 *  Response. Returns the last Response tried, or null for an empty group. */
export async function acceptFromGroup(
  ids: string[],
  attempt: (id: string) => Promise<Response>,
): Promise<Response | null> {
  let last: Response | null = null;
  for (const id of ids) {
    last = await attempt(id);
    if (last.ok || !RETRYABLE_JOIN_STATUS.has(last.status)) break;
  }
  return last;
}

/** Why a join failed, in the user's terms.
 *
 *  The 404/409 arm is the subtle one. `park_accept` answers 409 for THREE
 *  different situations: the offer is no longer open, the POSTER's bot is
 *  busy, and the ACCEPTOR's own bot is busy. Only the first is a lost race,
 *  and the client cannot tell them apart — so when we are seating our own bot,
 *  the message has to admit both possibilities. Claiming "someone took it" to
 *  someone whose own bot is simply mid-game sends them hunting for a race that
 *  never happened.
 *
 *  401 shares `SESSION_EXPIRED` with every other authed caller rather than
 *  falling through to the bare status code. Sessions live in the server's
 *  process memory, so every deploy voids them while the browser still holds the
 *  token — and by the time this runs `authedFetch` has already dropped the dead
 *  credential and brought the sign-in button back, so this string is the only
 *  thing left to say why the click did nothing. */
export function joinErrorMessage(status: number, opts: { botPlays: boolean }): string {
  switch (status) {
    case 401:
      return SESSION_EXPIRED;
    case 503:
      return MAINTENANCE_MSG;
    case 502:
      return "Couldn’t lock the stakes onchain. Check that both players have deposited enough.";
    case 424:
      return BOT_OFFLINE_MSG;
    case 410:
      return "That challenger’s bot went offline, so the offer is gone.";
    case 404:
    case 409:
      return opts.botPlays
        ? "Couldn’t join. Your bot may already be in a game, or the seat was just taken."
        : "Someone just took that challenge. The lobby will refresh.";
    default:
      return `Couldn’t join (${status}).`;
  }
}
