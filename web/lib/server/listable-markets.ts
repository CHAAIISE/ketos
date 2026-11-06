// Server-only shared snapshots: routes call these loaders directly, never through self-HTTP.
import { listableAssets, type ListableResponse } from "@/lib/intents/listing";
import { getTokens } from "@/lib/intents/oneclick";
import { nearConfig } from "@/lib/near/config";
import { KetosViews } from "@/lib/near/views";
import type { Market } from "@/lib/near/types";

const CACHE_MS = 60_000;
const TIMEOUT_MS = 8_000;
type Registry = { views: KetosViews; markets: Market[]; fetchedAtMs: number };
let registry: Registry | undefined;
let registryFlight: Promise<Registry> | undefined;
let listing: ListableResponse | undefined;
let listingFlight: Promise<ListableResponse> | undefined;

/** One cached registry snapshot per instance, shared with the listing loader. */
export function loadMarketRegistry(): Promise<Registry> {
  if (registry && Date.now() - registry.fetchedAtMs < CACHE_MS) return Promise.resolve(registry);
  if (registryFlight) return registryFlight;
  registryFlight = (async () => {
    const { rpcUrl, ketosContract, usdcContract } = nearConfig();
    const views = new KetosViews(rpcUrl, ketosContract, usdcContract);
    const markets = await views.markets();
    registry = { views, markets, fetchedAtMs: Date.now() };
    return registry;
  })().finally(() => { registryFlight = undefined; });
  return registryFlight;
}

/** A single bounded snapshot and one concurrent refresh, including on upstream failure. */
export function loadListableMarkets(): Promise<ListableResponse> {
  if (listing && Date.now() - listing.fetchedAtMs < CACHE_MS) return Promise.resolve(listing);
  if (listingFlight) return listingFlight;
  listingFlight = (async () => {
    const { views, markets, fetchedAtMs } = await loadMarketRegistry();
    const [config, tokens, workerSymbols] = await Promise.all([
      views.config(),
      getTokens({
        jwt: process.env.ONECLICK_JWT?.trim() || undefined,
        fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" }),
      }),
      views.workerAssets(),
    ]);
    const oracleAssetIds = await views.oracleAssetIds(config.oracle_id);
    listing = {
      // The registry may predate the token/oracle reads; do not relabel it as fresh.
      fetchedAtMs,
      oracleId: config.oracle_id,
      assets: listableAssets({ markets, oracleAssetIds, tokens, workerSymbols }),
    };
    return listing;
  })().finally(() => { listingFlight = undefined; });
  return listingFlight;
}
