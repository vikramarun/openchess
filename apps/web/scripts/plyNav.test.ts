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

// --- timelines ---
// The single transitions above say little about the thing that actually breaks:
// a sequence of clicks interleaved with moves landing on a live board. usePlyNav
// reads `total` through a ref, so every transition sees the CURRENT move count —
// which is what makes this fold a faithful stand-in for the hook, and lets a
// keypress and an arriving move be ordered against each other explicitly.
type Action = "move" | "prev" | "next" | "first" | "live" | { go: number };

function play(...script: Action[]) {
  let ply: Ply = null;
  let total = 0;
  for (const a of script) {
    if (typeof a === "object") ply = goTo(a.go, total);
    else if (a === "move") total++; // a move lands on the live board
    else if (a === "prev") ply = stepPrev(ply, total);
    else if (a === "next") ply = stepNext(ply, total);
    else if (a === "first") ply = 0;
    else ply = null; // the Live pill
  }
  return { at: plyAt(ply, total), live: isLive(ply, total), total };
}

check("hands off: the board follows every move", play("move", "move", "move", "move", "move"), {
  at: 5,
  live: true,
  total: 5,
});
check("step back once and the game goes on without you", play("move", "move", "move", "prev", "move", "move"), {
  at: 2,
  live: false,
  total: 5,
});
check("the Live pill catches you up", play("move", "move", "move", "prev", "move", "move", "live"), {
  at: 5,
  live: true,
  total: 5,
});
// The race the `total` ref exists for: a move lands between your keypress and
// the re-render. Next must advance one ply, not snap you to the new tip.
check("a move landing mid-scrub doesn't hijack the next step", play("move", "move", "move", "prev", "move", "next"), {
  at: 3,
  live: false,
  total: 4,
});
check("walking forward off the end re-attaches, then keeps following", play("move", "move", "first", "next", "next", "move"), {
  at: 3,
  live: true,
  total: 3,
});
// A finished game is the same machine with a frozen `total`.
check("in a replay the tip is just the last ply", play("move", "move", "move", "move", "live", "prev"), {
  at: 3,
  live: false,
  total: 4,
});
check("next at the end of a replay is a no-op", play("move", "move", "move", "move", "next"), {
  at: 4,
  live: true,
  total: 4,
});
check("clicking the move you're already on keeps you there", play("move", "move", "move", { go: 2 }, { go: 2 }), {
  at: 2,
  live: false,
  total: 3,
});

process.exit(failed === 0 ? 0 : 1);
