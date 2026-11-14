import { z } from "zod";
import type { Market } from "../near/types";
import type { OneClickToken } from "./oneclick";

/** Same ticker rule as `list_market` in the contract. */
const SYMBOL_RE = /^[A-Z][A-Z0-9]{0,15}$/;

// Exact bindings authorized by the contract; an oracle listing alone is not eligibility.
const TEE_LISTING_ROUTES = [
  ["BTC", "nbtc.bridge.near", "nep141:btc.omft.near"],
  ["ETH", "aurora", "nep141:eth.omft.near"],
  ["NEAR", "wrap.near", "nep141:wrap.near"],
  ["ZEC", "zec.omft.near", "nep141:zec.omft.near"],
  ["SOL", "22.contract.portalbridge.near", "nep141:sol.omft.near"],
] as const;

export const WORKER_LISTING_ROUTES = {
  BTC: "nep141:btc.omft.near",
  ETH: "nep141:eth.omft.near",
  NEAR: "nep141:wrap.near",
  ZEC: "nep141:zec.omft.near",
  SOL: "nep141:sol.omft.near",
  DOGE: "nep141:doge.omft.near",
  XRP: "nep141:xrp.omft.near",
  LTC: "nep141:ltc.omft.near",
  ADA: "nep141:cardano.omft.near",
  SUI: "nep141:sui.omft.near",
  TRX: "nep141:tron.omft.near",
  BNB: "nep245:v2_1.omni.hot.tg:56_11111111111111111111",
  AVAX: "nep245:v2_1.omni.hot.tg:43114_11111111111111111",
  LINK: "nep141:eth-0x514910771af9ca656af840dff83e8264ecf986ca.omft.near",
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
 * Contract-bound sources and exact routes only. A matching ticker or an arbitrary
 * oracle/1Click pair cannot create a market that the attested signer will never price.
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
  const oracleSources = new Set(oracleAssetIds);
  const oracleIds = new Set(markets.map((m) => m.oracle_asset_id));
  const intentsIds = new Set(markets.map((m) => m.intents_asset_id));
  const tokensById = new Map(tokens.map((token) => [token.assetId, token]));
  const assets: ListableAsset[] = [];
  for (const [symbol, oracleAssetId, intentsAssetId] of TEE_LISTING_ROUTES) {
    const token = tokensById.get(intentsAssetId);
    if (!oracleSources.has(oracleAssetId) || !token || symbols.has(symbol)
      || oracleIds.has(oracleAssetId) || intentsIds.has(intentsAssetId)) continue;
    symbols.add(symbol);
    assets.push({ symbol, oracleAssetId, intentsAssetId, priceSource: "tee", referencePriceUsd: token.price });
  }
  for (const [symbol, intentsAssetId] of Object.entries(WORKER_LISTING_ROUTES)) {
    const token = tokensById.get(intentsAssetId);
    if (!workerSymbols.includes(symbol) || !token || symbols.has(symbol) || oracleIds.has(symbol) || intentsIds.has(intentsAssetId)) continue;
    symbols.add(symbol);
    assets.push({ symbol, oracleAssetId: symbol, intentsAssetId, priceSource: "outlayer_worker", referencePriceUsd: token.price });
  }
  return assets.sort((a, b) => a.symbol.localeCompare(b.symbol));
}
