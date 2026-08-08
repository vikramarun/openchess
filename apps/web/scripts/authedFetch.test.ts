// Verify that an expired session heals itself instead of wedging the UI.
//
// Sessions live in the server's memory with a 24h TTL, so every deploy voids
// them while the browser still holds the token. The server answers a stale
// bearer with 401; if the client keeps it, the user is stuck behind a bare
// status code until they manually sign out — and that lands on returning users
// the day after a deploy. These assert the token is dropped exactly when it was
// the thing rejected, and never otherwise.

// Browser globals must exist before the module under test is imported, since it
// reaches localStorage at call time — hence the dynamic import below.
const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  dispatchEvent: () => true,
  addEventListener: () => {},
  removeEventListener: () => {},
};
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`,
  );
}

/** Stub fetch with a fixed status; records the headers it was handed. */
let seenAuth: string | undefined;
function stubFetch(status: number) {
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    _url: string,
    init: RequestInit = {},
  ) => {
    seenAuth = (init.headers as Record<string, string> | undefined)?.authorization;
    return { status, ok: status >= 200 && status < 300 } as Response;
  };
}

const signIn = () => {
  store.set("chess_token", "tok-123");
  store.set("chess_addr", "0xabc");
};

async function main() {
  // Imported here (not at top level) so the browser globals above exist first.
  const { authedFetch } = await import("../lib/authedFetch");

  // A rejected session is dropped, so the UI re-renders signed-out.
  signIn();
  stubFetch(401);
  await authedFetch("/x");
  check("401 with a token clears it", store.has("chess_token"), false);

  // ...but only when we actually presented one. A 401 on an anonymous call means
  // the route wants sign-in; there is nothing to clear.
  store.clear();
  stubFetch(401);
  await authedFetch("/x");
  check("401 without a token is a no-op", store.has("chess_token"), false);

  // A working session must survive. Clearing on any non-OK status would sign
  // people out on ordinary errors — worse than the bug being fixed.
  signIn();
  stubFetch(200);
  await authedFetch("/x");
  check("200 keeps the session", store.get("chess_token"), "tok-123");

  signIn();
  stubFetch(503);
  await authedFetch("/x");
  check("503 keeps the session", store.get("chess_token"), "tok-123");

  signIn();
  stubFetch(403);
  await authedFetch("/x");
  check("403 keeps the session", store.get("chess_token"), "tok-123");

  // The credential actually goes out, or none of the above means anything.
  signIn();
  stubFetch(200);
  await authedFetch("/x");
  check("sends the bearer", seenAuth, "Bearer tok-123");

  store.clear();
  stubFetch(200);
  await authedFetch("/x");
  check("omits the header when signed out", seenAuth, undefined);

  console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}

void main();
