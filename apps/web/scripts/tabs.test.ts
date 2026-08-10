// Which bottom tab lights up for a given route (components/TabBar.tsx).
//
// Worth its own suite because below 1100px that bar is the ONLY navigation —
// the header's `.nav` is display:none there — so a wrong answer is not a
// cosmetic highlight, it is the user being told they are somewhere they aren't.
//
// The trap it exists for: `"/player/0xabc".startsWith("/play")` is TRUE, so
// matching on the bare href would light "Engine" on every profile page in the
// app. And "/" prefix-matches literally every route, so home has to be an exact
// match and name its extra routes explicitly.
//
// Pure, so it needs no DOM: nothing in this suite renders a page.
import { TABS, activeTab } from "../components/TabBar";

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`,
  );
}

const cases: [string, string | null][] = [
  // --- the tabs themselves ---
  ["/", "/"],
  ["/lobby", "/lobby"],
  ["/tournament", "/tournament"],
  ["/play", "/play"],
  ["/profile", "/profile"],

  // --- routes that belong to a tab without being it ---
  ["/game/abc123", "/"],
  ["/park", "/lobby"],
  ["/gauntlet", "/tournament"],
  ["/connect", "/play"],
  ["/bench", "/play"],
  // The one that motivated this file. NOT "/play".
  ["/player/0xabc", "/profile"],
  ["/tournament/7", "/tournament"],

  // --- on no tab: better than a wrong promise ---
  ["/nope", null],
];

for (const [path, want] of cases) check(`activeTab("${path}")`, activeTab(path), want);

// A tab bar wider than five columns wraps at 320px, and `.tabbar`'s
// grid-template-columns is a literal repeat(5, 1fr) — so the count is a
// contract between this file and globals.css, not a preference.
check("there are exactly five tabs", TABS.length, 5);
check(
  "every label fits the 8-character budget",
  TABS.filter((t) => t.label.length > 8).map((t) => t.label),
  [],
);
// Every tab must be reachable BY BEING ON IT, or the bar can highlight a tab
// that its own href never selects.
check(
  "every tab's own href selects it",
  TABS.filter((t) => activeTab(t.href) !== t.href).map((t) => t.href),
  [],
);

process.exit(failed === 0 ? 0 : 1);
