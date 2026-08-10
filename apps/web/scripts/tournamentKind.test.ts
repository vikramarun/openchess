// `buy_in` carries two facts at once — whether an onchain prize pool exists,
// and what entry costs — and the free-entry case makes the second one zero
// while the first stays true.
//
// The trap this pins: `"0"` is a TRUTHY string in JavaScript. Every
// `t.buy_in ? … : "casual"` in the page reads as "does this have a pool", which
// is RIGHT for wallet identity, organizer-gated start and authed my-games — a
// free event has a pool and needs all three. It is WRONG for anything showing
// money, where it renders "0 USDC entry" and tags an unranked event Ranked.
// That distinction is the whole reason `kindOf` exists.
import {
  entrantLabel,
  hasPrizePool,
  isRanked,
  kindOf,
  type Tournament,
} from "../lib/tournaments";

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`,
  );
}

const t = (buy_in: string | null) => ({ buy_in }) as Pick<Tournament, "buy_in">;

check("null is casual — no pool at all", kindOf(t(null)), "casual");
check("\"0\" is a free event with a real pool", kindOf(t("0")), "free");
check("a positive fee is a buy-in event", kindOf(t("1000000")), "buyin");

// The bug in one line: the truthiness of the raw field does NOT track the kind.
check(
  "the raw field is truthy for BOTH pooled kinds, which is why display must not use it",
  [!!t("0").buy_in, !!t("1000000").buy_in, !!t(null).buy_in],
  [true, true, false],
);

// Ranked mirrors the server's `tournament_ladder`: only a paid entry risks
// anything, so only a paid entry moves ranked Elo. A free sponsored event pays
// real USDC and is still casual — otherwise two cooperating wallets farm ranked
// rating at zero cost.
check("a buy-in event is ranked", isRanked(t("1000000")), true);
check("a free event is NOT ranked", isRanked(t("0")), false);
check("a casual event is not ranked", isRanked(t(null)), false);

// "Has prize money" and "is ranked" are different questions, and the free event
// is exactly where they disagree.
check("a free event has prize money", hasPrizePool(t("0")), true);
check("a casual event has none", hasPrizePool(t(null)), false);
check("a buy-in event has some", hasPrizePool(t("1000000")), true);

// A malformed figure must not throw inside a render.
check("garbage degrades to casual rather than throwing", kindOf(t("not-a-number")), "casual");
check("an empty string degrades too", kindOf(t("")), "casual");

// --- entrant labels ---------------------------------------------------------
//
// The server resolves usernames into `labels` and says a client should render
// `labels[id] ?? id`. The bare fallback is wrong for the tournament tables
// though: an entrant id IS a 42-char wallet for a buy-in event, so `?? id`
// prints a raw address where the lobby and board print a handle.

const WALLET = "0xAAaa000000000000000000000000000000000001";
const lab = (labels: Record<string, string>) => ({ labels }) as Pick<Tournament, "labels">;

check("a claimed handle wins", entrantLabel(lab({ [WALLET]: "magnus" }), WALLET), "magnus");
check(
  "labels are matched case-insensitively too — the server lowercases wallets",
  entrantLabel(lab({ [WALLET.toLowerCase()]: "magnus" }), WALLET),
  "magnus",
);
check(
  "a wallet with no handle shortens rather than printing 42 characters",
  entrantLabel(lab({}), WALLET),
  "0xAAaa…0001",
);
check(
  "an unlabelled casual nickname is ~-decorated (never shown bare — a guest could type a real handle)",
  entrantLabel(lab({}), "alice"),
  "~alice",
);
check(
  "a nickname that already starts with ~ is still prefixed — matching the server's guest_label, so guest `~alice` can't render as guest `alice`",
  entrantLabel(lab({}), "~alice"),
  "~~alice",
);
check("no labels at all still renders something", entrantLabel(lab({}), "bob"), "~bob");

console.log(failed === 0 ? "\nall tournament-kind checks passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
