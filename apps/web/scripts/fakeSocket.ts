// A stand-in WebSocket for the seat tests, shared by playSeat.test.ts and
// playMove.test.ts. Records what the seat sends and lets a test hand it server
// frames.
//
// `install()` must run BEFORE lib/play is imported — playSeat constructs a
// WebSocket as soon as it is called, and the tests import it dynamically for
// exactly that reason.

export type Sent = Record<string, unknown>;

export class FakeSocket {
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

  /** The `type` of every frame the seat has sent, in order. */
  types() {
    return this.sent.map((m) => m.type);
  }
}

/** Point the global WebSocket at FakeSocket. Call before importing lib/play. */
export function install() {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
}
