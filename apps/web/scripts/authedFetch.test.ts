// Verify the SIWE session: that it is presented as an httpOnly cookie and never
// as anything script can read, that an expired one heals itself instead of
// wedging the UI, and that the move off localStorage signs nobody out.
//
// Sessions live in the server's memory with a 24h TTL, so every deploy voids
// them while the browser still believes it is signed in. The server answers a
// dead session with 401; if the client keeps believing, the user is stuck
// behind a bare status code until they manually sign out — and that lands on
// returning users the day after a deploy. These assert the session is dropped
// exactly when it was the thing rejected, and never otherwise.

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
(globalThis as unknown as { location: unknown }).location = {
  host: "localhost:3000",
  origin: "http://localhost:3000",
};

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`,
  );
}

/** One request as the server would see it. */
type Seen = {
  path: string;
  method: string;
  auth: string | null;
  sessionHeader: string | null;
  credentials: RequestCredentials | undefined;
  keepalive: boolean | undefined;
  body: string | undefined;
  contentType: string | null;
};
let calls: Seen[] = [];

/** Stub fetch: answer per path (a status, or "network" to throw), recording
 *  every request. Unlisted paths answer `fallback`. */
function stubFetch(fallback: number, routes: Record<string, number | "network"> = {}) {
  calls = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    url: string,
    init: RequestInit = {},
  ) => {
    const h = new Headers(init.headers);
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    calls.push({
      path,
      method: init.method ?? "GET",
      auth: h.get("authorization"),
      sessionHeader: h.get("x-openchess-session"),
      credentials: init.credentials,
      keepalive: init.keepalive,
      body: typeof init.body === "string" ? init.body : undefined,
      contentType: h.get("content-type"),
    });
    const status = routes[path] ?? fallback;
    if (status === "network") throw new TypeError("Failed to fetch");
    return { status, ok: status >= 200 && status < 300, json: async () => ({}) } as Response;
  };
}
const call = (path: string) => calls.find((c) => c.path === path);
const callsTo = (path: string) => calls.filter((c) => c.path === path).length;

/** Signed in, as this version stores it: the wallet marker and nothing else. */
const signIn = () => {
  store.clear();
  store.set("openchess.addr", "0xabc");
};
/** A bearer session an earlier version left in localStorage. */
const signInBearer = () => {
  store.clear();
  store.set("openchess.token", "tok-123");
  store.set("openchess.addr", "0xabc");
};
/** One under the PRE-NAMESPACE names a returning visitor may still hold. */
const signInLegacy = () => {
  store.clear();
  store.set("chess_token", "tok-123");
  store.set("chess_addr", "0xabc");
};
const tokenKeys = () => [...store.keys()].filter((k) => /token/.test(k));

async function main() {
  // Imported here (not at top level) so the browser globals above exist first.
  const { authedFetch } = await import("../lib/authedFetch");
  const { authAddress, clearAuth, setAuth } = await import("../lib/escrow");
  const { signInWithEthereum, COOKIE_REFUSED } = await import("../lib/siwe");
  const { sameSite } = await import("../lib/sameSite.mjs");

  // --- the cookie session ---

  // The credential goes out as the cookie: credentials included, the session
  // header (the server's CSRF check, and the "I meant to be signed in" signal),
  // and NO bearer — the page has none to send.
  signIn();
  stubFetch(200);
  await authedFetch("/x");
  check("signed in: credentials are included", call("/x")?.credentials, "include");
  check("signed in: sends the session header", call("/x")?.sessionHeader, "1");
  check("signed in: sends no bearer", call("/x")?.auth, null);

  store.clear();
  stubFetch(200);
  await authedFetch("/x");
  check("signed out: no credentials", call("/x")?.credentials, undefined);
  check("signed out: no session header", call("/x")?.sessionHeader, null);
  check("signed out: no bearer", call("/x")?.auth, null);

  // A rejected session is dropped, so the UI re-renders signed-out.
  signIn();
  stubFetch(401);
  const rejected = await authedFetch("/x");
  check("401 with a session clears it", authAddress(), null);
  // The caller still receives the response, or it could not tell the user why
  // the action failed — clearing must not swallow the result.
  check("401 is still returned to the caller", rejected.status, 401);

  // ...but only when we actually presented one. A 401 on an anonymous call means
  // the route wants sign-in; there is nothing to clear.
  store.clear();
  stubFetch(401);
  await authedFetch("/x");
  check("401 without a session is a no-op", authAddress(), null);
  check("…and revokes nothing", callsTo("/auth/logout"), 0);

  // A working session must survive. Clearing on any non-OK status would sign
  // people out on ordinary errors — worse than the bug being fixed.
  for (const status of [200, 503, 403]) {
    signIn();
    stubFetch(status);
    await authedFetch("/x");
    check(`${status} keeps the session`, authAddress(), "0xabc");
  }

  // Caller headers must survive however they were supplied — a plain object
  // and a Headers instance have to behave identically — and so must the
  // session header alongside them.
  signIn();
  stubFetch(200);
  await authedFetch("/x", { headers: { "content-type": "application/json" } });
  check("keeps a plain-object header", call("/x")?.contentType, "application/json");
  check("…next to the session header", call("/x")?.sessionHeader, "1");
  stubFetch(200);
  await authedFetch("/x", { headers: new Headers({ "content-type": "text/plain" }) });
  check("keeps a Headers instance", call("/x")?.contentType, "text/plain");

  // Nothing script can read is a credential. setAuth records the wallet only.
  store.clear();
  setAuth("0xABC");
  check("a session stores only the wallet marker", [...store.entries()], [["openchess.addr", "0xabc"]]);

  // Signing out revokes the session server-side: the page can't delete an
  // httpOnly cookie, so without this a sign-out left it live for 24h.
  signIn();
  stubFetch(204);
  clearAuth();
  const logout = call("/auth/logout");
  check("sign-out revokes on the server", logout?.method, "POST");
  check("…presenting the cookie session", [logout?.credentials, logout?.sessionHeader], ["include", "1"]);
  check("…surviving a navigation", logout?.keepalive, true);
  check("…and is signed out locally", authAddress(), null);

  // --- sign-in asks for the cookie, and proves it stuck ---

  store.clear();
  stubFetch(200);
  await signInWithEthereum("0xABC", 8453, async () => "0xsig");
  const verify = call("/auth/verify");
  check("sign-in asks for a cookie session", JSON.parse(verify?.body ?? "{}").cookie, true);
  check("…with credentials, so the cookie can be stored", verify?.credentials, "include");
  check("…and confirms it with /auth/me", call("/auth/me")?.sessionHeader, "1");
  check("…then records the wallet", authAddress(), "0xabc");
  check("…and no token", tokenKeys(), []);

  // A browser that drops the cookie (a cross-site API, cookies blocked) must
  // not be shown signed in: every authed call would 401 and sign it out again.
  store.clear();
  stubFetch(200, { "/auth/me": 401 });
  let err: unknown = null;
  await signInWithEthereum("0xABC", 8453, async () => "0xsig").catch((e) => (err = e));
  check("a refused cookie fails sign-in loudly", (err as Error | null)?.message, COOKIE_REFUSED);
  check("…and records no session", authAddress(), null);

  // --- moving a localStorage bearer into the cookie ---
  //
  // Every earlier version stored the session token in localStorage. A returning
  // visitor holding a live one must come out of this deploy signed in — the
  // same promise the `openchess.*` key rename made, and the failure authedFetch
  // exists to prevent.
  signInBearer();
  stubFetch(200);
  await authedFetch("/x");
  check("adoption trades the bearer", call("/auth/cookie")?.auth, "Bearer tok-123");
  check("…with credentials, so the cookie is stored", call("/auth/cookie")?.credentials, "include");
  check("…confirms the cookie came back", call("/auth/me")?.sessionHeader, "1");
  check("…then deletes the token", tokenKeys(), []);
  check("…and stays signed in", authAddress(), "0xabc");
  check("…and the request rides the cookie", [call("/x")?.auth, call("/x")?.sessionHeader], [null, "1"]);

  // The pre-namespace names go the same way (readMigrated adopts them).
  signInLegacy();
  stubFetch(200);
  await authedFetch("/x");
  check("a pre-namespace bearer is adopted too", call("/auth/cookie")?.auth, "Bearer tok-123");
  check("…leaving no token under either name", tokenKeys(), []);
  check("…and its wallet migrated", [store.get("openchess.addr"), store.has("chess_addr")], ["0xabc", false]);

  // The cookie didn't stick: deleting the bearer would sign them out, so keep
  // using it.
  signInBearer();
  stubFetch(200, { "/auth/me": 401 });
  await authedFetch("/x");
  check("cookie refused: the bearer is kept", store.get("openchess.token"), "tok-123");
  check("…and still used", call("/x")?.auth, "Bearer tok-123");
  check("…still signed in", authAddress(), "0xabc");

  // Offline, or a server too old to have the route: keep it, try again later.
  for (const [why, status] of [["offline", "network"], ["an old server", 404], ["a 5xx", 503]] as const) {
    signInBearer();
    stubFetch(200, { "/auth/cookie": status });
    await authedFetch("/x");
    check(`${why}: the bearer is kept`, store.get("openchess.token"), "tok-123");
    check(`${why}: the request still authenticates`, call("/x")?.auth, "Bearer tok-123");
  }

  // A dead bearer is cleared exactly like any other 401 — the deploy-day
  // behaviour, not a new sign-out.
  signInBearer();
  stubFetch(200, { "/auth/cookie": 401 });
  await authedFetch("/x");
  check("a dead bearer signs out", [authAddress(), tokenKeys()], [null, []]);
  check("…and the request goes anonymous", [call("/x")?.auth, call("/x")?.sessionHeader], [null, null]);

  // A bearer still in use (adoption hasn't landed) clears on 401 and leaves
  // no legacy copy for readMigrated to resurrect.
  signInLegacy();
  stubFetch(401, { "/auth/cookie": 503 });
  await authedFetch("/x");
  check("a bearer session clears on 401", [authAddress(), tokenKeys()], [null, []]);

  // A bearer with no wallet predates address binding: never signed in, drop it.
  store.clear();
  store.set("chess_token", "tok-123");
  stubFetch(200);
  await authedFetch("/x");
  check("an unbound bearer is dropped unadopted", [tokenKeys(), callsTo("/auth/cookie")], [[], 0]);

  // A current-name value must win over a stale legacy one rather than being
  // overwritten by it (a tab that signed in after the rename, then met an old
  // leftover key).
  store.clear();
  store.set("chess_token", "old");
  store.set("openchess.token", "new");
  store.set("openchess.addr", "0xabc");
  stubFetch(200);
  await authedFetch("/x");
  check("the current name wins over a legacy leftover", call("/auth/cookie")?.auth, "Bearer new");

  // Concurrent first calls adopt once.
  signInBearer();
  stubFetch(200);
  await Promise.all([authedFetch("/x"), authedFetch("/x"), authedFetch("/x")]);
  check("concurrent calls adopt once", callsTo("/auth/cookie"), 1);

  // --- the same-site rule the production build guard enforces ---
  check("api.openchess.ai is same-site", sameSite("https://api.openchess.ai", "https://openchess.ai"), true);
  check("openchess.fly.dev is cross-site", sameSite("https://openchess.fly.dev", "https://openchess.ai"), false);
  check("ports don't matter", sameSite("http://localhost:8080", "http://localhost:3000"), true);
  check("localhost is not 127.0.0.1", sameSite("http://127.0.0.1:8080", "http://localhost:3000"), false);
  check("garbage is not same-site", sameSite("not a url", "https://openchess.ai"), false);

  console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}

void main();
