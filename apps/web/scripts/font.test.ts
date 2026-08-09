// Verify the UI font is actually loaded, and not merely named.
//
// This exists because the CSS named "Noto Sans" as its first family for the
// life of the project while nothing ever loaded it — no next/font, no
// @font-face, no link tag — so every visitor silently got SF Pro or Segoe UI
// and the site never rendered in the font it claimed. Nothing caught it: the
// page looks fine in the wrong font, so a screenshot proves nothing and the
// build is perfectly happy.
//
// The fix reintroduces the same shape of risk in a new form. globals.css asks
// for var(--font-sans) and app/layout.tsx defines it; delete the next/font call
// and the CSS still parses, still cascades, and quietly falls back forever.
// Rename the variable on one side only and you get the same silence. So the
// checks below compare the two files against each other rather than against a
// hardcoded name.
import { readFileSync } from "node:fs";

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`,
  );
}

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const layout = read("../app/layout.tsx");
const globals = read("../app/globals.css");
const board = read("../app/board.css");

// --- something actually loads a font ---
check("layout.tsx loads a font through next/font", /from "next\/font\//.test(layout), true);
check(
  "it is Noto Sans, the family the CSS has always named",
  /Noto_Sans\s*\(/.test(layout),
  true,
);

// --- the two sides agree on the variable name ---
// The whole point. A mismatch here is invisible at runtime: the cascade just
// falls through to the system stack, exactly as it did before this was fixed.
const declared = layout.match(/variable:\s*"(--[a-z0-9-]+)"/i)?.[1];
const bodyBlock = globals.match(/^html,\s*\nbody\s*\{[\s\S]*?\n\}/m)?.[0] ?? "";
const applied = bodyBlock.match(/font-family:\s*var\((--[a-z0-9-]+)\)/i)?.[1];

check("layout.tsx declares a CSS variable for the font", declared !== undefined, true);
check("globals.css applies one to html/body", applied !== undefined, true);
check("the two are the same variable", applied, declared);

// --- the variable actually reaches the document ---
// next/font only defines the variable; the class has to be on an element that
// the whole page inherits from, or nothing downstream can see it.
check(
  "the font class is stamped on <html>",
  /<html[^>]*className=\{[^}]*\.variable/.test(layout),
  true,
);

// --- a real fallback survives behind it ---
// If the font ever fails, text must still render in something sane rather than
// dropping to the browser default.
check(
  "a system stack still follows the variable",
  /font-family:\s*var\(--[a-z0-9-]+\),[\s\S]*?sans-serif;/i.test(bodyBlock),
  true,
);

// --- the font stays first-party ---
// next/font self-hosts, which is why next.config.mjs can keep `font-src 'self'`
// with no CDN entry. A <link> to Google Fonts would be blocked by that CSP —
// and would leak every visitor to a third party.
for (const [name, src] of [
  ["layout.tsx", layout],
  ["globals.css", globals],
] as const) {
  check(`${name}: no third-party font origin`, /gstatic|fonts\.googleapis/.test(src), false);
}

// --- the board's coordinates come along ---
// chessground hardcodes `font-family: sans-serif` on coords, so without an
// override the a-h/1-8 are the only text on screen left in the browser's
// generic sans. It has to live in board.css: chessground.base.css is vendored
// and replaced wholesale on a bump.
check(
  "board.css overrides the coord font",
  /\.cg-wrap coords\s*\{[^}]*font-family/.test(board),
  true,
);
// And the override is still needed: if a chessground bump ever stops hardcoding
// the family, this becomes dead CSS that should be deleted rather than left to
// puzzle the next reader.
const vendoredCoords =
  read("../app/chessground.base.css").match(/\.cg-wrap coords\s*\{[^}]*\}/)?.[0] ?? "";
check(
  "chessground still hardcodes a family, so the override earns its place",
  /font-family/.test(vendoredCoords),
  true,
);

console.log(failed === 0 ? "\nall font checks passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
