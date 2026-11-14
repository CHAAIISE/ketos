// Single-owner maintenance: fast risk surveillance runs independently of depth sampling.
// Usage: pnpm keeper [--once]. No browser or HTTP invocation is needed.
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { optionalEnv, requireEnv } from "./lib/env.ts";
import { keeperChain, oneClickDepthSource } from "../web/lib/keeper/chain.ts";
import { DEPTH_INTERVAL_MS, FAST_TICK_INTERVAL_MS, runSlowTick, runTick } from "../web/lib/keeper/tick.ts";
import { KeeperPriceFeed } from "../web/lib/keeper/price-feed.ts";
import { errorMessage } from "../web/lib/utils.ts";

const webEnv = fileURLToPath(new URL("../web/.env.local", import.meta.url));
if (existsSync(webEnv)) process.loadEnvFile(webEnv);
if (optionalEnv("KEEPER_HTTP_ENABLED") === "1") throw new Error("Disable HTTP keeper execution before starting the standalone owner");

// An OS-owned loopback socket is released even on a crash; no stale PID file can
// strand launchd or let two recovering processes spend through the same signer.
const owner = createServer((socket) => socket.destroy());
const { promise: listening, resolve, reject } = Promise.withResolvers<void>();
owner.once("error", reject);
const ownerPort = Number(optionalEnv("KEEPER_LOCK_PORT") ?? "43817");
if (!Number.isInteger(ownerPort) || ownerPort < 1 || ownerPort > 65535) throw new Error("KEEPER_LOCK_PORT must be a port between 1 and 65535");
owner.listen(ownerPort, "127.0.0.1", resolve);
await listening;
const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => stop.abort());
const once = process.argv.includes("--once");
const priceFeed = once ? undefined : new KeeperPriceFeed();
const chain = await keeperChain(requireEnv("KEEPER_PRIVATE_KEY"), priceFeed);
const depth = oneClickDepthSource(optionalEnv("ONECLICK_JWT"));

async function cycle(kind: "risk" | "depth", interval: number, execute: () => Promise<unknown>) {
  let nextScheduled = Date.now();
  do {
    const started = Date.now();
    if (started >= nextScheduled) nextScheduled = started + interval;
    const revision = priceFeed?.revision ?? 0;
    try {
      const summary = await execute();
      console.log(JSON.stringify({ cycle: kind, ...summary as object }));
      if (once && summary && typeof summary === "object" && ("ok" in summary && !summary.ok || "degraded" in summary && summary.degraded)) process.exitCode = 1;
    } catch (error) {
      console.error(JSON.stringify({ cycle: kind, ok: false, startedAt: new Date(started).toISOString(), error: errorMessage(error) }));
      if (once) process.exitCode = 1;
    }
    if (once || stop.signal.aborted) break;
    try {
      const remaining = Math.max(0, nextScheduled - Date.now());
      if (kind === "risk" && priceFeed) {
        await priceFeed.waitForUpdate(revision, remaining, stop.signal);
      } else {
        await setTimeout(remaining, undefined, { signal: stop.signal });
      }
    } catch (error) {
      if (!stop.signal.aborted) throw error;
    }
  } while (!stop.signal.aborted);
}

try {
  await Promise.all([
    cycle("risk", FAST_TICK_INTERVAL_MS, () => runTick(chain, null)),
    cycle("depth", DEPTH_INTERVAL_MS, () => runSlowTick(chain, depth)),
  ]);
} finally {
  await priceFeed?.close();
  owner.close();
}
