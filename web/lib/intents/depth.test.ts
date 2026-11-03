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

    expect(fetchImpl).toHaveBeenCalledTimes(SAMPLE_SIZES_USD.length);
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
    const fetchImpl = fakeOneClick(new Map(SAMPLE_SIZES_USD.map((s) => [s, 120])));
    const depth = await sampleAsset(ORIGIN_ASSETS.NEAR, { tokens, fetchImpl });
    expect(depth.fee_bps).toBe(25);
    expect(depth.samples.every((s) => s.impact_bps === 95)).toBe(true);
    expect(exitCapacityUsd(depth.samples)).toBe(1_000_000);
  });

  it("fails for an asset 1Click does not list", async () => {
    await expect(sampleAsset("nep141:unknown.near", { tokens, fetchImpl: fakeOneClick(new Map()) })).rejects.toThrow(/not listed/);
  });
});
