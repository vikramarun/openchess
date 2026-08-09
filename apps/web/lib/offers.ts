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
 *  always stand alone. */
function mergeKey(o: OfferLike): string {
  if (!o.poster_addr) return `id:${o.offer_id}`;
  return [
    o.poster_addr.toLowerCase(),
    o.stake ?? "free",
    o.initial_secs,
    o.increment_secs,
  ].join("|");
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
