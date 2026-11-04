import { describe, expect, it } from "vitest";
import { formatBps, formatFundingRate, formatPrice, formatUnits, formatUsd, formatUsdc, parseUsdc, usdcToNumber } from "./format";

describe("formatUnits", () => {
  it("truncates instead of rounding", () => {
    expect(formatUsdc(1_999_999n)).toBe("1.99");
    expect(formatUnits(1_999_999n, 6)).toBe("1.999999");
  });

  it("groups thousands and pads fraction digits", () => {
    expect(formatUsdc(1_234_567_000_000n)).toBe("1,234,567.00");
    expect(formatUsdc(1_234_567_000_000n, { grouping: false, minFractionDigits: 0 })).toBe("1234567");
    expect(formatUnits(1_500_000n, 6, { minFractionDigits: 0 })).toBe("1.5");
  });

  it("handles signs", () => {
    expect(formatUsd(-12_300_000n)).toBe("-$12.30");
    expect(formatUsd(5_000_000n, { signed: true })).toBe("+$5.00");
    expect(formatUsd(0n, { signed: true })).toBe("$0.00");
    expect(formatUsd(-1n)).toBe("$0.00");
  });
});

describe("formatPrice", () => {
  it("shows 8-decimal prices with 2 decimals above $1 and 4 below", () => {
    expect(formatPrice(9_712_345_678_901n)).toBe("$97,123.45");
    expect(formatPrice(312_345_678n)).toBe("$3.12");
    expect(formatPrice(45_678_901n)).toBe("$0.4567");
  });
});

describe("formatBps", () => {
  it("formats basis points as a percentage", () => {
    expect(formatBps(1234)).toBe("12.34%");
    expect(formatBps(5)).toBe("0.05%");
  });
});

describe("formatFundingRate", () => {
  it("shows the hourly rate with its sign, longs paying when positive", () => {
    expect(formatFundingRate(500_000_000n)).toBe("+0.0500%");
    expect(formatFundingRate(-125_000_000n)).toBe("-0.0125%");
    expect(formatFundingRate(0n)).toBe("0.0000%");
  });
});

describe("parseUsdc", () => {
  it("parses decimal input to USDC units", () => {
    expect(parseUsdc("12.5")).toBe(12_500_000n);
    expect(parseUsdc("1,234.000001")).toBe(1_234_000_001n);
    expect(parseUsdc(" 7 ")).toBe(7_000_000n);
    expect(parseUsdc(".5")).toBe(500_000n);
    expect(parseUsdc("3.")).toBe(3_000_000n);
  });

  it("rejects invalid input and excess precision", () => {
    for (const input of ["", ".", "-1", "1e3", "abc", "1.2.3", "0.0000001"]) {
      expect(parseUsdc(input)).toBeNull();
    }
  });

  it("round-trips with formatting", () => {
    expect(parseUsdc(formatUsdc(987_654_321n, { maxFractionDigits: 6 }))).toBe(987_654_321n);
  });
});

describe("usdcToNumber", () => {
  it("converts units to dollars", () => {
    expect(usdcToNumber(2_500_000n)).toBe(2.5);
  });
});
