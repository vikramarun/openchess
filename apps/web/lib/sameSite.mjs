// Is the game server on the same SITE as the web app?
//
// The session is a SameSite=Strict cookie on the API host (lib/session.ts), so
// the browser only sends it when the two share a registrable domain:
// `api.openchess.ai` beside `openchess.ai` works, `openchess.fly.dev` does not
// (fly.dev is on the Public Suffix List, so every Fly app is its own site).
// Ports and schemes don't enter into it — `localhost:3000` and
// `localhost:8080` are one site; `localhost` and `127.0.0.1` are two.
//
// Plain .mjs because next.config.mjs imports it for the production build guard.
// "Registrable domain" is approximated as the last two labels, which is right
// for every deployment this app has (a `.co.uk`-style suffix would read as
// same-site when it isn't — the guard would then pass and sign-in would fail
// loudly at the cookie check in lib/siwe.ts instead).

/** @param {string} host */
function site(host) {
  // An IP literal (v4, or v6 in brackets) is its own site.
  if (/^[\d.]+$/.test(host) || host.startsWith("[")) return host;
  return host.split(".").slice(-2).join(".");
}

/** @param {string} a @param {string} b */
export function sameSite(a, b) {
  let ha, hb;
  try {
    ha = new URL(a).hostname.toLowerCase();
    hb = new URL(b).hostname.toLowerCase();
  } catch {
    return false;
  }
  return site(ha) === site(hb);
}
