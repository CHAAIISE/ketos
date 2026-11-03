// Local keeper: pushes 1Click depth, refreshes oracle prices and liquidates, once a minute.
// Usage: pnpm keeper [--once]. Network and contracts come from web/.env.local (NEXT_PUBLIC_*).
import { existsSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { optionalEnv, requireEnv } from "./lib/env.ts";
import { keeperChain, oneClickDepthSource } from "../web/lib/keeper/chain.ts";
import { MIN_TICK_INTERVAL_MS } from "../web/lib/keeper/throttle.ts";
import { runTick, type TickSummary } from "../web/lib/keeper/tick.ts";

const webEnv = fileURLToPath(new URL("../web/.env.local", import.meta.url));
if (existsSync(webEnv)) process.loadEnvFile(webEnv);

const once = process.argv.includes("--once");
const chain = await keeperChain(requireEnv("KEEPER_PRIVATE_KEY"));
const depth = oneClickDepthSource(optionalEnv("ONECLICK_JWT"));

function report(summary: TickSummary) {
  if (!summary.ok) {
    console.log(`${summary.startedAt} skipped: ${summary.reason}`);
    return;
  }
  console.log(`${summary.startedAt} tick in ${(summary.durationMs / 1000).toFixed(1)} s`);
  for (const d of summary.depth) console.log(`  depth ${d.market.padEnd(5)} ${"tx" in d ? d.tx : `failed: ${d.error}`}`);
  const p = summary.prices;
  console.log(`  prices ${"tx" in p ? `${p.fresh}/4 fresh, ${p.tx}` : `failed: ${p.error}`}`);
  console.log(`  ${summary.scanned} open positions scanned, ${summary.liquidations.length} liquidatable`);
  for (const l of summary.liquidations) {
    console.log(`  liquidate #${l.positionId} ${l.market} ${l.accountId} ${"tx" in l ? l.tx : `failed: ${l.error}`}`);
  }
}

for (;;) {
  const started = Date.now();
  try {
    report(await runTick(chain, depth));
  } catch (e) {
    console.error(`tick failed: ${e instanceof Error ? e.message : String(e)}`);
    if (once) process.exit(1);
  }
  if (once) break;
  await setTimeout(Math.max(0, started + MIN_TICK_INTERVAL_MS - Date.now()));
}
