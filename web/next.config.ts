import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The E2E server inlines sandbox addresses into the client bundle: keep its build apart.
  distDir: process.env.NEXT_PUBLIC_E2E === "1" ? ".next-e2e" : ".next",
  cacheComponents: true,
  partialPrefetching: true,
  redirects() {
    return [{ source: "/liquidity", destination: "/risk", permanent: true }];
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
