/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
