// Pin the layout invariants that are pure CSS, since nothing else in the suite
// renders a page: the ones that keep the top nav usable after a game, keep a
// dropdown from running off the right edge, keep the board's coordinates on the
// board, keep the mobile tab bar under a modal and clear of the footer, and
// keep a route from naming a class no stylesheet defines any more.
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
// long book title ("Hypermodern — Indian defenses (21 KB)") sized the
// repertoire grid's tracks and pushed the fourth dropdown past the right edge
// of the page. Nothing errors, nothing looks broken above the fold — the page
// is just wider than the screen.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Comments stripped up front: `ruleBody` ends a block at the first `}`, and
// `decl` would otherwise read a property named inside a comment as a real
// declaration (`min-width: 0` is documented one line above itself below).
const read = (file: string) =>
  readFileSync(join(__dirname, "..", "app", file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const css = read("globals.css");
const boardCss = read("board.css");

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
function ruleBody(selector: string, source: string = css): string | null {
  const i = source.indexOf(`\n${selector} {`);
  if (i === -1) return null;
  const start = source.indexOf("{", i);
  const end = source.indexOf("}", start);
  return end === -1 ? null : source.slice(start + 1, end);
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

// --- half four: the board's coordinates stay on the board ---
// chessground's vendored base CSS positions the inside labels with FIXED PIXEL
// offsets (`coords.ranks { top: -20px }`, `coords.files { left: 24px }`) that
// only line up at one board size — at 380px the file strip was most of a square
// too far right, `h` hung off the edge, and the whole row sat below the last
// rank. app/board.css re-anchors both strips to the board itself, and the two
// declarations below are what that rests on. Both fail SILENTLY if dropped: a
// `left` reverting to the vendored 24px looks like a rendering quirk rather
// than a missing rule.
const ranks = ruleBody(".cg-wrap coords.ranks", boardCss);
const fileStrip = ruleBody(".cg-wrap coords.files", boardCss);
const wrap = ruleBody(".cg-wrap", boardCss);

check("board.css overrides the rank strip", ranks !== null);
check("board.css overrides the file strip", fileStrip !== null);
check(
  "the rank strip starts at the top of the board",
  decl(ranks, "top") === "0",
  `top is ${decl(ranks, "top") ?? "unset"}`,
);
check(
  "the file strip starts at the left edge",
  decl(fileStrip, "left") === "0",
  `left is ${decl(fileStrip, "left") ?? "unset"}`,
);
check(
  "the file strip sits ON the last rank, not below it",
  decl(fileStrip, "bottom") === "0",
  `bottom is ${decl(fileStrip, "bottom") ?? "unset"}`,
);
// The label size is `clamp(9px, …cqw, …)`, and a cqw with no query container
// resolves against the VIEWPORT — which silently renders ~27px coordinates on
// a 380px board rather than ~9px. The containment is the whole load-bearing
// half of that rule.
check(
  ".cg-wrap is a query container for the label size",
  decl(wrap, "container-type") === "inline-size",
  `container-type is ${decl(wrap, "container-type") ?? "unset"}`,
);
check(
  "the label size is board-relative",
  /font-size:[^;]*cqw/.test(ruleBody(".cg-wrap coords", boardCss) ?? ""),
  "no cqw font-size on .cg-wrap coords",
);

// --- half five: the mobile tab bar ---
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

// --- the coin sits on the squares, not on the board row ---
// `.demo-board` wraps `.board-row`, whose first child is the eval bar, so
// anything centring inside it lands half a bar to the left of the board's real
// middle — which is exactly what the homepage coin did. `.demo-scrim` corrects
// it with `padding-left: var(--eval-col)`, and --eval-col is a DERIVED number:
// the bar's own width plus the row's gap. Nothing at runtime recomputes it, so
// widening the eval bar silently pushes the coin back off centre. Same shape as
// the --tabbar-h pair above, and the same reason to pin it.
const evalBar = ruleBody(".eval-bar");
const boardRow = ruleBody(".board-row");
const px = (v: string | null) => (v && /^-?\d+(\.\d+)?px$/.test(v) ? parseFloat(v) : NaN);
const evalW = px(decl(evalBar, "width"));
const rowGap = px(decl(boardRow, "gap"));
const evalColRaw = css.slice(0, css.indexOf("}")).match(/--eval-col:\s*([^;]+);/)?.[1]?.trim() ?? null;
const evalCol = px(evalColRaw);

check(".eval-bar and .board-row rules exist", evalBar !== null && boardRow !== null);
check(
  ":root declares --eval-col in px",
  Number.isFinite(evalCol),
  `--eval-col is ${evalColRaw ?? "unset"}`,
);
check(
  "--eval-col is the eval bar plus the row's gap",
  Number.isFinite(evalW) && Number.isFinite(rowGap) && evalCol === evalW + rowGap,
  `--eval-col ${evalCol} vs .eval-bar width ${evalW} + .board-row gap ${rowGap}`,
);
check(
  ".demo-scrim centres its contents on the squares",
  /padding-left:\s*var\(--eval-col\)/.test(ruleBody(".demo-scrim") ?? ""),
  "the coin would sit half an eval bar left of the board's middle",
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

// --- half six: no route styles itself with a class that no longer exists ---
// Deleting a rule is invisible: the class stays in the JSX, the page still
// renders, and it quietly falls back to the browser default. That shipped —
// removing the homepage's `.hero` rules when the homepage stopped using them
// also stripped /gauntlet, /tournament and /profile, whose <h1> went from 46px
// centered to the UA's 30px left-aligned, with nothing to say so.
//
// Two shapes are read. A plain `className="a b"`, and the STATIC SEGMENTS of a
// template literal — `` className={`tc-pill${on ? " active" : ""}`} `` yields
// "tc-pill" and "active". That second half matters: 44 of this app's className
// expressions are template literals, so without it the check would protect the
// static two-thirds and quietly miss `.tc-pill`, `.dot`, `.active` and the rest
// of the classes that only ever appear interpolated.
//
// What it still cannot see is a class assembled from a VALUE — `dot ${status}`
// contributes "dot" but never "ready"/"loading"/"error", and a bare
// `className={cls}` contributes nothing. Those are runtime, and guessing at
// them would invent classes rather than find them.
function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) tsxFiles(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const web = join(__dirname, "..");
// `read` strips comments, which matters here too: a class name mentioned in a
// CSS comment must not count as defined.
const definedClasses = new Set(
  [...[css, boardCss, read("chessground.base.css")]
    .join("\n")
    .matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]),
);

/** A class name a file names statically. `whole: false` means an interpolation
 *  ran straight into it with no space — `` `lands-${side}` `` gives "lands-",
 *  which is a PREFIX of a real class rather than one itself, so it is matched
 *  as such. Without that distinction the choice is between losing every
 *  interpolated class or failing on every concatenated one. */
type NamedClass = { name: string; whole: boolean };

function classesIn(src: string): NamedClass[] {
  const found: NamedClass[] = [];
  for (const m of src.matchAll(/className="([^"{}]+)"/g)) {
    for (const name of m[1].split(/\s+/)) found.push({ name, whole: true });
  }
  // Template literals: the literal text between the `${…}` holes. Split on the
  // holes rather than matching them, so a ternary containing braces cannot
  // swallow the rest of the file.
  for (const m of src.matchAll(/className=\{`([^`]*)`\}/g)) {
    const segments = m[1].split(/\$\{[^}]*\}/);
    segments.forEach((segment, i) => {
      const tokens = segment.split(/\s+/);
      // A token touching a hole continues past it; one with whitespace between
      // is finished. `dot ${status}` completes "dot"; `lands-${side}` does not
      // complete "lands-".
      const openLeft = i > 0 && !/^\s/.test(segment);
      const openRight = i < segments.length - 1 && !/\s$/.test(segment);
      tokens.forEach((name, t) => {
        const whole = !(t === 0 && openLeft) && !(t === tokens.length - 1 && openRight);
        found.push({ name, whole });
      });
    });
  }
  return found.filter((c) => c.name);
}

const definedList = [...definedClasses];
const isDefined = (c: NamedClass) =>
  c.whole ? definedClasses.has(c.name) : definedList.some((d) => d.startsWith(c.name));

// A class that is deliberately a grouping hook with no rule of its own. Keep
// this list short and say why — every entry is a class the check can no longer
// protect.
const UNSTYLED_ON_PURPOSE = new Set([
  // Wraps each round's pairings in the tournament list; the spacing all lives
  // on its children. Predates this check.
  "pairing-round",
]);

const orphans: string[] = [];
for (const file of [...tsxFiles(join(web, "app")), ...tsxFiles(join(web, "components"))]) {
  for (const cls of classesIn(readFileSync(file, "utf8"))) {
    if (isDefined(cls) || UNSTYLED_ON_PURPOSE.has(cls.name)) continue;
    const entry = `${cls.name} (${file.slice(web.length + 1)})`;
    if (!orphans.includes(entry)) orphans.push(entry);
  }
}
check(
  "every class a component names has a rule",
  orphans.length === 0,
  `no CSS defines: ${orphans.join(", ")}`,
);

process.exit(failed === 0 ? 0 : 1);
