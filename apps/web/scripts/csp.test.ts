// Pin the Content-Security-Policy entries that sign-in depends on.
//
// A CSP is the rare config where a mistake is invisible everywhere except the
// browser: dropping an origin type-checks, builds, deploys, and then blocks a
// fetch at runtime with nothing but a console message. Sign-in is the worst
// place for that, because it's the one flow every user hits before they can do
// anything else, and the failure looks like "the button doesn't work".
//
// Two directions are checked. Forwards: Dynamic's origin has to be reachable
// (connect-src) and frameable (frame-src), or email/Google login and the
// embedded wallet can't function. Backwards: the WalletConnect and Coinbase
// entries have to survive, since it would be easy to "clean up" the connector
// origins while swapping connect layers and only find out when someone tries to
// pair a phone wallet.
//
// This imports next.config.mjs and calls headers() rather than grepping the
// source, so it reads what Next will actually serve — including anything the
// env-dependent branches add.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "ok " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

/** Split a CSP into `directive -> sources`. */
function directives(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name, sources);
  }
  return out;
}

async function main() {
  const configUrl = pathToFileURL(join(__dirname, "..", "next.config.mjs")).href;
  const config = (await import(configUrl)).default;

  const routes = await config.headers();
  // The catch-all route is the one carrying the security headers; the other two
  // entries only set immutable caching for /engines and /books.
  const all = routes.find((r: any) => r.source === "/:path*");
  check("catch-all header route exists", !!all);
  if (!all) return process.exit(1);

  const csp: string | undefined = all.headers.find(
    (h: any) => h.key === "Content-Security-Policy",
  )?.value;
  check("Content-Security-Policy is set", !!csp);
  if (!csp) return process.exit(1);

  const d = directives(csp);
  const has = (directive: string, source: string) =>
    (d.get(directive) ?? []).includes(source);

  // --- Dynamic (sign-in + embedded wallet) ---
  check(
    "connect-src allows Dynamic's API",
    has("connect-src", "https://app.dynamicauth.com"),
    `connect-src is ${(d.get("connect-src") ?? []).join(" ") || "unset"}`,
  );
  check(
    "frame-src allows Dynamic's embedded-wallet iframe",
    has("frame-src", "https://app.dynamicauth.com"),
    `frame-src is ${(d.get("frame-src") ?? []).join(" ") || "unset"}`,
  );
  // Dynamic serves its wallet list from a different domain than its API, which
  // is easy to miss because sign-in itself still works without it — the connect
  // modal just opens empty. Found by watching the console, not by reading docs.
  check(
    "connect-src allows Dynamic's asset CDN (the connect modal's wallet list)",
    has("connect-src", "https://dynamic-static-assets.com"),
  );

  // --- regression guards: the external-wallet connectors still work ---
  check(
    "connect-src keeps the WalletConnect relay",
    has("connect-src", "wss://*.walletconnect.org") ||
      has("connect-src", "wss://*.walletconnect.com"),
  );
  check("connect-src keeps Coinbase Wallet", has("connect-src", "https://*.coinbase.com"));
  check("frame-src keeps WalletConnect", has("frame-src", "https://*.walletconnect.org"));
  // Dynamic's MetaMask connector pairs with the mobile app over MetaMask SDK's
  // relay socket. Only mobile breaks without it — the desktop extension uses the
  // injected provider — so it survives any amount of local testing.
  check("connect-src allows the MetaMask SDK relay (mobile pairing)", has("connect-src", "wss://*.metamask.io"));

  // --- the hardening that predates this change ---
  check(
    "frame-ancestors stays 'none'",
    (d.get("frame-ancestors") ?? []).join(" ") === "'none'",
    `frame-ancestors is ${(d.get("frame-ancestors") ?? []).join(" ") || "unset"}`,
  );
  // The in-browser engine is WASM; without this every board silently loses its
  // opponent.
  check("script-src allows WASM compilation", has("script-src", "'wasm-unsafe-eval'"));
  check("worker-src allows the Stockfish worker", has("worker-src", "blob:"));

  process.exit(failed === 0 ? 0 : 1);
}

main();
