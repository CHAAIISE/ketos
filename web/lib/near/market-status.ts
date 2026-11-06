import { MAX_DEPTH_AGE_MS, MIN_OPEN_CAPACITY_USD } from "../intents/depth";
import { USDC_UNIT } from "./format";
import { MAX_PRICE_AGE_MS, type Market } from "./types";

export type MarketStatus =
  | { open: true }
  | { open: false; reason: "no-depth" | "thin" | "stale"; label: string };

/** Why a market takes new positions or not, with the same rules as the contract. */
export function marketStatus(market: Market, nowMs: number): MarketStatus {
  if (!Number.isSafeInteger(market.depth_measured_at_ms) || market.depth_measured_at_ms <= 0) {
    return { open: false, reason: "no-depth", label: "Not measured yet" };
  }
  if (market.exit_capacity < BigInt(MIN_OPEN_CAPACITY_USD) * USDC_UNIT) {
    return { open: false, reason: "thin", label: "Exit liquidity under $10k" };
  }
  if (!market.is_open || (nowMs > 0 && (market.depth_measured_at_ms > nowMs || nowMs - market.depth_measured_at_ms > MAX_DEPTH_AGE_MS))) {
    return { open: false, reason: "stale", label: "Measurement older than 30 min" };
  }
  return { open: true };
}

export function isPriceFresh(market: Pick<Market, "price" | "price_timestamp_ms">, nowMs: number): boolean {
  return market.price > 0n
    && Number.isSafeInteger(market.price_timestamp_ms)
    && market.price_timestamp_ms > 0
    && (nowMs === 0 || (market.price_timestamp_ms <= nowMs && nowMs - market.price_timestamp_ms <= MAX_PRICE_AGE_MS));
}
