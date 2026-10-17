// The escrow's tournament record, in both contract layouts.
//
// The two-clock escrow inserted `startedAt` into the struct, so the same
// `tournaments(bytes32)` call returns 8 words on the live v2 and 9 after the
// redeploy. The web app decoded it with a fixed 8-field ABI: against the new
// contract every open tournament read as nonexistent (payoutRoot's zero word
// landed in `exists`) and every started one threw (a timestamp is not a bool),
// so the claim, refund and sponsor-reclaim buttons all disappeared. And the
// refund clock moved: an event that never started refunds at
// `openedAt + entryWindow`, a started one at `startedAt + settleTimeout`.
import { encodeAbiParameters } from "viem";

import { decodeTournament, refundOpensAt } from "../lib/tournamentRecord";

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) ===
    JSON.stringify(want, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  if (!ok) failed++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got ${String(got)} want ${String(want)}`}`);
}

const ROOT = `0x${"ab".repeat(32)}` as const;
const ZERO = `0x${"00".repeat(32)}` as const;
const v2 = (o: { settled?: boolean; exists?: boolean; root?: `0x${string}` } = {}) =>
  encodeAbiParameters(
    ["uint256", "uint256", "uint256", "uint32", "uint64", "bool", "bytes32", "bool"].map((type) => ({ type })),
    [1_000_000n, 3_000_000n, 0n, 3, 1_000n, o.settled ?? false, o.root ?? ZERO, o.exists ?? true],
  );
const v3 = (startedAt: bigint, o: { settled?: boolean; exists?: boolean; root?: `0x${string}` } = {}) =>
  encodeAbiParameters(
    ["uint256", "uint256", "uint256", "uint32", "uint64", "uint64", "bool", "bytes32", "bool"].map((type) => ({ type })),
    [1_000_000n, 3_000_000n, 0n, 3, 1_000n, startedAt, o.settled ?? false, o.root ?? ZERO, o.exists ?? true],
  );

// v2 decodes as before.
const a = decodeTournament(v2({ root: ROOT, settled: true }));
check("v2: buyIn", a.buyIn, 1_000_000n);
check("v2: pool", a.pool, 3_000_000n);
check("v2: openedAt", a.openedAt, 1_000);
check("v2: no start transition", a.startedAt, null);
check("v2: settled", a.settled, true);
check("v2: payoutRoot", a.payoutRoot, ROOT);
check("v2: exists", a.exists, true);

// The two-clock layout: an OPEN tournament must still exist (the old decode
// read the zero payoutRoot word as `exists`), and a started one must decode
// rather than throw on its timestamp.
const open = decodeTournament(v3(0n));
check("v3 open: exists", open.exists, true);
check("v3 open: not started", open.startedAt, 0);
check("v3 open: not settled", open.settled, false);
const started = decodeTournament(v3(1_500n, { root: ROOT }));
check("v3 started: startedAt", started.startedAt, 1_500);
check("v3 started: payoutRoot", started.payoutRoot, ROOT);
check("v3 started: exists", started.exists, true);

// Anything else is refused, not guessed at.
let threw = false;
try {
  decodeTournament(`0x${"00".repeat(32 * 7)}`);
} catch {
  threw = true;
}
check("an unknown width throws", threw, true);

// The refund clock, per contract.
const T = 86_400, W = 4 * 3600;
check("v2 refunds at openedAt + settleTimeout", refundOpensAt(a, T, null), 1_000 + T);
check("v3 unstarted refunds at openedAt + entryWindow", refundOpensAt(open, T, W), 1_000 + W);
check("v3 unstarted with entryWindow unknown: no answer yet", refundOpensAt(open, T, null), null);
check("v3 started refunds at startedAt + settleTimeout", refundOpensAt(started, T, W), 1_500 + T);

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall ok");
