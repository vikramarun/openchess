// Writes app/icon.svg from lib/brand.ts.
//
// The mark has to exist twice: Next's icon file convention needs a real .svg on
// disk and cannot import from TypeScript. This is the command that keeps the
// copy honest — `pnpm gen:icon` after any change to the geometry, never a hand
// edit. scripts/brand.test.ts fails until the two agree again.
import { writeFileSync } from "node:fs";

import { rookMarkSvg } from "../lib/brand";

const target = new URL("../app/icon.svg", import.meta.url);
writeFileSync(target, `${rookMarkSvg({ tile: true })}\n`);
console.log(`wrote ${target.pathname}`);
