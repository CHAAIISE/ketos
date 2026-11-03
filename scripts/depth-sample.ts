// Measures exit liquidity on NEAR Intents (dry 1Click quotes into USDC on NEAR) and derives the market caps.
// Usage: pnpm depth:sample [--fixture]
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { optionalEnv } from "./lib/env.ts";
import { getTokens, ORIGIN_ASSETS, type MarketSymbol } from "../web/lib/intents/oneclick.ts";
import {
  exitCapacityUsd,
  isMarketOpen,
  maxLeverage,
  maxOiPerSide,
  sampleAsset,
  SAMPLE_SIZES_USD,
  type AssetDepth,
} from "../web/lib/intents/depth.ts";

// Mirrors DEFAULT_HARD_CAP in the perps contract.
const HARD_CAP_USD = 500_000;
const SOURCE = "1Click dry quotes (mainnet)";

const writeFixture = process.argv.includes("--fixture");
const jwt = optionalEnv("ONECLICK_JWT");

const tokens = await getTokens({ jwt });
const measuredAtMs = Date.now();
const measuredAt = new Date(measuredAtMs).toISOString();
console.log(`${SOURCE} → USDC (NEAR), ${jwt ? "partner key" : "no key"}, ${measuredAt}\n`);

const symbols = Object.keys(ORIGIN_ASSETS) as MarketSymbol[];
const depths = await Promise.all(symbols.map((symbol) => sampleAsset(ORIGIN_ASSETS[symbol], { tokens, jwt })));
const results = symbols.map((symbol, i) => ({ symbol, depth: depths[i] }));

const usd = (n: number) => (n >= 1e6 ? `$${n / 1e6}M` : n >= 1e3 ? `$${n / 1e3}k` : `$${n}`);
const col = 14;
console.log(
  "asset".padEnd(6) +
    SAMPLE_SIZES_USD.map((s) => usd(s).padStart(col)).join("") +
    "capacity".padStart(col) +
    "max lev".padStart(9) +
    "max OI".padStart(col) +
    "open".padStart(6),
);
for (const { symbol, depth } of results) {
  const capacity = exitCapacityUsd(depth.samples);
  const cells = depth.samples.map((s) => (s.impact_bps === null ? "No liquidity" : `${s.impact_bps} bps`).padStart(col)).join("");
  console.log(
    symbol.padEnd(6) +
      cells +
      usd(capacity).padStart(col) +
      `${maxLeverage(capacity)}x`.padStart(9) +
      usd(maxOiPerSide(HARD_CAP_USD, capacity)).padStart(col) +
      (isMarketOpen(capacity, measuredAtMs, measuredAtMs) ? "yes" : "no").padStart(6),
  );
}

console.log(`\nGross impact (fee of ${depths[0].fee_bps} bps included):`);
for (const { symbol, depth } of results) {
  const cells = depth.details.map((d) => (d.gross_bps === null ? "-" : `${d.gross_bps} bps`).padStart(col)).join("");
  console.log(symbol.padEnd(6) + cells);
}

const assetsRecord = (pick: (depth: AssetDepth) => object) =>
  Object.fromEntries(results.map(({ symbol, depth }) => [symbol, { asset_id: depth.asset_id, ...pick(depth) }]));

const outDir = fileURLToPath(new URL("./out/", import.meta.url));
mkdirSync(outDir, { recursive: true });
const outFile = `${outDir}depth-${measuredAt.replaceAll(":", "-")}.json`;
const full = {
  measured_at_ms: measuredAtMs,
  source: SOURCE,
  fee_bps: depths[0].fee_bps,
  hard_cap_usd: HARD_CAP_USD,
  assets: assetsRecord((depth) => {
    const capacity = exitCapacityUsd(depth.samples);
    return {
      price_usd: depth.price_usd,
      samples: depth.samples,
      details: depth.details,
      exit_capacity_usd: capacity,
      max_leverage: maxLeverage(capacity),
      max_oi_per_side_usd: maxOiPerSide(HARD_CAP_USD, capacity),
    };
  }),
};
writeFileSync(outFile, `${JSON.stringify(full, null, 2)}\n`);
console.log(`\nWrote ${outFile}`);

if (writeFixture) {
  const fixtureDir = fileURLToPath(new URL("../web/e2e/fixtures/", import.meta.url));
  mkdirSync(fixtureDir, { recursive: true });
  const fixtureFile = `${fixtureDir}depth-${measuredAt.slice(0, 10)}.json`;
  const fixture = {
    measured_at_ms: measuredAtMs,
    source: SOURCE,
    fee_bps: depths[0].fee_bps,
    assets: assetsRecord((depth) => ({ samples: depth.samples })),
  };
  writeFileSync(fixtureFile, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`Wrote ${fixtureFile}`);
}
