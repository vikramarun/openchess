// The local record of which tournaments this browser sponsored.
//
// It exists because the server cannot answer the question: its claimable list
// is `players @> addr` (entrants), a sponsor is not an entrant, and the
// sponsorship transaction is sent by the sponsor's own browser so the server
// never sees it at all. Without this, a sponsor whose tournament was abandoned
// has no route in the UI back to their own money.
//
// It is a hint, never the authority — `TournamentClaim` re-reads
// `sponsorship(tid, addr)` onchain before offering anything, so a stale or
// missing entry costs discoverability and never funds.
import { rememberSponsorship, sponsoredTournaments } from "../lib/sponsorships";

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`,
  );
}

// Minimal localStorage stand-in (these run under tsx, not a browser).
const store = new Map<string, string>();
(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  },
};

const ALICE = "0xAAAA000000000000000000000000000000000001";
const BOB = "0xbbbb000000000000000000000000000000000002";
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

check("nothing recorded yet", sponsoredTournaments(ALICE), []);
check("no wallet, no list", sponsoredTournaments(undefined), []);

rememberSponsorship(ALICE, T1);
check("a sponsorship is recorded", sponsoredTournaments(ALICE), [T1]);

// Topping the same pool up again must not list it twice — the claim panel
// renders one child per id, and a duplicate would render two reclaim buttons
// for one balance.
rememberSponsorship(ALICE, T1);
check("topping up the same pool doesn't duplicate it", sponsoredTournaments(ALICE), [T1]);

rememberSponsorship(ALICE, T2);
check("a second pool appends", sponsoredTournaments(ALICE), [T1, T2]);

// Wallets are kept apart, and matched case-insensitively — wagmi hands back a
// checksummed address while the record is keyed lowercase, so a case-sensitive
// lookup would silently lose every sponsorship the moment the page reloaded.
check("another wallet has its own list", sponsoredTournaments(BOB), []);
check("lookup is case-insensitive", sponsoredTournaments(ALICE.toLowerCase()), [T1, T2]);
rememberSponsorship(ALICE.toLowerCase(), T1);
check("recording under a different case doesn't fork the list", sponsoredTournaments(ALICE), [
  T1,
  T2,
]);

// Corrupt storage must degrade, not throw: this runs during a render.
store.set("openchess.sponsored", "{not json");
check("garbage in storage reads as empty", sponsoredTournaments(ALICE), []);
store.set("openchess.sponsored", JSON.stringify({ [ALICE.toLowerCase()]: "not-an-array" }));
check("a non-array entry reads as empty", sponsoredTournaments(ALICE), []);

console.log(failed === 0 ? "\nall sponsorship-record checks passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
