// Local keeper: measures exit depth and maintains prices, orders, margin, funding and vault history.
// Usage: pnpm keeper [--once]. Network and contracts come from web/.env.local (NEXT_PUBLIC_*).
import { existsSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { optionalEnv, requireEnv } from "./lib/env.ts";
import { keeperChain, oneClickDepthSource } from "../web/lib/keeper/chain.ts";
import { MIN_TICK_INTERVAL_MS } from "../web/lib/keeper/throttle.ts";
import { runTick } from "../web/lib/keeper/tick.ts";
import { errorMessage } from "../web/lib/utils.ts";

const webEnv = fileURLToPath(new URL("../web/.env.local", import.meta.url));
if (existsSync(webEnv)) process.loadEnvFile(webEnv);

const once = process.argv.includes("--once");
const chain = await keeperChain(requireEnv("KEEPER_PRIVATE_KEY"));
const depth = oneClickDepthSource(optionalEnv("ONECLICK_JWT"));

for (;;) {
  const started = Date.now();
  try {
    const summary = await runTick(chain, depth);
    console.log(JSON.stringify(summary));
    if (once && !summary.ok) process.exitCode = 1;
  } catch (e) {
    console.error(`tick failed: ${errorMessage(e)}`);
    if (once) process.exit(1);
  }
  if (once) break;
  await setTimeout(Math.max(0, started + MIN_TICK_INTERVAL_MS - Date.now()));
}
