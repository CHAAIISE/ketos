import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import type { FullConfig } from "@playwright/test";

// Playwright loads this file as CommonJS (web/ has no "type": "module").
const webDir = join(__dirname, "..");
const scriptsDir = join(webDir, "..", "scripts");

async function waitForServer(url: string, isAlive: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive()) throw new Error("next dev exited before serving the app");
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(500);
  }
  throw new Error(`next dev did not answer on ${url} within ${timeoutMs / 1000} s`);
}

/**
 * Local runs: starts the NEAR sandbox (contracts deployed and seeded), then `next dev` in E2E
 * mode against it. With BASE_URL set (smoke tests on a deployment) there is nothing to start.
 */
export default async function globalSetup(config: FullConfig): Promise<(() => Promise<void>) | undefined> {
  if (process.env.BASE_URL) return undefined;

  const stopSandbox = () => execFileSync(process.execPath, [join(scriptsDir, "sandbox-down.mjs")], { stdio: "inherit" });
  execFileSync(process.execPath, [join(scriptsDir, "sandbox-up.mjs")], { stdio: "inherit" });

  // Test helpers (and workers, which inherit this environment) read the sandbox accounts from here.
  process.loadEnvFile(join(webDir, ".env.e2e"));

  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error("playwright.config.ts must set use.baseURL");
  const port = new URL(baseURL).port;
  // process.env wins over web/.env.local, so the dev server talks to the sandbox only.
  const server = spawn("pnpm", ["exec", "next", "dev", "--port", port], {
    cwd: webDir,
    env: { ...process.env, NODE_ENV: "development" },
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
  let running = true;
  server.once("exit", () => (running = false));

  const teardown = async () => {
    if (running && server.pid) {
      const exited = once(server, "exit");
      process.kill(-server.pid, "SIGTERM");
      await exited;
    }
    stopSandbox();
  };

  try {
    await waitForServer(baseURL, () => running, 180_000);
  } catch (e) {
    await teardown();
    throw e;
  }
  return teardown;
}
