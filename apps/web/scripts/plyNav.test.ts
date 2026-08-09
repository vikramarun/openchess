// Verify the move-navigation state machine (lib/plyNav.ts) that the replay, the
// spectator, and both playing views share. The rules that matter are the ones
// about a LIVE game, whose `total` grows under the viewer: following the tip has
// to be distinguishable from sitting on the ply that happens to be last, or
// every new move yanks a scrubbed-back viewer forward.
import { goTo, isLive, plyAt, stepNext, stepPrev, type Ply } from "../lib/plyNav";

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`,
  );
}

// --- following the tip ---
check("following the tip tracks a growing game", plyAt(null, 12), 12);
check("following the tip is live", isLive(null, 12), true);
check("an empty game is at the start", plyAt(null, 0), 0);

// --- a parked ply stays parked ---
check("a parked ply ignores new moves", plyAt(5, 40), 5);
check("a parked ply is not live", isLive(5, 40), false);
check("sitting on the last ply IS live", isLive(12, 12), true);
check("a negative ply clamps to the start", plyAt(-3, 12), 0);

// --- jumping ---
check("jump to a middle ply parks there", goTo(4, 12), 4);
check("jump to the last ply re-attaches to the tip", goTo(12, 12), null);
check("jump past the end re-attaches", goTo(99, 12), null);
check("jump before the start clamps", goTo(-2, 12), 0);

// --- stepping ---
check("next from a parked ply advances", stepNext(4, 12), 5);
check("next onto the last ply re-attaches", stepNext(11, 12), null);
check("next while following stays following", stepNext(null, 12), null);
check("prev from the tip parks one back", stepPrev(null, 12), 11);
check("prev from a parked ply steps back", stepPrev(5, 12), 4);
check("prev at the start stays at the start", stepPrev(0, 12), 0);

// --- the trap: a remembered ply outliving its game ---
// /play is not remounted between games (the gauntlet and tournament key SeatGame
// by game id, so they are). A ply is CLAMPED, never dropped, so a viewer who
// scrubbed to move 5 and started a new game would ride the clamp up to 5 and pin
// there while the new game played on. Hence startOver() = reset() + follow tip.
const parked: Ply = 5;
check("a new game starts clamped to its (empty) length", plyAt(parked, 0), 0);
check("...then rides the clamp up", [1, 3, 5].map((t) => plyAt(parked, t)), [1, 3, 5]);
check("...and pins there as the game plays on", plyAt(parked, 30), 5);
check("...pinned means not live, so the Live pill is offered", isLive(parked, 30), false);
check("re-attaching is the only escape", plyAt(null, 30), 30);

process.exit(failed === 0 ? 0 : 1);
