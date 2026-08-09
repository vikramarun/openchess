// The script that applies the saved board theme BEFORE first paint.
//
// Without it every navigation shows the default brown board for a frame and
// then snaps to the user's theme, because localStorage can only be read on the
// client and React runs after the first paint. This is the same trick a
// light/dark site theme uses; `script-src` already allows 'unsafe-inline'.
//
// The script is generated from the same tables the app renders from, so the two
// cannot drift. It embeds the square path and the color rows (~1 KB) and builds
// the data URI itself, rather than embedding all eight pre-built URIs (~8 KB).

import { BOARD_THEMES, DARK_SQUARES, DEFAULT_BOARD_THEME } from "./boardThemes";
import { COLORS, DEFAULT_PIECE_SET, PIECE_SETS, ROLES } from "./pieceSets";
import { COORDS_MODES, DEFAULT_PREFS, STORAGE_KEY } from "./boardPrefs";

/** JSON safe to sit inside a <script> element. Our data is hex colors and ids,
 *  but escaping `<` keeps a future theme name from being able to close the tag. */
function embed(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function boardBootstrapScript(): string {
  const themes: Record<string, string[]> = {};
  for (const t of BOARD_THEMES) {
    themes[t.id] = [t.light, t.dark, t.coordOnLight, t.coordOnDark, t.lastMove];
  }
  const sets = PIECE_SETS.map((p) => p.id);

  // Kept deliberately terse — this runs on every page load, inline in the HTML.
  return `(function(){try{
var T=${embed(themes)},S=${embed(sets)},D=${embed(DARK_SQUARES)},
C=${embed(COLORS)},R=${embed(ROLES)},
p={};try{p=JSON.parse(localStorage.getItem(${embed(STORAGE_KEY)}))||{}}catch(e){}
var t=T[p.board]||T[${embed(DEFAULT_BOARD_THEME)}],
s=S.indexOf(p.pieces)>=0?p.pieces:${embed(DEFAULT_PIECE_SET)},
g='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" shape-rendering="crispEdges"><rect width="8" height="8" fill="'+t[0]+'"/><path fill="'+t[1]+'" d="'+D+'"/></svg>',
h=document.documentElement,e=h.style;
e.setProperty('--board-bg','url("data:image/svg+xml,'+encodeURIComponent(g)+'")');
e.setProperty('--board-light',t[0]);e.setProperty('--board-dark',t[1]);
e.setProperty('--board-coord-on-light',t[2]);e.setProperty('--board-coord-on-dark',t[3]);
e.setProperty('--board-last-move',t[4]);
for(var i=0;i<C.length;i++)for(var j=0;j<R.length;j++)
e.setProperty('--piece-'+C[i][0]+'-'+R[j][0],'url("/piece/'+s+'/'+C[i][1]+R[j][1]+'.svg")');
h.setAttribute('data-coords',${embed(COORDS_MODES)}.indexOf(p.coords)>=0?p.coords:${embed(DEFAULT_PREFS.coords)});
}catch(e){}})()`;
}
