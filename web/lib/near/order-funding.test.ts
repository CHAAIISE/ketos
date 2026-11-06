import { describe, expect, it } from "vitest";
import { entryFundingRequired, maxEntryMargin } from "./order-funding";

const USD = 1_000_000n;

describe("entry collateral budget", () => {
  it("reserves each minimum keeper reward before sizing Max", () => {
    expect(maxEntryMargin(USD, 2, 3)).toBe(700_000n);
    expect(maxEntryMargin(200_000n, 2, 3)).toBe(0n);
  });

  it("fits one micro-USDC below the next rounded reward, without overspending", () => {
    for (const balance of [300_001n, 100n * USD, 1_000n * USD + 1n]) {
      for (const slots of [0, 1, 2, 3]) {
        const margin = maxEntryMargin(balance, 5, slots);
        expect(entryFundingRequired(margin, 5, slots)).toBeLessThanOrEqual(balance);
        expect(entryFundingRequired(margin + 1n, 5, slots)).toBeGreaterThan(balance);
      }
    }
  });

  it("includes independent entry and bracket rewards above the minimum", () => {
    expect(entryFundingRequired(100n * USD, 5, 3)).toBe(100_750_000n);
  });
});
