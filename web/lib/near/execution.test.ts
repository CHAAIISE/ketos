import { describe, expect, it } from "vitest";
import { executionLimits } from "./execution";

describe("execution authorization", () => {
  it.each([
    ["long", false, 10_051n],
    ["short", true, 10_051n],
    ["short", false, 9_951n],
    ["long", true, 9_951n],
  ] as const)("rounds %s closing=%s inward, never widening tolerance", (side, closing, expected) => {
    expect(executionLimits(10_001n, side, closing, 50, 1_800_000_000_000)).toEqual({
      limitPrice: expected, expiresAtMs: 1_800_000_000_000,
    });
  });

  it("preserves an exact limit beyond floating-point integer precision", () => {
    const price = 9_007_199_254_740_993n;
    expect(executionLimits(price, "long", false, 0, 1_800_000_000_000).limitPrice).toBe(price);
    expect(executionLimits(price, "short", false, 0, 1_800_000_000_000).limitPrice).toBe(price);
  });
});
