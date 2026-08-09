// Verify the lobby's open-challenge grouping. Two mistakes here are invisible
// in a screenshot and expensive: merging two *anonymous* posters would send a
// joiner to a stranger's board, and failing to merge the house bot's identical
// seats brings back the duplicate-row noise the grouping exists to remove.
import { groupOffers, type OfferLike } from "../lib/offers";

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`,
  );
}

const HOUSE = "0xEEbEd5385adc43A74a282788D5C343EC3326B6cb";
const offer = (o: Partial<OfferLike> & { offer_id: string }): OfferLike => ({
  poster_addr: HOUSE,
  poster_name: "House Bot",
  poster_engine: "Stockfish 17.1",
  stake: null,
  initial_secs: 180,
  increment_secs: 0,
  ...o,
});

// --- the case this shipped for: SEATS>1 house autopilots on one time control ---
const twoSeats = groupOffers([offer({ offer_id: "a" }), offer({ offer_id: "b" })]);
check("identical house seats collapse to one row", twoSeats.length, 1);
check("both ids ride along for the join retry", twoSeats[0]?.ids, ["a", "b"]);

// --- things that must NOT merge ---
check(
  "different time controls stay separate",
  groupOffers([offer({ offer_id: "a" }), offer({ offer_id: "b", initial_secs: 600 })]).length,
  2,
);
check(
  "different increments stay separate",
  groupOffers([offer({ offer_id: "a" }), offer({ offer_id: "b", increment_secs: 2 })]).length,
  2,
);
check(
  "different stakes stay separate",
  groupOffers([offer({ offer_id: "a" }), offer({ offer_id: "b", stake: "1000000" })]).length,
  2,
);
check(
  "a free offer never merges with a staked one",
  groupOffers([offer({ offer_id: "a", stake: null }), offer({ offer_id: "b", stake: "0" })]).length,
  2,
);
check(
  "different wallets stay separate",
  groupOffers([offer({ offer_id: "a" }), offer({ offer_id: "b", poster_addr: "0xdead" })]).length,
  2,
);
// The dangerous one: anonymous casual posters share a null wallet (and may
// share a declared name), but they are different people at different boards.
check(
  "anonymous posters never merge",
  groupOffers([
    offer({ offer_id: "a", poster_addr: null, poster_name: null }),
    offer({ offer_id: "b", poster_addr: null, poster_name: null }),
  ]).length,
  2,
);
check(
  "anonymous posters with the same declared name never merge",
  groupOffers([
    offer({ offer_id: "a", poster_addr: null, poster_name: "bot" }),
    offer({ offer_id: "b", poster_addr: null, poster_name: "bot" }),
  ]).length,
  2,
);

// --- invariants ---
check(
  "wallet case doesn't split a group",
  groupOffers([offer({ offer_id: "a" }), offer({ offer_id: "b", poster_addr: HOUSE.toLowerCase() })])
    .length,
  1,
);
check(
  "every offer survives grouping",
  groupOffers([
    offer({ offer_id: "a" }),
    offer({ offer_id: "b" }),
    offer({ offer_id: "c", initial_secs: 60 }),
    offer({ offer_id: "d", poster_addr: null }),
  ]).flatMap((g) => g.ids),
  ["a", "b", "c", "d"],
);
check("empty park groups to nothing", groupOffers([]), []);
// The row is rendered with the representative offer, so it must be a real
// member of its own group (first seen), not a synthesised composite.
check("representative is the first member", twoSeats[0]?.offer.offer_id, "a");

console.log(failed === 0 ? "\nall offer-grouping tests passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
