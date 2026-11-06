import { z } from "zod";
import { CANDLE_SOURCE, tickerSchema } from "./candles";

/** Most tickers a single request may ask for. */
export const MAX_STATS_SYMBOLS = 100;

export const statsQuerySchema = z
  .string()
  .max(MAX_STATS_SYMBOLS * 17)
  .transform((s) => [...new Set(s.split(",").filter(Boolean))])
  .pipe(z.array(tickerSchema).min(1).max(MAX_STATS_SYMBOLS));

export const change24hSchema = z.object({
  open: z.number(),
  last: z.number(),
  percent: z.number(),
});
export type Change24h = z.infer<typeof change24hSchema>;

export const marketStatsResponseSchema = z.object({
  source: z.literal(CANDLE_SOURCE),
  fetchedAtMs: z.number(),
  /** Null when the venue has no USD market for the ticker. */
  changes: z.record(z.string(), change24hSchema.nullable()),
});
export type MarketStatsResponse = z.infer<typeof marketStatsResponseSchema>;

export function coinbaseStatsUrl(symbol: string): string {
  return `https://api.exchange.coinbase.com/products/${symbol}-USD/stats`;
}

const coinbaseStatsSchema = z.looseObject({ open: z.coerce.number(), last: z.coerce.number() });

/** Rolling 24h move from a Coinbase `/stats` body; null when it carries no usable open. */
export function parseCoinbaseStats(payload: unknown): Change24h | null {
  const parsed = coinbaseStatsSchema.safeParse(payload);
  if (!parsed.success) return null;
  const { open, last } = parsed.data;
  if (!(open > 0) || !(last > 0)) return null;
  return { open, last, percent: ((last - open) / open) * 100 };
}
