"use client";

import { useQuery } from "@tanstack/react-query";
import type { MarketId } from "@/lib/near/types";
import { candlesResponseSchema, type CandleInterval } from "@/lib/prices/candles";

/** Candles from the `/api/candles` proxy (Coinbase Exchange), refreshed every 30 s like its cache. */
export function useCandles(market: MarketId, interval: CandleInterval) {
  return useQuery({
    queryKey: ["candles", market, interval] as const,
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/candles?market=${market}&interval=${interval}`, { signal });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const message = typeof body === "object" && body && "error" in body ? String(body.error) : `HTTP ${res.status}`;
        throw new Error(message);
      }
      return candlesResponseSchema.parse(body);
    },
    refetchInterval: 30_000,
    staleTime: 25_000,
  });
}
