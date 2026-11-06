import { exitCapacityUsd, MAX_DEPTH_AGE_MS, MIN_OPEN_CAPACITY_USD } from "../intents/depth";
import { USDC_UNIT, usd0 } from "./format";
import { MAX_PRICE_AGE_MS, type DepthRecord, type Market } from "./types";

export type MarketStatus =
  | { open: true }
  | { open: false; reason: "no-depth" | "thin" | "stale" | "capital"; label: string };

/** Why a market takes new positions or not, with the same rules as the contract. */
export function marketStatus(market: Market, nowMs: number): MarketStatus {
  if (!Number.isSafeInteger(market.depth_measured_at_ms) || market.depth_measured_at_ms <= 0) {
    return { open: false, reason: "no-depth", label: "Not measured yet" };
  }
  if (market.exit_capacity < BigInt(MIN_OPEN_CAPACITY_USD) * USDC_UNIT) {
    return { open: false, reason: "thin", label: "Exit liquidity under $10k" };
  }
  if (nowMs > 0 && (market.depth_measured_at_ms > nowMs || nowMs - market.depth_measured_at_ms > MAX_DEPTH_AGE_MS)) {
    return { open: false, reason: "stale", label: "Stale depth" };
  }
  if (!market.is_open) {
    return { open: false, reason: "capital", label: "Vault capacity unavailable" };
  }
  return { open: true };
}

export function isPriceFresh(market: Pick<Market, "price" | "price_timestamp_ms">, nowMs: number): boolean {
  return market.price > 0n
    && Number.isSafeInteger(market.price_timestamp_ms)
    && market.price_timestamp_ms > 0
    && (nowMs === 0 || (market.price_timestamp_ms <= nowMs && nowMs - market.price_timestamp_ms <= MAX_PRICE_AGE_MS));
}

/** A quote displayed as tradable needs both admissible depth/capital and a fresh mark. */
export function marketDisplayStatus(market: Market, nowMs: number):
  | MarketStatus
  | { open: false; reason: "price"; label: string } {
  const status = marketStatus(market, nowMs);
  if (!status.open) return status;
  return !market.close_only && isPriceFresh(market, nowMs)
    && (nowMs === 0 || nowMs - market.price_timestamp_ms <= 30_000)
    ? status
    : { open: false, reason: "price", label: "Close-only · price refresh needed" };
}

export function marketLimitLabel(market: Market): "Vault-limited" | "Liquidity-limited" | "Protocol-limited" {
  if (market.vault_backed_cap_usd <= market.max_oi_per_side) return "Vault-limited";
  return market.exit_capacity <= market.hard_cap ? "Liquidity-limited" : "Protocol-limited";
}

/** Without samples the admitted, ramped capacity is only a lower bound on a passed probe grid. */
export function formatExitCapacity(market: Market, record?: DepthRecord): string {
  const rawUsd = record ? exitCapacityUsd(record.samples) : null;
  const value = rawUsd === null ? market.exit_capacity : BigInt(rawUsd) * USDC_UNIT;
  const compact = value >= 1_000_000n * USDC_UNIT && value % (100_000n * USDC_UNIT) === 0n
    ? `$${Number(value / (100_000n * USDC_UNIT)) / 10}M`
    : usd0(value);
  const gridMax = record
    ? rawUsd !== 0 && rawUsd === Math.max(0, ...record.samples.map((sample) => sample.size_usd))
    : market.measured_cap_is_grid_max;
  return `${gridMax ? "≥ " : ""}${compact}`;
}
