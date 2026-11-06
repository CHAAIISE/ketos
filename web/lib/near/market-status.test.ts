import { describe, expect, it } from "vitest";
import { MAX_DEPTH_AGE_MS } from "../intents/depth";
import { isPriceFresh, marketStatus } from "./market-status";
import { MAX_PRICE_AGE_MS, type Market } from "./types";

const NOW = 1_800_000_000_000;
const market = {
  price: 400_000_000n,
  price_timestamp_ms: NOW,
  depth_measured_at_ms: NOW,
  exit_capacity: 10_000_000_000n,
  is_open: true,
} as Market;

describe("snapshot freshness", () => {
  it("accepts the exact price age limit but rejects an older, missing or future observation", () => {
    expect(isPriceFresh({ ...market, price_timestamp_ms: NOW - MAX_PRICE_AGE_MS }, NOW)).toBe(true);
    expect(isPriceFresh({ ...market, price_timestamp_ms: NOW - MAX_PRICE_AGE_MS - 1 }, NOW)).toBe(false);
    for (const price_timestamp_ms of [0, -1, NOW + 1, Number.NaN]) {
      expect(isPriceFresh({ ...market, price_timestamp_ms }, NOW)).toBe(false);
    }
    expect(isPriceFresh({ ...market, price: 0n }, NOW)).toBe(false);
  });

  it("does not decide age before the browser clock hydrates, but still requires a valid observation", () => {
    expect(isPriceFresh(market, 0)).toBe(true);
    expect(isPriceFresh({ ...market, price_timestamp_ms: 0 }, 0)).toBe(false);
  });

  it("admits the depth age and capacity boundaries, never a future or missing measurement", () => {
    expect(marketStatus({ ...market, depth_measured_at_ms: NOW - MAX_DEPTH_AGE_MS }, NOW)).toEqual({ open: true });
    expect(marketStatus({ ...market, depth_measured_at_ms: NOW - MAX_DEPTH_AGE_MS - 1 }, NOW).open).toBe(false);
    expect(marketStatus({ ...market, exit_capacity: market.exit_capacity - 1n }, NOW).open).toBe(false);
    expect(marketStatus({ ...market, depth_measured_at_ms: NOW + 1 }, NOW).open).toBe(false);
    expect(marketStatus({ ...market, depth_measured_at_ms: 0 }, NOW).open).toBe(false);
    expect(marketStatus({ ...market, is_open: false }, NOW).open).toBe(false);
  });
});
