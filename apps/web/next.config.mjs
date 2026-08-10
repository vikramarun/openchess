/** @type {import('next').NextConfig} */

// --- Security headers -------------------------------------------------------
// This is a wallet-signing money app, so it ships a Content-Security-Policy and
// the standard hardening headers. The CSP is scoped to exactly the origins the
// app talks to: the game server (env), Base's default RPCs (wagmi), Dynamic's
// auth/embedded-wallet API, and WalletConnect's relay/explorer.
// `frame-ancestors 'none'` + X-Frame-Options block clickjacking of the
// Deposit/Withdraw and Finish-sign-in buttons.
//
// scripts/csp.test.ts pins the entries login depends on, because a dropped
// origin doesn't fail the build — it fails sign-in, in the browser, in prod.
//
// `style-src` deliberately has no CDN entry: chessground's CSS used to be
// loaded from jsDelivr with SRI, and is now vendored into app/ instead, so
// there is one less third-party origin and no SRI hashes to re-pin on a bump.
const isProd = process.env.NODE_ENV === "production";
const SERVER_HTTP = process.env.NEXT_PUBLIC_SERVER_HTTP || "http://127.0.0.1:8080";
const SERVER_WS = process.env.NEXT_PUBLIC_SERVER_WS || "ws://127.0.0.1:8080";

const connectSrc = [
  "'self'",
  SERVER_HTTP,
  SERVER_WS,
  // wagmi default transports for Base.
  "https://mainnet.base.org",
  "https://sepolia.base.org",
  // Dynamic: the SDK API (sign-in, embedded-wallet key operations). The
  // wildcard covers their relay/telemetry subdomains, so a routine change on
  // their side doesn't take sign-in down.
  "https://app.dynamicauth.com",
  "https://*.dynamicauth.com",
  // Dynamic's asset CDN, on a SEPARATE domain from the API. The connect modal
  // fetches its wallet list from `wallet-book/v1/stable/wallet-book.json` here,
  // so without this the modal opens with no wallets in it — the API origin
  // above is not enough.
  "https://dynamic-static-assets.com",
  "https://*.dynamic-static-assets.com",
  // WalletConnect v2 relay, explorer, and analytics.
  "https://*.walletconnect.com",
  "https://*.walletconnect.org",
  "wss://*.walletconnect.com",
  "wss://*.walletconnect.org",
  // Coinbase Wallet (still offered through Dynamic's connect modal): the
  // WalletLink relay + SDK/Smart-Wallet APIs.
  "https://www.walletlink.org",
  "wss://www.walletlink.org",
  "https://*.coinbase.com",
  // MetaMask SDK's relay socket, which Dynamic's MetaMask connector uses to
  // pair with the MOBILE app. The desktop extension talks over the injected
  // provider and needs nothing, which is what makes this easy to miss: the only
  // broken case is a phone wallet, on a developer machine that has the
  // extension installed.
  "https://*.metamask.io",
  "wss://*.metamask.io",
  // Next.js dev server (HMR) talks to its own origin over ws; 'self' covers it,
  // but some setups use a distinct ws port — allow localhost ws in dev only.
  ...(isProd ? [] : ["ws://localhost:*", "http://localhost:*"]),
].join(" ");

// The in-browser Stockfish (WASM) needs 'wasm-unsafe-eval' to compile; that
// directive is exercised in dev too, so a green preview validates the prod
// policy. React Refresh (HMR) additionally needs 'unsafe-eval' — dev only.
const scriptSrc = [
  "'self'",
  // Next.js injects inline bootstrap/hydration scripts (no nonce middleware).
  // app/layout.tsx also inlines the board-theme bootstrap here, which has to run
  // before the first paint — moving to a nonce means giving that script one too,
  // or every navigation flashes the default board.
  "'unsafe-inline'",
  "'wasm-unsafe-eval'",
  ...(isProd ? [] : ["'unsafe-eval'"]),
].join(" ");

const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  `script-src ${scriptSrc}`,
  "style-src 'self' 'unsafe-inline'",
  // 'self' also covers the vendored piece SVGs under public/piece/.
  // SERVER_HTTP is the profile-photo route: covered by `https:` in production,
  // but named explicitly so the http://127.0.0.1 dev server isn't blocked and
  // the local preview exercises the same path production does.
  `img-src 'self' data: blob: https: ${SERVER_HTTP}`, // wallet + social avatars (arbitrary https)
  // Deliberately no CDN, which means Dynamic's modal renders in a fallback font
  // rather than the DM Sans it fetches from jsDelivr, and logs a handful of CSP
  // violations doing it. That's cosmetic — the modal lays out fine — and
  // re-adding jsDelivr would put back the exact third-party origin this app
  // removed when it vendored chessground's CSS.
  //
  // Worth re-weighing rather than inheriting: sign-in is no longer optional.
  // Play, Lobby, Gauntlet and Tournament are all behind it now
  // (components/SignInGate.tsx), so this modal is the front door for every
  // visitor rather than a control a few people used, and its typography is more
  // visible than it was when this call was made. Still not enough to widen a
  // money app's CSP to a public CDN by default — but if it is ever wanted, the
  // better fix is Dynamic's dashboard (set the modal's font to a system stack),
  // which costs no new origin at all.
  "font-src 'self' data:",
  "worker-src 'self' blob:", // Stockfish web worker
  // Dynamic renders its embedded-wallet key operations in an iframe on
  // app.dynamicauth.com. Google/social sign-in needs nothing here: it opens a
  // popup, which is a top-level context this policy doesn't govern. If Google
  // One Tap is ever enabled it would need accounts.google.com, and an inline
  // (non-popup) onramp would need its provider's origin.
  "frame-src 'self' https://app.dynamicauth.com https://*.walletconnect.com https://*.walletconnect.org https://keys.coinbase.com",
  `connect-src ${connectSrc}`,
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
];

// The engine is 7 MB and the books ~1 MB, and Next serves public/ with
// `max-age=0, must-revalidate` — so every cold page paid a round trip for
// each of them. Both are safe to freeze because both are addressed by a
// changing name: the engine directory carries a content hash
// (lib/engine.ts), and book requests carry a version query (lib/books.ts).
// Change the content without changing the name and clients keep the old copy
// for a year, so do not.
const immutable = [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }];

const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/engines/:path*", headers: immutable },
      { source: "/books/:path*", headers: immutable },
    ];
  },
  webpack: (config) => {
    // wagmi / Dynamic / WalletConnect pull in optional Node-only deps
    // (pino-pretty logging, @metamask/sdk's `encoding`, lokijs) that aren't
    // used in the browser. Mark them external so Next doesn't emit
    // "Module not found" warnings during the Vercel build.
    config.externals.push("pino-pretty", "lokijs", "encoding");

    // Dynamic's SDK is shared with their React Native build and imports RN
    // modules that can't resolve (or be bundled) on web. `false` in `fallback`
    // is how webpack 5 stubs a module out.
    config.resolve.fallback = {
      ...config.resolve.fallback,
      "@react-native-async-storage/async-storage": false,
      "react-native": false,
      "react-native-gesture-handler": false,
      "react-native-reanimated": false,
    };

    // Dynamic's MPC client resolves modules through a computed require, which
    // webpack can't statically analyse. The warning is upstream and not
    // actionable here; silence it so real build warnings stay visible.
    config.ignoreWarnings = [
      ...(config.ignoreWarnings || []),
      {
        module: /@dynamic-labs-wallet[\\/]forward-mpc-client/,
        message: /Critical dependency: the request of a dependency is an expression/,
      },
    ];

    return config;
  },
};

export default nextConfig;
