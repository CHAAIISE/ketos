import { z } from "zod";
import type { Market } from "../near/types";
import { USDC_NEAR_ASSET_ID, type OneClickToken } from "./oneclick";

/** Same ticker rule as `list_market` in the contract. */
const SYMBOL_RE = /^[A-Z][A-Z0-9]{0,15}$/;

// Explicit asset identities, not price-based guesses: a depeg must not make a stablecoin listable.
const STABLECOINS: Readonly<Record<string, true>> = {
  USDC: true, USDT: true, DAI: true, FRAX: true, USDE: true, USDS: true, USDD: true,
  TUSD: true, USDP: true, BUSD: true, FDUSD: true, PYUSD: true, GUSD: true, LUSD: true,
  SUSD: true, USD0: true, USN: true, USDO: true, USDT0: true, USDBC: true,
  EURC: true, EURT: true, EURS: true, CEUR: true, CUSD: true, DUSD: true,
};
const WRAPPED_UNDERLYING: Readonly<Record<string, string>> = {
  WBTC: "BTC", BTCB: "BTC", TBTC: "BTC", CBBTC: "BTC", RENBTC: "BTC",
  WETH: "ETH", WNEAR: "NEAR", WSOL: "SOL", WAVAX: "AVAX", WBNB: "BNB",
  WMATIC: "MATIC", WPOL: "POL", WFTM: "FTM",
};

// Match the contract's retired symbols and token identities; ETH's oracle id is still "aurora".
const RETIRED_SYMBOLS: Readonly<Record<string, true>> = { AURORA: true, RHEA: true };
const RETIRED_ORACLE_IDS: Readonly<Record<string, true>> = {
  "aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near": true,
  "token.rhealab.near": true,
};

function underlying(symbol: string): string {
  return WRAPPED_UNDERLYING[symbol] ?? symbol;
}

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
 * Already-listed identities, stablecoins and wrapped duplicates of listed/candidate assets are excluded.
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
  const underlyings = new Set(markets.map((m) => underlying(m.id.toUpperCase())));
  const oracleIds = new Set(markets.map((m) => m.oracle_asset_id));
  const intentsIds = new Set(markets.map((m) => m.intents_asset_id));
  const nearTokens = new Map(tokens.filter((t) => t.blockchain === "near").map((t) => [t.assetId, t]));
  const nativeSymbols = new Set<string>();
  for (const id of oracleAssetIds) {
    const symbol = nearTokens.get(`nep141:${id}`)?.symbol.toUpperCase();
    if (symbol && !WRAPPED_UNDERLYING[symbol]) nativeSymbols.add(symbol);
  }

  const assets: ListableAsset[] = [];
  for (const oracleAssetId of new Set(oracleAssetIds)) {
    const intentsAssetId = `nep141:${oracleAssetId}`;
    const token = nearTokens.get(intentsAssetId);
    if (!token || intentsAssetId === USDC_NEAR_ASSET_ID) continue;
    const symbol = token.symbol.toUpperCase();
    if (RETIRED_SYMBOLS[symbol] || RETIRED_ORACLE_IDS[oracleAssetId]) continue;
    if (!SYMBOL_RE.test(symbol) || STABLECOINS[symbol] || symbols.has(symbol) || underlyings.has(underlying(symbol))) continue;
    // Prefer a native candidate regardless of the oracle's enumeration order.
    if (WRAPPED_UNDERLYING[symbol] && nativeSymbols.has(underlying(symbol))) continue;
    if (oracleIds.has(oracleAssetId) || intentsIds.has(intentsAssetId)) continue;
    symbols.add(symbol);
    underlyings.add(underlying(symbol));
    assets.push({ symbol, oracleAssetId, intentsAssetId, priceSource: "tee", referencePriceUsd: token.price });
  }
  for (const [symbol, intentsAssetId] of Object.entries(WORKER_LISTING_ROUTES)) {
    const token = tokens.find((token) => token.assetId === intentsAssetId);
    if (!workerSymbols.includes(symbol) || !token || symbols.has(symbol) || underlyings.has(underlying(symbol)) || oracleIds.has(symbol) || intentsIds.has(intentsAssetId)) continue;
    symbols.add(symbol);
    underlyings.add(underlying(symbol));
    assets.push({ symbol, oracleAssetId: symbol, intentsAssetId, priceSource: "outlayer_worker", referencePriceUsd: token.price });
  }
  return assets.sort((a, b) => a.symbol.localeCompare(b.symbol));
}
