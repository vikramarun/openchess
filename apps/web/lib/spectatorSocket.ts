// Shared read-only spectator WebSocket with auto-reconnect — one implementation
// for both the wager view (SeatGame) and the spectator page, so the money-path
// reconnect behavior can't drift between them.
//
// The reconnect distinguishes a *transient drop* (the socket was open a while
// before closing — e.g. a live game, or one connected-but-not-yet-started that
// the server holds open silently) from an *absent/reaped room* (the socket opens
// then closes immediately). Only the immediate-close case counts toward the
// give-up cap, so a stale tab neither freezes on a real drop nor churns forever
// on a dead room — and a spectator waiting for a game to start is never given up
// on. The caller owns parsing and the terminal `finished` condition.

/** Milliseconds a socket must stay open to count as a real connection (not an
 *  instantly-rejected dead room). */
const ALIVE_MS = 3000;
/** Consecutive immediate-close failures before we stop reconnecting. */
const MAX_FAST_FAILS = 8;

export function connectSpectator(opts: {
  url: string;
  /** Raw frame payload; the caller parses it and applies game state. */
  onFrame: (data: string) => void;
  onStatus: (status: string) => void;
  /** Status shown once connected, e.g. "playing" (wager) or "watching" (spectate). */
  liveStatus: string;
  /** The game has ended — stop reconnecting. */
  isFinished: () => boolean;
  /** The effect was torn down — stop reconnecting. */
  isCancelled: () => boolean;
}): { close: () => void } {
  let ws: WebSocket | null = null;
  let fastFails = 0;
  let openedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    if (opts.isCancelled() || opts.isFinished()) return;
    openedAt = 0; // reset per attempt: a reconnect that never opens must count as a fast fail
    ws = new WebSocket(opts.url);
    ws.onopen = () => {
      openedAt = Date.now();
      if (!opts.isFinished()) opts.onStatus(opts.liveStatus);
    };
    ws.onmessage = (ev) => {
      fastFails = 0; // a frame proves the room is alive
      opts.onFrame(ev.data);
    };
    ws.onclose = () => {
      if (opts.isCancelled() || opts.isFinished()) return;
      const lived = openedAt > 0 && Date.now() - openedAt > ALIVE_MS;
      fastFails = lived ? 0 : fastFails + 1;
      if (fastFails > MAX_FAST_FAILS) {
        opts.onStatus("disconnected");
        return;
      }
      opts.onStatus("reconnecting…");
      timer = setTimeout(connect, 500 * 2 ** Math.min(Math.max(fastFails - 1, 0), 5)); // ~16s cap
    };
  };
  connect();

  return {
    close: () => {
      if (timer) clearTimeout(timer);
      ws?.close();
    },
  };
}
