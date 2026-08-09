/** @type {import('next').NextConfig} */

// --- Security headers -------------------------------------------------------
// This is a wallet-signing money app, so it ships a Content-Security-Policy and
// the standard hardening headers. The CSP is scoped to exactly the origins the
// app talks to: the game server (env), Base's default RPCs (wagmi/RainbowKit),
// and WalletConnect's relay/explorer. `frame-ancestors 'none'` +
// X-Frame-Options block clickjacking of the Deposit/Withdraw and Finish-sign-in
// buttons.
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
  // wagmi/RainbowKit default transports for Base + ENS reads.
  "https://mainnet.base.org",
  "https://sepolia.base.org",
  // WalletConnect v2 relay, explorer, and analytics.
  "https://*.walletconnect.com",
  "https://*.walletconnect.org",
  "wss://*.walletconnect.com",
  "wss://*.walletconnect.org",
  // Coinbase Wallet (a RainbowKit getDefaultConfig default connector): the
  // WalletLink relay + SDK/Smart-Wallet APIs.
  "https://www.walletlink.org",
  "wss://www.walletlink.org",
  "https://*.coinbase.com",
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
  `img-src 'self' data: blob: https: ${SERVER_HTTP}`, // ENS/wallet avatars (IPFS gateways, arbitrary https)
  "font-src 'self' data:",
  "worker-src 'self' blob:", // Stockfish web worker
  "frame-src 'self' https://*.walletconnect.com https://*.walletconnect.org https://keys.coinbase.com",
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

const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  webpack: (config) => {
    // wagmi / RainbowKit / WalletConnect pull in optional Node-only deps
    // (pino-pretty logging, @metamask/sdk's `encoding`, lokijs) that aren't
    // used in the browser. Mark them external so Next doesn't emit
    // "Module not found" warnings during the Vercel build.
    config.externals.push("pino-pretty", "lokijs", "encoding");
    return config;
  },
};

export default nextConfig;
