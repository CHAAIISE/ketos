import { afterEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_SIZES_USD } from "../intents/depth";
import noLiquidity from "../intents/fixtures/quote-no-liquidity.json";
import quoteOk from "../intents/fixtures/quote-ok.json";
import type { FetchImpl } from "../intents/oneclick";
import type { Market } from "../near/types";
import { oneClickDepthSource } from "./chain";

function market(index: number): Market {
  return {
    id: `ASSET${index}`,
    oracle_asset_id: `asset${index}`,
    intents_asset_id: `nep141:asset${index}.near`,
    price_source: "tee",
    vault_id: "core",
    fee_bps: 10,
    max_leverage_cap: 20,
    hard_cap: 500_000_000_000n,
    exit_capacity: 0n,
    depth_measured_at_ms: 0,
    oi_long: 0n,
    oi_short: 0n,
    max_leverage: 2,
    price: 100_000_000n,
    price_timestamp_ms: 0,
    borrow_index_long: 0n,
    borrow_index_short: 0n,
    last_accrual_ms: 0,
    funding: { paid_index: [0n, 0n], received_index: [0n, 0n], last_accrual_ms: 0 },
    max_oi_per_side: 0n,
    vault_backed_cap_usd: 0n,
    effective_max_oi_per_side: 0n,
    measured_cap_is_grid_max: false,
    close_only: false,
    is_open: false,
    isolated_only: false, launch_state: null,
    funding_rate_per_hour: 0n,
  };
}

function tokenList(markets: readonly Market[]) {
  return markets.map((m) => ({ assetId: m.intents_asset_id, decimals: 6, price: 1, symbol: m.id, blockchain: "near" }));
}

function quoteResponse(sizeUsd: number) {
  return Response.json({
    ...quoteOk,
    quote: { ...quoteOk.quote, amountInUsd: String(sizeUsd), amountOutUsd: String(sizeUsd * 0.985) },
  }, { status: 201 });
}

