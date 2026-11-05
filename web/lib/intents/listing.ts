import { z } from "zod";
import type { Market } from "@/lib/near/types";
import { USDC_NEAR_ASSET_ID, type OneClickToken } from "./oneclick";

/** Same ticker rule as `list_market` in the contract. */
const SYMBOL_RE = /^[A-Z][A-Z0-9]{0,15}$/;

export const WORKER_LISTING_ROUTES = {
  UNI: "nep141:eth-0x1f9840a85d5af5bf1d1762f925bdaddc4201f984.omft.near",
  AAVE: "nep141:eth-0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9.omft.near",
  BCH: "nep141:bch.omft.near",
  APT: "nep141:aptos.omft.near",
  ARB: "nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near",
} as const;

export const listableAssetSchema = z.object({
  symbol: z.string().regex(SYMBOL_RE),
  oracleAssetId: z.string(),
  /** `nep141:<token>` id quoted by 1Click, used to measure exit liquidity. */
  intentsAssetId: z.string(),
  priceSource: z.enum(["tee", "outlayer_worker"]),
  /** 1Click's own USD reference price, for orientation only; the market uses the oracle. */
  referencePriceUsd: z.number(),
});
export type ListableAsset = z.infer<typeof listableAssetSchema>;

export const listableResponseSchema = z.object({
  fetchedAtMs: z.number(),
  oracleId: z.string(),
  assets: z.array(listableAssetSchema),
});
export type ListableResponse = z.infer<typeof listableResponseSchema>;

/**
 * Assets with an oracle or pinned-worker price source and a matching NEAR Intents route.
 * Already-listed tickers, oracle ids and Intents ids and the USDC collateral are excluded.
 */
export function listableAssets({
  markets,
  oracleAssetIds,
  tokens,
  workerSymbols = [],
}: {
  markets: readonly Pick<Market, "id" | "oracle_asset_id" | "intents_asset_id">[];
  oracleAssetIds: readonly string[];
  tokens: readonly OneClickToken[];
  workerSymbols?: readonly string[];
}): ListableAsset[] {
  const symbols = new Set(markets.map((m) => m.id));
  const oracleIds = new Set(markets.map((m) => m.oracle_asset_id));
  const intentsIds = new Set(markets.map((m) => m.intents_asset_id));
  const nearTokens = new Map(tokens.filter((t) => t.blockchain === "near").map((t) => [t.assetId, t]));

  const assets: ListableAsset[] = [];
  for (const oracleAssetId of new Set(oracleAssetIds)) {
    const intentsAssetId = `nep141:${oracleAssetId}`;
    const token = nearTokens.get(intentsAssetId);
    if (!token || intentsAssetId === USDC_NEAR_ASSET_ID) continue;
    const symbol = token.symbol.toUpperCase();
    if (!SYMBOL_RE.test(symbol) || symbols.has(symbol)) continue;
    if (oracleIds.has(oracleAssetId) || intentsIds.has(intentsAssetId)) continue;
    symbols.add(symbol);
    assets.push({ symbol, oracleAssetId, intentsAssetId, priceSource: "tee", referencePriceUsd: token.price });
  }
  for (const [symbol, intentsAssetId] of Object.entries(WORKER_LISTING_ROUTES)) {
    const token = tokens.find((token) => token.assetId === intentsAssetId);
    if (!workerSymbols.includes(symbol) || !token || symbols.has(symbol) || oracleIds.has(symbol) || intentsIds.has(intentsAssetId)) continue;
    assets.push({ symbol, oracleAssetId: symbol, intentsAssetId, priceSource: "outlayer_worker", referencePriceUsd: token.price });
  }
  return assets.sort((a, b) => a.symbol.localeCompare(b.symbol));
}
