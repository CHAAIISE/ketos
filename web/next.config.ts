import type { NextConfig } from "next";

const isDevelopment = process.env.NODE_ENV === "development";
// Wallet executors run in sandboxed srcdoc frames and load modules from wallet-owned HTTPS hosts.
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' https: 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' https: 'unsafe-inline'",
  "img-src 'self' https: data: blob:",
  "font-src 'self' https: data:",
  `connect-src 'self' https: wss:${isDevelopment ? " http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*" : ""}`,
  "frame-src 'self' https:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https:",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  // The E2E server inlines sandbox addresses into the client bundle: keep its build apart.
  distDir: process.env.NEXT_PUBLIC_E2E === "1" ? ".next-e2e" : ".next",
  cacheComponents: true,
  partialPrefetching: true,
  redirects() {
    return [
      { source: "/liquidity", destination: "/risk", permanent: true },
      { source: "/vaults/longtail", destination: "/vaults/long-tail", permanent: true },
    ];
  },
  headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: contentSecurityPolicy },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      ],
    }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
