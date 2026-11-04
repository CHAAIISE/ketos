"use client";

import { useQuery } from "@tanstack/react-query";
import type { z } from "zod";
import { listableResponseSchema } from "@/lib/intents/listing";
import { marketStatsResponseSchema } from "@/lib/prices/market-stats";

async function getJson<S extends z.ZodType>(url: string, schema: S, signal: AbortSignal): Promise<z.output<S>> {
  const res = await fetch(url, { signal });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = typeof body === "object" && body && "error" in body ? String(body.error) : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return schema.parse(body);
}

export const listableMarketsKey = ["listable-markets"] as const;

/** 24h change of every ticker from `/api/market-stats`, refreshed like its one-minute cache. */
export function useMarketStats(symbols: readonly string[]) {
  const list = [...symbols].sort().join(",");
  return useQuery({
    queryKey: ["market-stats", list] as const,
    queryFn: ({ signal }) => getJson(`/api/market-stats?symbols=${list}`, marketStatsResponseSchema, signal),
    enabled: list.length > 0,
    refetchInterval: 60_000,
    staleTime: 55_000,
  });
}

/** Oracle-priced NEAR Intents assets that are not listed yet, from `/api/listable-markets`. */
export function useListableMarkets() {
  return useQuery({
    queryKey: listableMarketsKey,
    queryFn: ({ signal }) => getJson("/api/listable-markets", listableResponseSchema, signal),
    refetchInterval: 60_000,
    staleTime: 55_000,
  });
}
