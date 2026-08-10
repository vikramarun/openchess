// Which routes require an account, and the one that must not.
//
// The product rule is "you have to sign in to play, but you can try the engine
// first". Both halves fail silently and in opposite directions, which is why
// they are worth a test rather than a comment.
//
// Lose the gate on /lobby and the browse tables invite a signed-out visitor to
// click "Join & play" on a real staked game; the failure surfaces as a 401 from
// the server three steps later, which is exactly the dead end the gate exists to
// remove. Wrap /play by accident — or wrap the homepage's <h1> and hero along
// with its Play card — and the only routes a stranger can see become a sign-in
// wall, so the marketing page stops marketing and the one "try it" surface stops
// being reachable. Neither shows up in a build, a type check, or a screenshot of
// a signed-in session, which is every other check this suite has.
//
// This is a grep, in the same style as the demo-reel import check: it reads what
// each page FILE says rather than rendering it. That cannot prove the gate
// works — `pnpm test:auth` covers the session plumbing under it — but it does
// prove nobody deleted it, which is the regression that actually happens.
import { readFileSync } from "node:fs";
import { join } from "node:path";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

const web = join(__dirname, "..");
const read = (p: string) => readFileSync(join(web, p), "utf8");

// --- gated: everything that can seat you in a real game ---
// Each of these either starts a game that lands in someone's history and moves
// an Elo, or locks USDC.
const GATED = [
  ["app/page.tsx", "the homepage Play card"],
  ["app/lobby/page.tsx", "/lobby"],
  ["app/gauntlet/page.tsx", "/gauntlet"],
  ["app/tournament/page.tsx", "/tournament"],
] as const;

for (const [file, what] of GATED) {
  const src = read(file);
  check(
    `${what} is behind RequireSignIn`,
    /<RequireSignIn\b/.test(src),
    `no <RequireSignIn> in ${file}`,
  );
}

// --- ungated: the way in without an account ---
// Two Stockfish workers on the visitor's own CPU. Nobody is seated, both seat
// wallets are NULL, and the game is filtered out of the spectate lobby
// (TEST_MODE, pinned server-side). Gating it would leave a stranger with
// nothing to look at but a wall.
const play = read("app/play/page.tsx");
check(
  "/play is NOT gated",
  !/RequireSignIn/.test(play),
  "Test Engine is the one route that must work signed out",
);
// …and it must stay cheap, for the same reason the landing reel never touches
// the engine: this is the whole top of the funnel on a cold mobile connection.
// The default repertoire is every book — ~1 MB over 24 requests — and two
// engines playing each other show the viewer nothing for it.
check(
  "/play skips the downloaded repertoire",
  /skipRepertoire:\s*true/.test(play),
  "no `skipRepertoire: true` in app/play/page.tsx",
);

// --- the homepage keeps its hero OUTSIDE the gate ---
// The gate wraps the Play card only. `<Lobby` must sit inside a <RequireSignIn>
// while the hero, the reel and "How stakes work" stay out of it — a wall in
// front of those is a wall in front of the only thing that explains the product,
// and it would take the page's only <h1> out of the server render with it.
const home = read("app/page.tsx");
const gateStart = home.indexOf("<RequireSignIn");
const gateEnd = home.indexOf("</RequireSignIn>");
check(
  "the homepage gate is a well-formed region",
  gateStart !== -1 && gateEnd > gateStart,
  "could not find a <RequireSignIn>…</RequireSignIn> region in app/page.tsx",
);
if (gateStart !== -1 && gateEnd > gateStart) {
  const inside = home.slice(gateStart, gateEnd);
  check("the Play card is inside the gate", /<Lobby\b/.test(inside), "no <Lobby> inside the gate");
  check(
    "the hero is outside the gate",
    !/<HomeDemo\b/.test(inside) && /<HomeDemo\b/.test(home),
    "the demo reel must render for a signed-out visitor",
  );
  check(
    "the h1 is outside the gate",
    !/<h1\b/.test(inside) && /<h1\b/.test(home),
    "the landing page's only heading must not need an account",
  );
}

// --- the gate itself can't call a Dynamic hook unguarded ---
// providers.tsx omits DynamicContextProvider entirely without an environment id
// (lib/dynamicEnv.ts), and the context then defaults to `undefined`, so a hook
// read against it THROWS and the root error boundary blanks the page. That
// mattered less when a missing env id only cost the sign-in button; these four
// routes are now unreachable without Dynamic, so the gate has to branch.
const gate = read("components/SignInGate.tsx");
check(
  "SignInGate checks dynamicConfigured",
  /dynamicConfigured/.test(gate),
  "an unconfigured deploy would white-screen every gated route",
);
// The other half: the gate must not wait on /config. useOnchainConfig retries a
// failed fetch forever with backoff, so answering "checking" until it lands
// turns an unreachable game server into a permanently blank page on every gated
// route — strictly worse than showing the prompt.
const checkingReturns = [...gate.matchAll(/return\s+"checking"/g)].length;
check(
  "only one state resolves to `checking`",
  checkingReturns === 1,
  `${checkingReturns} \`return "checking"\` branches — the only honest one is !mounted; ` +
    "anything gated on a fetch hangs the page when the server is down",
);

// --- the gate is a DOOR, not a fence ---
// The most expensive thing in this file. <SeatGame> renders under RequireSignIn,
// so a gate that RETRACTS unmounts a live board and closes its socket — and a
// seat that is gone (rather than idle) hands the opponent a forfeit win and the
// whole stake, per room.rs reap_forfeit_winner. Every ordinary way a token
// disappears would then confiscate a stake from someone sitting right there
// playing: authedFetch dropping a stale token on a 401, the 24h session TTL
// lapsing mid-game, a wallet disconnect or account switch firing clearAuth.
//
// So once admitted, it stays admitted for the life of the mount. Nothing is lost
// — the server re-checks the session on every route these pages call, and a
// fresh visit remounts. Grepped rather than rendered, like the rest of this
// file: what matters is that the latch is still there.
check(
  "admission latches",
  /admitted/.test(gate) && /state === "in" \|\| admitted/.test(gate),
  "RequireSignIn must keep rendering children once it has admitted someone — " +
    "retracting unmounts a live board and forfeits its stake",
);
check(
  "the latch is set during render, not in an effect",
  /if \(state === "in" && !admitted\) setAdmitted\(true\)/.test(gate) &&
    !/useEffect\([^)]*setAdmitted/.test(gate),
  "an effect runs after paint, so the wall would flash over a live board first",
);

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
