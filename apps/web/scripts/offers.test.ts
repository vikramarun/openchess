// Verify the lobby's open-challenge grouping. Two mistakes here are invisible
// in a screenshot and expensive: merging two *anonymous* posters would send a
// joiner to a stranger's board, and failing to merge the house bot's identical
// seats brings back the duplicate-row noise the grouping exists to remove.
import { SESSION_EXPIRED } from "../lib/authedFetch";
import { BOT_OFFLINE_MSG, MAINTENANCE_MSG } from "../lib/copy";
import {
  acceptFromGroup,
  groupOffers,
  joinErrorMessage,
  type OfferLike,
} from "../lib/offers";

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
// One wallet can stand two offers claiming DIFFERENT engines — a bot seat takes
// its engine from the agent registration, a browser seat declares its own.
// Merging them would show one row's engine and seat you at the other's board.
check(
  "same wallet, different declared engine stays separate",
  groupOffers([
    offer({ offer_id: "a", poster_engine: "Stockfish 17.1" }),
    offer({ offer_id: "b", poster_engine: "Stockfish 16 WASM" }),
  ]).length,
  2,
);
check(
  "same wallet, different declared name stays separate",
  groupOffers([
    offer({ offer_id: "a", poster_name: "House Bot" }),
    offer({ offer_id: "b", poster_name: "Test Bot" }),
  ]).length,
  2,
);
check(
  "a declared engine never merges with an undeclared one",
  groupOffers([offer({ offer_id: "a" }), offer({ offer_id: "b", poster_engine: null })]).length,
  2,
);
// The key is JSON-encoded, so a separator inside a user-supplied label cannot
// forge a different offer's key.
check(
  "a label containing the separator can't collide",
  groupOffers([
    offer({ offer_id: "a", poster_name: "a", poster_engine: "b|c" }),
    offer({ offer_id: "b", poster_name: "a|b", poster_engine: "c" }),
  ]).length,
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

// --- the join walk over a group's seats ---
//
// The house bot stands SEATS identical offers, so a click can lose the race for
// the first one and still have somewhere to sit. What must NOT happen is
// walking past a failure that has nothing to do with which seat was picked
// (maintenance, an unaffordable stake) — that would fire one pointless request
// per seat and report the LAST one.
const res = (status: number): Response => ({ ok: status < 400, status }) as Response;

/** Records which ids were tried, answering each with a scripted status. */
function spy(statuses: number[]) {
  const tried: string[] = [];
  return {
    tried,
    attempt: async (id: string) => {
      tried.push(id);
      return res(statuses[tried.length - 1] ?? 500);
    },
  };
}

async function main() {
  let s = spy([200]);
  let r = await acceptFromGroup(["a", "b"], s.attempt);
  check("takes the first seat and stops", [r?.status, s.tried], [200, ["a"]]);

  s = spy([409, 200]);
  r = await acceptFromGroup(["a", "b"], s.attempt);
  check("walks past a taken seat (409) to the next", [r?.status, s.tried], [200, ["a", "b"]]);

  s = spy([404, 200]);
  r = await acceptFromGroup(["a", "b"], s.attempt);
  check("walks past a vanished seat (404)", [r?.status, s.tried], [200, ["a", "b"]]);

  // The regression guard: maintenance is not "try the next seat".
  s = spy([503, 200]);
  r = await acceptFromGroup(["a", "b"], s.attempt);
  check("stops on a non-retryable failure", [r?.status, s.tried], [503, ["a"]]);

  s = spy([424, 200]);
  r = await acceptFromGroup(["a", "b"], s.attempt);
  check("stops when our own bot is offline", [r?.status, s.tried], [424, ["a"]]);

  s = spy([409, 409]);
  r = await acceptFromGroup(["a", "b"], s.attempt);
  check("every seat taken reports the last failure", [r?.status, s.tried], [409, ["a", "b"]]);

  s = spy([409, 409, 409]);
  await acceptFromGroup(["a", "b"], s.attempt);
  check("never tries more seats than the group has", s.tried.length, 2);

  s = spy([]);
  r = await acceptFromGroup([], s.attempt);
  check("an empty group tries nothing and returns null", [r, s.tried], [null, []]);

  // --- what the user is told ---
  //
  // park_accept answers 409 for three different situations: the offer is no
  // longer open, the POSTER's bot is busy, and the ACCEPTOR's own bot is busy.
  // The client can't tell them apart, so seating our own bot must not assert a
  // race that may never have happened.
  check(
    "409 with our own bot playing admits both causes",
    joinErrorMessage(409, { botPlays: true }),
    "Couldn’t join. Your bot may already be in a game, or the seat was just taken.",
  );
  check(
    "409 with a browser seat is a plain lost race",
    joinErrorMessage(409, { botPlays: false }),
    "Someone just took that challenge. The lobby will refresh.",
  );
  check(
    "404 reads the same as 409",
    joinErrorMessage(404, { botPlays: false }),
    joinErrorMessage(409, { botPlays: false }),
  );
  // Shared wording comes from lib/copy.ts rather than a second copy here, so a
  // reworded drain message can't say one thing in the lobby and another in the
  // gauntlet. Asserting against the constant is the point: a literal would
  // re-introduce the duplication copy.ts exists to remove.
  check("maintenance uses the shared wording", joinErrorMessage(503, { botPlays: false }), MAINTENANCE_MSG);
  check(
    "a stake that can't be locked is named, spelled the way the code spells it",
    joinErrorMessage(502, { botPlays: false }).includes("onchain"),
    true,
  );
  check(
    "our offline bot is distinguished from the challenger's",
    [
      joinErrorMessage(424, { botPlays: true }),
      joinErrorMessage(410, { botPlays: true }),
    ],
    [BOT_OFFLINE_MSG, "That challenger’s bot went offline, so the offer is gone."],
  );
  // A dead session must not surface as a bare code: every deploy voids them,
  // authedFetch has already cleared the token by the time we get here, and this
  // string is what points at the sign-in button that just reappeared.
  check(
    "an expired session says so, in the same words as every other caller",
    joinErrorMessage(401, { botPlays: false }),
    SESSION_EXPIRED,
  );
  check(
    "an expired session reads the same whoever is seated",
    joinErrorMessage(401, { botPlays: true }),
    joinErrorMessage(401, { botPlays: false }),
  );
  check(
    "an unexpected status still surfaces its code",
    joinErrorMessage(418, { botPlays: false }),
    "Couldn’t join (418).",
  );

  console.log(failed === 0 ? "\nall offer-grouping tests passed" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
