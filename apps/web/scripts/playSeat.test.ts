// The pre-game confirmation gate, and the one invariant in it that costs money.
//
// A room the server never started resolves as an abort (draw, stake refunded)
// only while BOTH seats are still attached. A seat that is *gone* hands the
// opponent a forfeit win and the whole stake (`room.rs reap_forfeit_winner`).
// So declining must hold the socket open and wait the room out — a tidy-looking
// `ws.close()` on that path silently converts every refund into a forfeit, and
// nothing else in the suite would notice.

// Browser globals must exist before the module under test is imported. No
// `window`: that keeps `ensureBookLoaded` on its server-side early return
// instead of reaching for indexedDB.
// `export {}` makes this file a MODULE. Without it, tsc treats every script in
// this directory as one global scope and the `failed`/`check` helpers collide
// with the identically-named ones in authedFetch.test.ts.
export {};

type Sent = Record<string, unknown>;

class FakeSocket {
  static last: FakeSocket | null = null;
  sent: Sent[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void | Promise<void>) | null = null;
  constructor(public url: string) {
    FakeSocket.last = this;
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.closed = true;
  }
  /** Deliver a server frame and let the handler's awaits settle. */
  async deliver(msg: Sent) {
    await this.onmessage?.({ data: JSON.stringify(msg) });
    await new Promise((r) => setTimeout(r, 0));
  }
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`,
  );
}

type PlaySeat = typeof import("../lib/play").playSeat;
let playSeat: PlaySeat;

/** Start a seat and hand back its socket, after `welcome` has been processed. */
async function seatAfterWelcome(
  confirmStart?: (deadlineMs: number | null) => Promise<boolean>,
  welcome: Sent = { type: "welcome", start_deadline_ms: 42_000 },
) {
  const engine = {} as never; // never reached: no `your_turn` in these tests
  playSeat("game-1", "tok", engine, 400, confirmStart ? { confirmStart } : {});
  const ws = FakeSocket.last!;
  ws.onopen?.();
  await ws.deliver(welcome);
  return ws;
}

const types = (ws: FakeSocket) => ws.sent.map((m) => m.type);

async function main() {
  // Dynamic import: the fake WebSocket above must be installed first.
  ({ playSeat } = await import("../lib/play"));

  // --- no gate: unchanged behaviour -------------------------------------------
  {
    const ws = await seatAfterWelcome();
    check("without a gate, the seat readies immediately", types(ws), ["hello", "ready"]);
  }

  // --- accepted ---------------------------------------------------------------
  {
    const ws = await seatAfterWelcome(async () => true);
    check("accepting sends ready", types(ws), ["hello", "ready"]);
    check("accepting keeps the socket open", ws.closed, false);
  }

  // --- declined: the invariant ------------------------------------------------
  {
    const ws = await seatAfterWelcome(async () => false);
    check("declining never readies", types(ws), ["hello"]);
    check(
      "declining does NOT close the socket (closing would forfeit the stake)",
      ws.closed,
      false,
    );
  }

  // --- the deadline comes from the server, not from a constant ----------------
  {
    let seen: number | null | undefined;
    await seatAfterWelcome(async (d) => {
      seen = d;
      return false;
    });
    check("the server's start deadline reaches the prompt", seen, 42_000);
  }
  {
    let seen: number | null | undefined = 1;
    await seatAfterWelcome(
      async (d) => {
        seen = d;
        return false;
      },
      { type: "welcome" }, // server too old to report one
    );
    check("a server that omits the deadline yields null, not a bogus number", seen, null);
  }

  // --- game_over still tears the socket down after a decline ------------------
  {
    const ws = await seatAfterWelcome(async () => false);
    await ws.deliver({ type: "game_over", result: { winner: null, reason: "aborted" } });
    check("the void that follows a decline closes the socket", ws.closed, true);
  }

  console.log(failed === 0 ? "\nall checks passed" : `\n${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
