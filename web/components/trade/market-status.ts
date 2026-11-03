import { MAX_DEPTH_AGE_MS, MIN_OPEN_CAPACITY_USD } from "@/lib/intents/depth";
import { USDC_UNIT } from "@/lib/near/format";
import type { Market } from "@/lib/near/types";

/** Prices older than this are refused by `open_position` and `close_position`. */
export const MAX_PRICE_AGE_MS = 120_000;

export type MarketStatus =
  | { open: true }
  | { open: false; reason: "no-depth" | "thin" | "stale"; label: string };

/** Why a market takes new positions or not, with the same rules as the contract. */
export function marketStatus(market: Market, nowMs: number): MarketStatus {
  if (market.depth_measured_at_ms === 0) {
    return { open: false, reason: "no-depth", label: "Not measured yet" };
  }
  if (market.exit_capacity < BigInt(MIN_OPEN_CAPACITY_USD) * USDC_UNIT) {
    return { open: false, reason: "thin", label: "Exit liquidity under $10k" };
  }
  if (!market.is_open || (nowMs > 0 && nowMs - market.depth_measured_at_ms > MAX_DEPTH_AGE_MS)) {
    return { open: false, reason: "stale", label: "Measurement older than 30 min" };
  }
  return { open: true };
}

export function isPriceFresh(market: Market, nowMs: number): boolean {
  return market.price > 0n && (nowMs === 0 || nowMs - market.price_timestamp_ms <= MAX_PRICE_AGE_MS);
}