function gate() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, release: resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("1Click keeper depth source", () => {
  it.each([0, 1, 6, 7, 15])("samples all %i markets with at most six simultaneous asset samplers", async (count) => {
    const markets = Array.from({ length: count }, (_, index) => market(index));
    const gates = new Map(markets.map((m) => [m.intents_asset_id, gate()]));
    const started: string[] = [];
    const activeAssets = new Set<string>();
    const inFlight = new Set<string>();
    const sizesByAsset = new Map<string, number[]>();
    let maxActive = 0;
    let overlappingAssetRequests = false;
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchImpl = vi.fn<FetchImpl>(async (url, init) => {
      if (String(url).endsWith("/tokens")) return Response.json(tokenList(markets));
      const { originAsset, amount } = JSON.parse(String(init?.body)) as { originAsset: string; amount: string };
      const sizeUsd = Number(amount) / 1_000_000;
      if (inFlight.has(originAsset)) overlappingAssetRequests = true;
      inFlight.add(originAsset);
      const sizes = sizesByAsset.get(originAsset) ?? [];
      sizes.push(sizeUsd);
      sizesByAsset.set(originAsset, sizes);
      if (sizeUsd === 1_000) {
        started.push(originAsset);
        activeAssets.add(originAsset);
        maxActive = Math.max(maxActive, activeAssets.size);
      }
      try {
        await gates.get(originAsset)!.promise;
        if (sizeUsd === 1_000_000) activeAssets.delete(originAsset);
        return quoteResponse(sizeUsd);
      } finally {
        inFlight.delete(originAsset);
      }
    });
    vi.stubGlobal("fetch", fetchImpl);
    const pending = oneClickDepthSource(undefined).sample(markets);
    const slots = Math.min(6, count);
    await vi.waitFor(() => expect(started).toEqual(markets.slice(0, slots).map((m) => m.intents_asset_id)));
    expect(maxActive).toBe(slots);
    if (count > 6) {
      now += 1_000;
      gates.get(markets[5].intents_asset_id)!.release();
      await vi.waitFor(() => expect(started).toHaveLength(7));
      expect(started[6]).toBe(markets[6].intents_asset_id);
      expect(activeAssets.has(markets[0].intents_asset_id)).toBe(true);
      expect(maxActive).toBe(6);
    }
    now += 1_000;
    for (const held of gates.values()) held.release();
    const results = await pending;
    expect(results.map((r) => r.market)).toEqual(markets.map((m) => m.id));
    expect(overlappingAssetRequests).toBe(false);
    expect(maxActive).toBe(slots);
    expect(activeAssets.size).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1 + count * SAMPLE_SIZES_USD.length);
    for (const [index, result] of results.entries()) {
      expect(sizesByAsset.get(markets[index].intents_asset_id)).toEqual(SAMPLE_SIZES_USD);
      expect(result).toEqual({
        market: markets[index].id,
        samples: SAMPLE_SIZES_USD.map((size_usd) => ({ size_usd, impact_bps: 125 })),
        measuredAtMs: index < 6 ? 1_800_000_000_000 : index === 6 ? 1_800_000_001_000 : now,
      });
    }
  });

  it("isolates exhausted errors, retries real missing quotes, and still covers later markets", async () => {
    const markets = Array.from({ length: 9 }, (_, index) => market(index));
    const attempts = new Map<string, number>();
    const fetchImpl = vi.fn<FetchImpl>(async (url, init) => {
      if (String(url).endsWith("/tokens")) return Response.json(tokenList(markets.filter((_, index) => index !== 3)));
      const { originAsset, amount } = JSON.parse(String(init?.body)) as { originAsset: string; amount: string };
      const attempt = (attempts.get(originAsset) ?? 0) + 1;
      attempts.set(originAsset, attempt);
      if (originAsset === markets[0].intents_asset_id) throw new Error("connection reset");
      if (originAsset === markets[2].intents_asset_id) return Response.json({ message: "Unavailable" }, { status: 503 });
      if (originAsset === markets[1].intents_asset_id || (originAsset === markets[4].intents_asset_id && attempt === 1)) {
        return Response.json(noLiquidity, { status: 400 });
      }
      return quoteResponse(Number(amount) / 1_000_000);
    });
    vi.stubGlobal("fetch", fetchImpl);
    const results = await oneClickDepthSource(undefined).sample(markets);
    expect(results.map((r) => r.market)).toEqual(markets.map((m) => m.id));
    expect(results[0]).toEqual({ market: markets[0].id, error: expect.stringMatching(/request.*failed/) });
    expect(results[2]).toEqual({ market: markets[2].id, error: expect.stringMatching(/HTTP 503: Unavailable/) });
    expect(results[3]).toEqual({ market: markets[3].id, error: expect.stringMatching(/not listed/) });
    expect(results[1]).toMatchObject({ samples: SAMPLE_SIZES_USD.map((size_usd) => ({ size_usd, impact_bps: null })) });
    for (const result of results.slice(4)) {
      expect(result).toMatchObject({ samples: SAMPLE_SIZES_USD.map((size_usd) => ({ size_usd, impact_bps: 125 })) });
    }
    expect(markets.map((m) => attempts.get(m.intents_asset_id) ?? 0)).toEqual([2, 14, 2, 0, 8, 7, 7, 7, 7]);
  });

  it("returns an explicit token-list error for every market without issuing quotes", async () => {
    const markets = Array.from({ length: 11 }, (_, index) => market(index));
    const fetchImpl = vi.fn<FetchImpl>(async () => Response.json({ message: "Unavailable" }, { status: 503 }));
    vi.stubGlobal("fetch", fetchImpl);
    expect(await oneClickDepthSource(undefined).sample(markets)).toEqual(markets.map((m) => ({
      market: m.id,
      error: "1Click token list unavailable: GET /tokens returned HTTP 503",
    })));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
