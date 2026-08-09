// Verify the brand mark: that the favicon on disk still matches the one the
// header draws, that the two halves are true mirrors, and that anything
// icon-shaped is opaque.
//
// The first check is the reason this file exists. app/icon.svg has to be a real
// file — Next's icon convention cannot import from TypeScript — so the geometry
// exists twice: once in lib/brand.ts and once baked into that file. Nothing at
// runtime compares them, so a tweak to the path would leave the tab showing the
// previous mark indefinitely and no page screenshot would ever catch it. Same
// arrangement, and same reasoning, as boardPrefs.test.ts pinning the pre-paint
// board script against the React path.
import { readFileSync } from "node:fs";

import { ROOK_LEFT, ROOK_RIGHT, rookMarkSvg } from "../lib/brand";

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`,
  );
}

// --- the file on disk agrees with the module ---
const onDisk = readFileSync(new URL("../app/icon.svg", import.meta.url), "utf8").trim();
check("app/icon.svg matches rookMarkSvg({tile:true})", onDisk, rookMarkSvg({ tile: true }));

// --- the halves are true mirrors about x=32 ---
// Mirroring the right half must reproduce the left exactly. Without this an
// edit to one side alone would skew the mark, which is obvious at 96px and
// invisible at 16px.
function mirrorX(path: string): string {
  const parts = path.match(/[MLHVZ][^MLHVZ]*/g) ?? [];
  return parts
    .map((part) => {
      const cmd = part[0];
      const nums = part
        .slice(1)
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
      if (cmd === "Z") return "Z";
      // M and L carry (x, y); H carries x alone; V carries y and is unaffected.
      const flipped =
        cmd === "V" ? nums : nums.map((n, i) => (i % 2 === 0 ? 64 - n : n));
      return cmd + flipped.join(" ");
    })
    .join(" ");
}
check("the right half mirrors onto the left", mirrorX(ROOK_RIGHT), ROOK_LEFT);
check("mirroring is an involution", mirrorX(mirrorX(ROOK_LEFT)), ROOK_LEFT);

// --- the tiled variant is opaque ---
// On a light browser tab strip the #ededec half of a bare mark disappears and
// leaves half a rook; iOS composites transparent app icons badly too. Every
// icon-shaped use has to carry its own backdrop.
const tiled = rookMarkSvg({ tile: true });
check("the tiled variant paints a backdrop", /<rect[^>]*fill="#161512"/.test(tiled), true);
check("the tiled variant rounds it", /<rect[^>]*rx="12"/.test(tiled), true);
check("the bare variant stays transparent", rookMarkSvg().includes("<rect"), false);

// --- both variants are well-formed and carry both halves ---
for (const [name, svg] of [
  ["bare", rookMarkSvg()],
  ["tiled", tiled],
  ["sized", rookMarkSvg({ size: 180, tile: true })],
] as const) {
  check(`${name}: is a single svg document`, svg.startsWith("<svg") && svg.endsWith("</svg>"), true);
  check(`${name}: declares the svg namespace`, svg.includes('xmlns="http://www.w3.org/2000/svg"'), true);
  check(`${name}: carries both halves`, svg.includes(ROOK_LEFT) && svg.includes(ROOK_RIGHT), true);
}
check("a size is emitted when asked for", rookMarkSvg({ size: 180 }).includes('width="180"'), true);
check("no size is emitted otherwise", rookMarkSvg().includes("width="), false);

// --- the OG cards draw the mark inline, not through an <img> ---
// resvg in a production bundle silently drops a nested SVG image, so a card
// built that way loses its logo and still returns 200 — and the dev server
// renders it fine, so nothing catches it before deploy. Pin the shape of the
// fix, not just the outcome.
for (const path of ["../lib/ogCard.tsx", "../app/apple-icon.tsx"]) {
  const src = readFileSync(new URL(path, import.meta.url), "utf8");
  check(`${path}: draws the mark inline`, src.includes("ROOK_LEFT") && src.includes("ROOK_RIGHT"), true);
  check(`${path}: no data-URI <img>`, /data:image\/svg\+xml/.test(src), false);
}

console.log(failed === 0 ? "\nall brand checks passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
