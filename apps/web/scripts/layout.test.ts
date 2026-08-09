// Pin the two layout invariants that made the top nav unclickable after a
// game, because both are pure CSS and nothing else in the suite renders a page.
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
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(__dirname, "..", "app", "globals.css"), "utf8");

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

/** The declaration block of the first top-level rule whose selector matches. */
function ruleBody(selector: string): string | null {
  // Rules are matched at any nesting depth (the header rule is top-level, the
  // overlay's is too) by scanning for the selector followed by its block.
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

process.exit(failed === 0 ? 0 : 1);
