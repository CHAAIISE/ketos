import { defineConfig, devices } from "@playwright/test";

// Without BASE_URL, global setup starts a local NEAR sandbox and `next dev` in E2E mode on 3100
// (away from the usual dev port, which may be serving testnet).
const baseURL = process.env.BASE_URL ?? "http://localhost:3100";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: "list",
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
