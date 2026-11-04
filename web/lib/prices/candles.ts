import { z } from "zod";
import type { MarketId } from "@/lib/near/types";

/** Ticker as the market registry spells it, which is also Coinbase's base currency code. */
export const tickerSchema = z.string().regex(/^[A-Z][A-Z0-9]{0,15}$/);

/** Chart intervals and their candle length in seconds. */
export const CANDLE_INTERVALS = { "5m": 300, "1h": 3_600, "1d": 86_400 } as const;
export type CandleInterval = keyof typeof CANDLE_INTERVALS;
export const candleIntervalSchema = z.enum(["5m", "1h", "1d"]);

export const CANDLE_SOURCE = "Coinbase";

export const candleSchema = z.object({
  /** Candle open time, seconds since epoch (UTC). */
  time: z.number().int(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
});
export type Candle = z.infer<typeof candleSchema>;

export const candlesResponseSchema = z.object({
  source: z.literal(CANDLE_SOURCE),
  product: z.string(),
  interval: candleIntervalSchema,
  fetchedAtMs: z.number(),
  /** Oldest first. */
  candles: z.array(candleSchema),
});
export type CandlesResponse = z.infer<typeof candlesResponseSchema>;

export const candlesQuerySchema = z.object({
  market: tickerSchema,
  interval: candleIntervalSchema,
});

/** Coinbase Exchange rows: `[time, low, high, open, close, volume]`, newest first. */
const coinbaseRowsSchema = z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]));

export function coinbaseProduct(market: MarketId): string {
  return `${market}-USD`;
}

export function coinbaseCandlesUrl(market: MarketId, interval: CandleInterval): string {
  return `https://api.exchange.coinbase.com/products/${coinbaseProduct(market)}/candles?granularity=${CANDLE_INTERVALS[interval]}`;
}

/** Validates a Coinbase candles payload and returns it oldest first. */
export function parseCoinbaseCandles(payload: unknown): Candle[] {
  return coinbaseRowsSchema
    .parse(payload)
    .map(([time, low, high, open, close, volume]) => ({ time, open, high, low, close, volume }))
    .sort((a, b) => a.time - b.time);
}

/**
 * Change over the last 24 hours from 5-minute candles (oldest first): latest close against the
 * open of the first candle inside the window. Null when the series does not span 24 hours.
 */
export function change24h(candles: readonly Candle[]): { absolute: number; percent: number } | null {
  const last = candles.at(-1);
  if (!last) return null;
  const windowStart = last.time + CANDLE_INTERVALS["5m"] - CANDLE_INTERVALS["1d"];
  const first = candles.find((c) => c.time >= windowStart);
  if (!first || first.time - windowStart > CANDLE_INTERVALS["1h"] || first.open <= 0) return null;
  const absolute = last.close - first.open;
  return { absolute, percent: (absolute / first.open) * 100 };
}
