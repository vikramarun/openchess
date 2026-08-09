// Pin the layout invariants that are pure CSS, since nothing else in the suite
// renders a page: two that keep the top nav usable after a game, and two that
// keep a dropdown from running off the right edge of the screen.
//
// A game view is several viewports tall — on the pages that still carry
// content above the board (`/game/[id]`, gauntlet, tournament) "Back to lobby"
// lands ~1000px down. With a STATIC header the nav is ~640px above the screen
// by the time a finished game is readable, so the only reachable link is the
// one in the board sidebar. That shipped.
//
// The z-index half is the other trap: `.modal-overlay` covers the viewport for
// the pre-game confirm (StakeConfirm) and the time-control picker. If the
// header ever outranks it, that confirmation becomes a dialog you can click
// behind — on the money path, where the whole point is an explicit "go" from
// both seats before a stake locks.
//
// The overflow half is the quietest of the four. A `<select>` is intrinsically
// as wide as its LONGEST OPTION and a grid item is `min-width: auto`, so one
// long book title ("Hypermodern — Indian defences (21 KB)") sized the
// repertoire grid's tracks and pushed the fourth dropdown past the right edge
// of the page. Nothing errors, nothing looks broken above the fold — the page
// is just wider than the screen.
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Comments stripped up front: `ruleBody` ends a block at the first `}`, and
// `decl` would otherwise read a property named inside a comment as a real
// declaration (`min-width: 0` is documented one line above itself below).
const css = readFileSync(join(__dirname, "..", "app", "globals.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

/** The declaration block of the first TOP-LEVEL rule whose selector matches.
 *
 *  Column-0 only, which is what keeps the `.site-header` inside the ≤720px
 *  media query (indented) from being read as the base rule. The flip side is
 *  that this reads the SOURCE, not the cascade: a second top-level
 *  `.site-header` added later would win in a browser and be invisible here.
 *  Fine for an invariant whose whole point is one declaration in one place —
 *  but it is the assumption to revisit if this file ever grows a second one. */
function ruleBody(selector: string): string | null {
  const i = css.indexOf(`\n${selector} {`);
  if (i === -1) return null;
  const start = css.indexOf("{", i);
  const end = css.indexOf("}", start);
  return end === -1 ? null : css.slice(start + 1, end);
}

function decl(body: string | null, prop: string): string | null {
  if (!body) return null;
  const m = body.match(new RegExp(`(?:^|;|\\n)\\s*${prop}\\s*:\\s*([^;\\n]+)`));
  return m ? m[1].trim() : null;
}

const header = ruleBody(".site-header");
const overlay = ruleBody(".modal-overlay");

check(".site-header rule exists", header !== null);
check(".modal-overlay rule exists", overlay !== null);

// --- half one: the header stays on screen ---
check(
  ".site-header is sticky",
  decl(header, "position") === "sticky",
  `position is ${decl(header, "position") ?? "unset"}`,
);
check(
  ".site-header is pinned to the top",
  decl(header, "top") === "0",
  `top is ${decl(header, "top") ?? "unset"}`,
);

// --- half two: a modal still covers it ---
// Read the raw declaration first: `Number(null)` is 0, so going through Number
// alone would score a DELETED z-index as a perfectly good 0 — and 0 < 50, so
// the ordering check below would pass too, on a header that has no z-index at
// all. (It did, until this test was run against that exact regression.)
const headerZRaw = decl(header, "z-index");
const overlayZRaw = decl(overlay, "z-index");
const num = (raw: string | null) => (raw === null ? NaN : Number(raw));
const headerZ = num(headerZRaw);
const overlayZ = num(overlayZRaw);
check(".site-header sets a z-index", Number.isFinite(headerZ), `got ${headerZRaw ?? "unset"}`);
check(".modal-overlay sets a z-index", Number.isFinite(overlayZ), `got ${overlayZRaw ?? "unset"}`);
check(
  "a modal outranks the header",
  Number.isFinite(headerZ) && Number.isFinite(overlayZ) && headerZ < overlayZ,
  `header ${headerZ} vs overlay ${overlayZ}`,
);

// --- half three: a dropdown stays inside the screen ---
// Two declarations, each holding a box to its container instead of to its
// contents. `min-width: 0` is the local fix (a grid item defaults to
// `min-width: auto`, i.e. never smaller than its content); `max-width: 100%`
// on the base control rule is the general one, so the next long option label
// can't do this to some other layout. Note the second selector is the
// two-line group `input,\nselect` — matching on `select` alone finds nothing,
// and `decl(null, …)` is also null, which is how this would go green while
// checking nothing.
const slot = ruleBody(".rep-slot");
const field = ruleBody("input,\nselect");

check(".rep-slot rule exists", slot !== null);
check("base input/select rule exists", field !== null);
check(
  ".rep-slot overrides a grid item's min-width:auto",
  decl(slot, "min-width") === "0",
  `min-width is ${decl(slot, "min-width") ?? "unset"}`,
);
check(
  "a control cannot outgrow its container",
  decl(field, "max-width") === "100%",
  `max-width is ${decl(field, "max-width") ?? "unset"}`,
);

// --- half four: the mobile tab bar ---
// Below 720px the header's `.nav` is display:none and this bar is the ONLY way
// to reach four of the five destinations, so it fails in two silent ways.
//
// If it ever outranks `.modal-overlay`, the pre-game stake confirmation gets
// five tappable links across its bottom edge — the same bug as a header that
// outranks it, on the same money path. It must also stay under the HEADER:
// `.site-header` is sticky with a z-index, so it is a stacking context and
// `.wallet-pop` (the bankroll popover, z-index 50) is scoped inside it, meaning
// that 50 never competes at the root. A bar above the header would paint over
// the bottom of the popover, which on a phone is where Deposit lives.
//
// And a `position: fixed` bar takes no space in the flow, so without a
// compensating bottom padding the last row of the footer sits permanently
// underneath it — which no build error and no desktop screenshot would show.
const tabbar = ruleBody(".tabbar");

check(".tabbar rule exists", tabbar !== null);
check(
  ".tabbar is fixed to the viewport",
  decl(tabbar, "position") === "fixed",
  `position is ${decl(tabbar, "position") ?? "unset"}`,
);

const tabbarZRaw = decl(tabbar, "z-index");
const tabbarZ = num(tabbarZRaw);
check(".tabbar sets a z-index", Number.isFinite(tabbarZ), `got ${tabbarZRaw ?? "unset"}`);
check(
  "a modal outranks the tab bar",
  Number.isFinite(tabbarZ) && Number.isFinite(overlayZ) && tabbarZ < overlayZ,
  `tabbar ${tabbarZ} vs overlay ${overlayZ}`,
);
check(
  "the tab bar does not outrank the header",
  Number.isFinite(tabbarZ) && Number.isFinite(headerZ) && tabbarZ < headerZ,
  `tabbar ${tabbarZ} vs header ${headerZ}`,
);

// The bar's height and the padding that clears it must read the SAME token, or
// they drift the first time someone makes the bar taller.
check(
  ":root declares --tabbar-h",
  /--tabbar-h\s*:\s*\d/.test(css.slice(0, css.indexOf("}"))),
  "no --tabbar-h in the first block of the file",
);
check(
  ".tabbar's height comes from --tabbar-h",
  /height:\s*[^;\n]*var\(--tabbar-h\)/.test(tabbar ?? ""),
  `height is ${decl(tabbar, "height") ?? "unset"}`,
);
check(
  ".tabbar clears the home indicator",
  /padding-bottom:\s*env\(safe-area-inset-bottom/.test(tabbar ?? ""),
  "no env(safe-area-inset-bottom) padding on .tabbar",
);

// The clearance itself lives on <body> INSIDE the ≤720px query — indented, so
// `ruleBody` cannot see it by design. Match the query's text directly.
const mobile = css.slice(css.indexOf("@media (max-width: 720px)"));
check(
  "phones pad the page below the bar",
  /\n\s+body\s*\{[^}]*padding-bottom:\s*calc\([^;}]*var\(--tabbar-h\)[^;}]*env\(safe-area-inset-bottom/.test(
    mobile,
  ),
  "no `body { padding-bottom: calc(var(--tabbar-h) + env(safe-area-inset-bottom, 0px)) }` in a ≤720px query",
);

process.exit(failed === 0 ? 0 : 1);
