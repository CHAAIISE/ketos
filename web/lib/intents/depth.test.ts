import { describe, expect, it, vi } from "vitest";
import noLiquidity from "./fixtures/quote-no-liquidity.json";
import quoteOk from "./fixtures/quote-ok.json";
import tokens from "./fixtures/tokens.json";
import {
  exitCapacityUsd,
  isMarketOpen,
  MAX_DEPTH_AGE_MS,
  maxLeverage,
  maxOiPerSide,
  sampleAsset,
  SAMPLE_SIZES_USD,
  usdToBaseUnits,
  type DepthSample,
} from "./depth";
import { ORIGIN_ASSETS, type FetchImpl } from "./oneclick";

const curve = (impacts: (number | null)[]): DepthSample[] =>
  impacts.map((impact_bps, i) => ({ size_usd: SAMPLE_SIZES_USD[i], impact_bps }));

describe("usdToBaseUnits", () => {
  it("converts USD to base units with integer precision for 24-decimal tokens", () => {
    expect(usdToBaseUnits(1_000, 4, 24)).toBe("250000000000000000000000000");
    expect(usdToBaseUnits(1_000_000, 4, 24)).toBe("250000000000000000000000000000");
  });

  it("rounds down for 8-decimal tokens", () => {
    expect(usdToBaseUnits(1_000, 77_561.5, 8)).toBe("1289299");
  });
});

describe("exitCapacityUsd", () => {
  it("returns the largest size when the whole curve is within 100 bps", () => {
    expect(exitCapacityUsd(curve([0, 0, 5, 20, 60, 90, 100]))).toBe(1_000_000);
  });

  it("stops at the first size without liquidity even if a larger size quotes", () => {
    expect(exitCapacityUsd(curve([0, 0, 0, 0, null, 10, null]))).toBe(100_000);
  });

  it("stops at the first size above 100 bps even if a larger size is cheaper", () => {
    expect(exitCapacityUsd(curve([0, 40, 101, 50, 50, 50, 50]))).toBe(10_000);
  });

  it("orders samples by size before scanning", () => {
    const shuffled = curve([0, 0, 0, null, null, null, null]).reverse();
    expect(exitCapacityUsd(shuffled)).toBe(50_000);
  });

  it("is zero when the smallest size already fails", () => {
    expect(exitCapacityUsd(curve([null, 0, 0, 0, 0, 0, 0]))).toBe(0);
    expect(exitCapacityUsd(curve([150, 0, 0, 0, 0, 0, 0]))).toBe(0);
    expect(exitCapacityUsd([])).toBe(0);
  });
});

describe("maxLeverage", () => {
  it("applies the capacity tiers at their exact boundaries", () => {
    expect(maxLeverage(0)).toBe(2);
    expect(maxLeverage(49_999)).toBe(2);
    expect(maxLeverage(50_000)).toBe(5);
    expect(maxLeverage(249_999)).toBe(5);
    expect(maxLeverage(250_000)).toBe(10);
    expect(maxLeverage(999_999)).toBe(10);
    expect(maxLeverage(1_000_000)).toBe(20);
  });
});

describe("isMarketOpen", () => {
  const now = 1_800_000_000_000;

  it("is open with enough capacity and a fresh measurement", () => {
    expect(isMarketOpen(10_000, now, now)).toBe(true);
    expect(isMarketOpen(100_000, now - MAX_DEPTH_AGE_MS, now)).toBe(true);
  });

  it("closes below 10k of exit capacity", () => {
    expect(isMarketOpen(9_999, now, now)).toBe(false);
    expect(isMarketOpen(0, now, now)).toBe(false);
  });

  it("closes once the measurement is older than 30 minutes", () => {
    expect(isMarketOpen(1_000_000, now - MAX_DEPTH_AGE_MS - 1, now)).toBe(false);
  });
});

describe("maxOiPerSide", () => {
  it("is the lower of the hard cap and the exit capacity", () => {
    expect(maxOiPerSide(500_000, 100_000)).toBe(100_000);
    expect(maxOiPerSide(500_000, 1_000_000)).toBe(500_000);
    expect(maxOiPerSide(500_000, 0)).toBe(0);
  });
});

