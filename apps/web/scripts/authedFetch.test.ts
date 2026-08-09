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
const localStorageStub = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
// On BOTH, as a real browser has it: lib/storage.ts reads `window.localStorage`
// (it must, to stay SSR-safe), while older call sites used the bare global.
(globalThis as unknown as { window: unknown }).window = {
  dispatchEvent: () => true,
  addEventListener: () => {},
  removeEventListener: () => {},
  localStorage: localStorageStub,
};
(globalThis as unknown as { localStorage: unknown }).localStorage = localStorageStub;

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
    seenAuth = new Headers(init.headers).get("authorization") ?? undefined;
    return { status, ok: status >= 200 && status < 300 } as Response;
  };
}

/** Seed a session under the CURRENT key names. */
const signIn = () => {
  store.clear();
  store.set("openchess.token", "tok-123");
  store.set("openchess.addr", "0xabc");
};

/** Seed one under the PRE-NAMESPACE names a returning visitor still holds. */
const signInLegacy = () => {
  store.clear();
  store.set("chess_token", "tok-123");
  store.set("chess_addr", "0xabc");
};

async function main() {
  // Imported here (not at top level) so the browser globals above exist first.
  const { authedFetch } = await import("../lib/authedFetch");
  const { authToken, authAddress } = await import("../lib/escrow");

  // A rejected session is dropped, so the UI re-renders signed-out.
  signIn();
  stubFetch(401);
  const rejected = await authedFetch("/x");
  check("401 with a token clears it", authToken(), null);
  // The caller still receives the response, or it could not tell the user why
  // the action failed — clearing must not swallow the result.
  check("401 is still returned to the caller", rejected.status, 401);

  // ...but only when we actually presented one. A 401 on an anonymous call means
  // the route wants sign-in; there is nothing to clear.
  store.clear();
  stubFetch(401);
  await authedFetch("/x");
  check("401 without a token is a no-op", authToken(), null);

  // A working session must survive. Clearing on any non-OK status would sign
  // people out on ordinary errors — worse than the bug being fixed.
  signIn();
  stubFetch(200);
  await authedFetch("/x");
  check("200 keeps the session", authToken(), "tok-123");

  signIn();
  stubFetch(503);
  await authedFetch("/x");
  check("503 keeps the session", authToken(), "tok-123");

  signIn();
  stubFetch(403);
  await authedFetch("/x");
  check("403 keeps the session", authToken(), "tok-123");

  // The credential actually goes out, or none of the above means anything.
  signIn();
  stubFetch(200);
  await authedFetch("/x");
  check("sends the bearer", seenAuth, "Bearer tok-123");

  store.clear();
  stubFetch(200);
  await authedFetch("/x");
  check("omits the header when signed out", seenAuth, undefined);

  // Caller headers must survive however they were supplied — a plain object
  // and a Headers instance have to behave identically.
  let seenType: string | null = null;
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    _u: string,
    init: RequestInit = {},
  ) => {
    seenType = new Headers(init.headers).get("content-type");
    return { status: 200, ok: true } as Response;
  };
  await authedFetch("/x", { headers: { "content-type": "application/json" } });
  check("keeps a plain-object header", seenType, "application/json");
  await authedFetch("/x", { headers: new Headers({ "content-type": "text/plain" }) });
  check("keeps a Headers instance", seenType, "text/plain");

  // --- the pre-namespace key migration ---
  //
  // Keys were renamed to `openchess.*`; a returning visitor still holds the old
  // pair. Reading has to ADOPT it, not ignore it — ignoring would have signed
  // out every signed-in user the moment this deployed, which is the exact
  // failure authedFetch itself exists to prevent.
  signInLegacy();
  check("a legacy token is adopted, not lost", authToken(), "tok-123");
  check("…and its wallet with it", authAddress(), "0xabc");
  check("the legacy name is cleaned up", store.has("chess_token"), false);
  check("…under the new one", store.get("openchess.token"), "tok-123");

  // A migrated session still rides on the wire and still clears on 401.
  signInLegacy();
  stubFetch(200);
  await authedFetch("/x");
  check("a migrated session sends its bearer", seenAuth, "Bearer tok-123");
  signInLegacy();
  stubFetch(401);
  await authedFetch("/x");
  check("a migrated session clears on 401", authToken(), null);
  check("and leaves no legacy copy to resurrect", store.has("chess_token"), false);

  // A current-name value must win over a stale legacy one rather than being
  // overwritten by it (a tab that signed in after the rename, then met an old
  // leftover key).
  store.clear();
  store.set("chess_token", "old");
  store.set("openchess.token", "new");
  check("the current name wins over a legacy leftover", authToken(), "new");

  console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}

void main();
