import { z } from "zod";
import type { Market } from "@/lib/near/types";
import { USDC_NEAR_ASSET_ID, type OneClickToken } from "./oneclick";

/** Same ticker rule as `list_market` in the contract. */
const SYMBOL_RE = /^[A-Z][A-Z0-9]{0,15}$/;

export const listableAssetSchema = z.object({
  symbol: z.string().regex(SYMBOL_RE),
  oracleAssetId: z.string(),
  /** `nep141:<token>` id quoted by 1Click, used to measure exit liquidity. */
  intentsAssetId: z.string(),
  priceSource: z.literal("tee"),
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
 * Assets anyone can list now: supported by the price oracle, quoted by NEAR Intents as the same
 * NEP-141 token on NEAR, and not yet in the registry (by ticker, oracle id or Intents id). The
 * USDC collateral itself is excluded since its exit route would be USDC to USDC.
 */
export function listableAssets({
  markets,
  oracleAssetIds,
  tokens,
}: {
  markets: readonly Pick<Market, "id" | "oracle_asset_id" | "intents_asset_id">[];
  oracleAssetIds: readonly string[];
  tokens: readonly OneClickToken[];
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
  return assets.sort((a, b) => a.symbol.localeCompare(b.symbol));
}
