// A username's shape, and what a player is called.
//
// Three of these guard failures that are silent rather than loud:
//   * `isUsernameShape` and `validateUsername` are deliberately DIFFERENT
//     strictnesses. Merging them (the obvious "simplification") breaks routing,
//     not validation — a live profile starts 404ing client-side while the server
//     serves it happily.
//   * `usernameFailure` must key on the body's error code, not the status. A
//     bare 403, or a 429 from either of the router's two rate limits, must never
//     be reported as "you can change again in 7 days" — a wrong message that
//     also sounds unrecoverable.
//   * `playerLabel` must treat "" as absent. `username ?? shortAddress(addr)`
//     renders a BLANK name the moment a payload carries an empty string.
import { isAddress, isUsernameShape } from "../lib/address";
import { playerLabel, sanitizeLabel } from "../lib/playerLabel";
import {
  cooldownMessage,
  daysUntil,
  usernameFailure,
  validateUsername,
} from "../lib/username";
import { SESSION_EXPIRED } from "../lib/authedFetch";

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`,
  );
}

const valid = (s: string) => validateUsername(s).ok;

// ---------------------------------------------------------------- the grammar

check("3 characters is the floor", [valid("ab"), valid("abc")], [false, true]);
check(
  "20 characters is the ceiling",
  [valid("a".repeat(20)), valid("a".repeat(21))],
  [true, false],
);
check("letters, digits and underscore", valid("a_B9"), true);
for (const bad of ["a-b", "a b", "a.b", "a%b", "héllo", "аbcd", "ab😀", " abc", "abc "]) {
  check(`rejects ${JSON.stringify(bad)}`, valid(bad), false);
}
check("nothing is trimmed INTO validity", valid(" alice "), false);

// The most useful message wins: a short string with a dash in it has a length
// problem to fix before the charset even matters.
check(
  "message order is length before charset",
  validateUsername("a-"),
  { ok: false, error: "Usernames are 3–20 characters." },
);

// ------------------------------------------------------------- the 0x rule

check("a username can't start with 0x", [valid("0xdead"), isUsernameShape("0xdead")], [false, false]);
check("even upper-case 0X", valid("0Xdead"), false);

// ------------------------------------------- the two predicates differ ON PURPOSE

// Routing must resolve a name the server issued before a word joined the
// reserved list; validation must still refuse it at the editor. Collapsing
// these into one function is the refactor this test exists to fail.
check(
  "reserved is refused by the editor but still routable",
  [isUsernameShape("admin"), valid("admin")],
  [true, false],
);
check("reserved is case-insensitive", [valid("Admin"), valid("ADMIN")], [false, false]);
check("a route segment can never be claimed", valid("search"), false);
check(
  "an address is not a username and vice versa",
  [
    isAddress("0xebe9b106daf6da2f6df201074eddc53030168ea2"),
    isUsernameShape("0xebe9b106daf6da2f6df201074eddc53030168ea2"),
    isUsernameShape("alice"),
    isAddress("alice"),
  ],
  [true, false, true, false],
);

// ----------------------------------------------------------------- the cooldown

const NOW = Date.parse("2026-08-09T12:00:00Z");
const inDays = (d: number) => new Date(NOW + d * 86_400_000).toISOString();

check("days round up and floor at zero", [
  daysUntil(inDays(0.2), NOW),
  daysUntil(inDays(6.1), NOW),
  daysUntil(inDays(-3), NOW),
], [1, 7, 0]);
check("today", cooldownMessage(inDays(-1), NOW), "You can change your username again today.");
check("tomorrow", cooldownMessage(inDays(0.5), NOW), "You can change your username again tomorrow.");
check("in n days", cooldownMessage(inDays(6.1), NOW), "You can change your username again in 7 days.");

// ------------------------------------------------------------ failure messages

check(
  "409 is taken",
  usernameFailure(409, { error: "taken" }),
  "That username is already taken.",
);
check(
  "403 with a cooldown body says when",
  usernameFailure(403, { error: "cooldown", next_change_at: inDays(6.1) }, NOW),
  "You can change your username again in 7 days.",
);
// The regression guards. A 403 that is not a cooldown, and a 429 from either
// rate limit, must not borrow the cooldown's wording.
check(
  "a bare 403 is NOT the cooldown message",
  usernameFailure(403, null),
  "Couldn’t save your username (403).",
);
check(
  "429 is throttling, not the cooldown",
  usernameFailure(429, null),
  "Too many tries. Wait a moment and try again.",
);
check("401 defers to the session message", usernameFailure(401, null), SESSION_EXPIRED);
check(
  "a reserved name reports itself",
  usernameFailure(400, { error: "invalid", reason: "reserved" }),
  "That username is reserved.",
);
check(
  "any other refusal shows the status",
  usernameFailure(500, null),
  "Couldn’t save your username (500).",
);

// ------------------------------------------------------------------ the label

const ADDR = "0xebe9b106daf6da2f6df201074eddc53030168ea2";
check(
  "username beats name beats address",
  [
    playerLabel({ username: "alice", name: "bob", address: ADDR }),
    playerLabel({ name: "bob", address: ADDR }),
    playerLabel({ address: ADDR }),
  ],
  ["alice", "bob", "0xebe9…8ea2"],
);
check(
  "an empty username falls THROUGH rather than blanking the name",
  [
    playerLabel({ username: "", name: "bob", address: ADDR }),
    playerLabel({ username: "   ", address: ADDR }),
  ],
  ["bob", "0xebe9…8ea2"],
);
check(
  "with nothing at all, the fallback",
  [playerLabel({ fallback: "Engine" }), playerLabel({})],
  ["Engine", ""],
);
check(
  "maxLen collapses whitespace and truncates",
  [playerLabel({ name: "a  b\n c", maxLen: 28 }), sanitizeLabel("x".repeat(40), 10)],
  ["a b c", "xxxxxxxxx…"],
);

console.log(failed === 0 ? "\nall username tests passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