describe("sampleAsset", () => {
  // Answers like 1Click: a fixed gross impact up to 100k USD, no liquidity above.
  function fakeOneClick(grossBpsBySize: Map<number, number>) {
    const near = tokens.find((t) => t.assetId === ORIGIN_ASSETS.NEAR)!;
    return vi.fn<FetchImpl>(async (_url, init) => {
      const { amount } = JSON.parse(String(init?.body)) as { amount: string };
      const sizeUsd = Math.round((Number(amount) / 10 ** near.decimals) * near.price);
      const gross = grossBpsBySize.get(sizeUsd);
      if (gross === undefined) return new Response(JSON.stringify(noLiquidity), { status: 400 });
      const amountOutUsd = (sizeUsd * (1 - gross / 10_000)).toString();
      const body = { ...quoteOk, quote: { ...quoteOk.quote, amountInUsd: String(sizeUsd), amountOutUsd } };
      return new Response(JSON.stringify(body), { status: 201 });
    });
  }

  it("quotes every size in order and reports net impact, nulls and capacity", async () => {
    const fetchImpl = fakeOneClick(new Map([[1_000, 10], [10_000, 15], [50_000, 40], [100_000, 130]]));
    const depth = await sampleAsset(ORIGIN_ASSETS.NEAR, { tokens, jwt: "partner-key", fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(SAMPLE_SIZES_USD.length + 3);
    expect(fetchImpl.mock.calls.map(([, init]) => {
      const near = tokens.find((t) => t.assetId === ORIGIN_ASSETS.NEAR)!;
      const { amount } = JSON.parse(String(init?.body)) as { amount: string };
      return Math.round((Number(amount) / 10 ** near.decimals) * near.price);
    })).toEqual([1_000, 10_000, 50_000, 100_000, 250_000, 250_000, 500_000, 500_000, 1_000_000, 1_000_000]);
    expect(depth.fee_bps).toBe(20);
    expect(depth.samples).toEqual([
      { size_usd: 1_000, impact_bps: 0 },
      { size_usd: 10_000, impact_bps: 0 },
      { size_usd: 50_000, impact_bps: 20 },
      { size_usd: 100_000, impact_bps: 110 },
      { size_usd: 250_000, impact_bps: null },
      { size_usd: 500_000, impact_bps: null },
      { size_usd: 1_000_000, impact_bps: null },
    ]);
    expect(depth.details[2]).toMatchObject({ gross_bps: 40, amount_in_usd: 50_000 });
    expect(depth.details[4]).toMatchObject({ gross_bps: null, amount_in_usd: null });
    expect(exitCapacityUsd(depth.samples)).toBe(50_000);
  });

  it("subtracts the higher public fee without a key", async () => {
    const sizes = [...SAMPLE_SIZES_USD, 2_500_000, 5_000_000];
    const fetchImpl = fakeOneClick(new Map(sizes.map((s) => [s, 120])));
    const depth = await sampleAsset(ORIGIN_ASSETS.NEAR, { tokens, fetchImpl });
    expect(depth.fee_bps).toBe(25);
    expect(depth.samples.every((s) => s.impact_bps === 95)).toBe(true);
    expect(depth.samples.map((s) => s.size_usd)).toEqual(sizes);
    expect(exitCapacityUsd(depth.samples)).toBe(5_000_000);
  });

  it("publishes a conservative envelope while preserving raw quotes and missing sizes", async () => {
    const fetchImpl = fakeOneClick(new Map([[1_000, 50], [10_000, 30], [100_000, 40], [250_000, 80]]));
    const depth = await sampleAsset(ORIGIN_ASSETS.NEAR, { tokens, jwt: "partner-key", fetchImpl });
    expect(depth.samples.map((s) => s.impact_bps)).toEqual([30, 30, null, 30, 60, null, null]);
    expect(depth.details.map((s) => s.impact_bps)).toEqual([30, 10, null, 20, 60, null, null]);
    expect(exitCapacityUsd(depth.samples)).toBe(10_000);
  });

  it("retries no-liquidity once and keeps the recovered quote's raw amounts", async () => {
    const fetchImpl = fakeOneClick(new Map([[1_000, 60], [10_000, 80]]))
      .mockResolvedValueOnce(new Response(JSON.stringify(noLiquidity), { status: 400 }));
    const depth = await sampleAsset(ORIGIN_ASSETS.NEAR, { tokens, fetchImpl, sizesUsd: [1_000, 10_000] });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(depth.samples).toEqual([{ size_usd: 1_000, impact_bps: 35 }, { size_usd: 10_000, impact_bps: 55 }]);
    expect(depth.details[0]).toEqual({
      size_usd: 1_000,
      impact_bps: 35,
      amount_in: usdToBaseUnits(1_000, tokens[0].price, tokens[0].decimals),
      gross_bps: 60,
      amount_in_usd: 1_000,
      amount_out_usd: 994,
    });
  });

  it.each(["http", "network", "malformed"])("recovers from one %s quote failure without adding a sample", async (failure) => {
    const fetchImpl = fakeOneClick(new Map([[1_000, 60]]));
    if (failure === "network") fetchImpl.mockRejectedValueOnce(new Error("connection reset"));
    else fetchImpl.mockResolvedValueOnce(failure === "http"
      ? new Response(JSON.stringify({ message: "Unavailable" }), { status: 503 })
      : new Response(JSON.stringify({ quote: {} }), { status: 201 }));
    const depth = await sampleAsset(ORIGIN_ASSETS.NEAR, { tokens, fetchImpl, sizesUsd: [1_000] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(depth.samples).toEqual([{ size_usd: 1_000, impact_bps: 35 }]);
    expect(depth.details).toHaveLength(1);
  });

  it("gives every size its own retry instead of sharing one retry across the curve", async () => {
    const fetchImpl = fakeOneClick(new Map([[1_000, 60], [10_000, 80]]));
    const quote = fetchImpl.getMockImplementation()!;
    const attempts = new Map<string, number>();
    fetchImpl.mockImplementation(async (url, init) => {
      const { amount } = JSON.parse(String(init?.body)) as { amount: string };
      const attempt = (attempts.get(amount) ?? 0) + 1;
      attempts.set(amount, attempt);
      if (attempt === 1) return new Response(JSON.stringify(noLiquidity), { status: 400 });
      return quote(url, init);
    });
    const depth = await sampleAsset(ORIGIN_ASSETS.NEAR, { tokens, fetchImpl, sizesUsd: [1_000, 10_000] });
    expect([...attempts.values()]).toEqual([2, 2]);
    expect(depth.samples.map((s) => s.impact_bps)).toEqual([35, 55]);
  });

  it.each(["http", "network", "malformed", "no-liquidity-then-error"])(
    "rejects exhausted %s failures instead of returning a false null curve",
    async (failure) => {
      const fetchImpl = vi.fn<FetchImpl>(async () => {
        if (failure === "network") throw new Error("connection reset");
        if (failure === "malformed") return new Response(JSON.stringify({ quote: {} }), { status: 201 });
        return new Response(JSON.stringify({ message: "Unavailable" }), { status: 503 });
      });
      if (failure === "no-liquidity-then-error") {
        fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify(noLiquidity), { status: 400 }));
      }
      const error = failure === "network" ? /request.*failed/ : failure === "malformed" ? /unexpected body/ : /HTTP 503: Unavailable/;
      await expect(sampleAsset(ORIGIN_ASSETS.NEAR, { tokens, fetchImpl, sizesUsd: [1_000, 10_000] })).rejects.toThrow(error);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );

  it.each([100, 101])("extends only a complete default grid whose 1M impact is at most 100 bps (%i)", async (impact) => {
    const sizes = [...SAMPLE_SIZES_USD, 2_500_000, 5_000_000];
    const fetchImpl = fakeOneClick(new Map(sizes.map((size) => [size, size === 1_000_000 ? impact + 25 : 25])));
    const depth = await sampleAsset(ORIGIN_ASSETS.NEAR, { tokens, fetchImpl });
    expect(depth.samples.map((s) => s.size_usd)).toEqual(impact === 100 ? sizes : SAMPLE_SIZES_USD);
    expect(fetchImpl).toHaveBeenCalledTimes(impact === 100 ? sizes.length : SAMPLE_SIZES_USD.length);
    expect(exitCapacityUsd(depth.samples)).toBe(impact === 100 ? 5_000_000 : 500_000);
    if (impact === 100) {
      expect(depth.samples.slice(-2).map((s) => s.impact_bps)).toEqual([100, 100]);
      expect(depth.details.slice(-2).map((s) => s.impact_bps)).toEqual([0, 0]);
    }
  });

  it.each(["missing", "expensive"])("does not extend across a smaller %s size even when 1M quotes cheaply", async (failure) => {
    const quotes = new Map<number, number>(SAMPLE_SIZES_USD.map((s) => [s, 25]));
    if (failure === "missing") quotes.delete(50_000);
    else quotes.set(50_000, 126);
    const fetchImpl = fakeOneClick(quotes);
    const depth = await sampleAsset(ORIGIN_ASSETS.NEAR, { tokens, fetchImpl });
    expect(depth.samples.map((s) => s.size_usd)).toEqual(SAMPLE_SIZES_USD);
    expect(exitCapacityUsd(depth.samples)).toBe(10_000);
  });

  it("probes both extension sizes even if 2.5M has no liquidity", async () => {
    const fetchImpl = fakeOneClick(new Map([...SAMPLE_SIZES_USD, 5_000_000].map((s) => [s, 25])));
    const depth = await sampleAsset(ORIGIN_ASSETS.NEAR, { tokens, fetchImpl });
    expect(depth.samples.slice(-2)).toEqual([
      { size_usd: 2_500_000, impact_bps: null },
      { size_usd: 5_000_000, impact_bps: 0 },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(SAMPLE_SIZES_USD.length + 3);
    expect(exitCapacityUsd(depth.samples)).toBe(1_000_000);
  });

  it("fails the whole curve if extension errors exhaust their retry", async () => {
    const fetchImpl = fakeOneClick(new Map(SAMPLE_SIZES_USD.map((s) => [s, 25])));
    const quote = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementation(async (url, init) => {
      const { amount } = JSON.parse(String(init?.body)) as { amount: string };
      if (amount === usdToBaseUnits(2_500_000, tokens[0].price, tokens[0].decimals)) {
        return new Response(JSON.stringify({ message: "Unavailable" }), { status: 503 });
      }
      return quote(url, init);
    });
    await expect(sampleAsset(ORIGIN_ASSETS.NEAR, { tokens, fetchImpl })).rejects.toThrow(/HTTP 503/);
    expect(fetchImpl).toHaveBeenCalledTimes(SAMPLE_SIZES_USD.length + 2);
  });

  it.each([
    { sizesUsd: [...SAMPLE_SIZES_USD] },
    { sizesUsd: [5_000, 1_000_000, 2_000_000] },
    { sizesUsd: [] },
  ])("preserves explicitly supplied size grids without automatic extension: $sizesUsd", async ({ sizesUsd }) => {
    const fetchImpl = fakeOneClick(new Map(sizesUsd.map((s) => [s, 25])));
    const depth = await sampleAsset(ORIGIN_ASSETS.NEAR, { tokens, fetchImpl, sizesUsd });
    expect(depth.samples.map((s) => s.size_usd)).toEqual(sizesUsd);
    expect(depth.details.map((s) => s.size_usd)).toEqual(sizesUsd);
    expect(fetchImpl).toHaveBeenCalledTimes(sizesUsd.length);
  });

  it("fails for an asset 1Click does not list", async () => {
    await expect(sampleAsset("nep141:unknown.near", { tokens, fetchImpl: fakeOneClick(new Map()) })).rejects.toThrow(/not listed/);
  });
});
