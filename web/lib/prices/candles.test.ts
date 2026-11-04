import { describe, expect, it } from "vitest";
import { change24h, coinbaseCandlesUrl, parseCoinbaseCandles, type Candle } from "./candles";

describe("parseCoinbaseCandles", () => {
  it("maps [time, low, high, open, close, volume] rows oldest first", () => {
    const rows = [
      [1_800_003_600, 9, 12, 10, 11, 5],
      [1_800_000_000, 8, 11, 9, 10, 4],
    ];
    expect(parseCoinbaseCandles(rows)).toEqual([
      { time: 1_800_000_000, open: 9, high: 11, low: 8, close: 10, volume: 4 },
      { time: 1_800_003_600, open: 10, high: 12, low: 9, close: 11, volume: 5 },
    ]);
  });

  it("rejects payloads that are not candle rows", () => {
    expect(() => parseCoinbaseCandles({ message: "NotFound" })).toThrow();
    expect(() => parseCoinbaseCandles([[1, 2, 3]])).toThrow();
  });
});

describe("coinbaseCandlesUrl", () => {
  it("uses the market's USD product and the interval in seconds", () => {
    expect(coinbaseCandlesUrl("NEAR", "1h")).toBe(
      "https://api.exchange.coinbase.com/products/NEAR-USD/candles?granularity=3600",
    );
  });
});

describe("change24h", () => {
  const series = (count: number, start: number): Candle[] =>
    Array.from({ length: count }, (_, i) => ({
      time: start + i * 300,
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100.5 + i,
      volume: 1,
    }));

  it("compares the latest close with the open 24 hours earlier", () => {
    const candles = series(300, 1_800_000_000);
    const last = candles.at(-1)!;
    const first = candles.find((c) => c.time === last.time + 300 - 86_400)!;
    const change = change24h(candles);
    expect(change?.absolute).toBeCloseTo(last.close - first.open);
    expect(change?.percent).toBeCloseTo(((last.close - first.open) / first.open) * 100);
  });

  it("is null when the series is shorter than a day", () => {
    expect(change24h(series(100, 1_800_000_000))).toBeNull();
    expect(change24h([])).toBeNull();
  });
});
