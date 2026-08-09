// The prize-structure rules are written twice: here, and in the server's
// `PayoutSpec::validate`. That is deliberate (a creator should get a sentence,
// not a bare 400), and it is exactly the kind of duplication that drifts — so
// this pins the client copy against the server's rules as written in
// crates/server/src/matchmaking.rs.
//
// The one that costs money if it drifts is the sum: the contract rakes
// `pool - sum(payouts)` to the fee recipient, so a structure that adds up to
// 90% quietly donates a tenth of the pool to the house. Both sides demand
// exactly 100%.
import {
  DEFAULT_PAYOUT,
  PAYOUT_PRESETS,
  formatPayout,
  parsePayout,
  presetLabel,
  validatePayout,
} from "../lib/payouts";

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`,
  );
}
function ok(name: string, cond: boolean) {
  check(name, cond, true);
}

// --- validation mirrors the server ------------------------------------------

ok("the default is payable", validatePayout(DEFAULT_PAYOUT.bps) === null);
ok(
  "every shipped preset is payable",
  PAYOUT_PRESETS.every((p) => validatePayout(p.bps) === null),
);
ok("winner-take-all is payable", validatePayout([10000]) === null);
ok("an explicit zero tail is a structure, not an error", validatePayout([10000, 0]) === null);

ok("a structure that pays nobody is refused", validatePayout([]) !== null);
ok("a short sum is refused (the rest would be raked)", validatePayout([5000, 3000]) !== null);
ok("a sum over 100% is refused", validatePayout([6000, 5000]) !== null);
ok("paying 2nd more than 1st is refused", validatePayout([3000, 7000]) !== null);
ok("more places than a field can hold is refused", validatePayout(Array(129).fill(0)) !== null);

// The short-sum message has to say what's actually wrong — "add up to 100%" with
// no number leaves a creator guessing which share they fat-fingered.
ok(
  "the short-sum error quotes the actual total",
  (validatePayout([5000, 3000]) ?? "").includes("80%"),
);

// --- parsing ----------------------------------------------------------------

check("comma separated", parsePayout("50, 30, 20"), { bps: [5000, 3000, 2000] });
check("slash separated", parsePayout("65/25/10"), { bps: [6500, 2500, 1000] });
check("whitespace separated", parsePayout("50  30  20"), { bps: [5000, 3000, 2000] });
check("percent signs are tolerated", parsePayout("50%, 30%, 20%"), { bps: [5000, 3000, 2000] });
check("two decimal places survive", parsePayout("33.34, 33.33, 33.33"), {
  bps: [3334, 3333, 3333],
});
ok("a blank structure is an error", "error" in parsePayout("   "));
ok("a non-number is an error", "error" in parsePayout("50, thirty, 20"));
ok("a negative share is an error", "error" in parsePayout("110, -10"));
ok(
  "finer than 0.01% is refused rather than silently rounded",
  "error" in parsePayout("33.333, 33.333, 33.334"),
);
// Parsing runs the same validation, so an unpayable structure never reaches the
// request body.
ok("parse rejects what validate rejects", "error" in parsePayout("50, 30"));

// --- display ----------------------------------------------------------------

check("whole percentages read cleanly", formatPayout([6500, 2500, 1000]), "65% / 25% / 10%");
check("fractional percentages keep their decimals", formatPayout([3334, 3333, 3333]), "33.34% / 33.33% / 33.33%");
check("zero-weight tail places are not named", formatPayout([10000, 0, 0]), "100%");
check("a structure paying nobody renders as a dash", formatPayout([]), "—");

check("a preset is shown by name", presetLabel([10000]), "Winner takes all");
check("a custom structure has no preset name", presetLabel([4000, 4000, 2000]), null);

console.log(failed === 0 ? "\nall payout checks passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
