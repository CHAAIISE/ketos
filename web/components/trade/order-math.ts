import type { Market, Side } from "@/lib/near/types";

// Mirrors contracts/ketos/src/math.rs so the ticket previews exactly what `open_position` will do.
const BPS = 10_000n;
const TRADE_FEE_BPS = 10n;
const RATE_PRECISION = 1_000_000_000_000n;
const BORROW_BASE_PER_HOUR = 10_000_000n;
const BORROW_SLOPE_PER_HOUR = 90_000_000n;
/** Smallest margin `open_position` accepts, USDC units. */
export const MIN_POSITION_MARGIN = 1_000_000n;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Opening or closing fee on a notional: 0.1%, rounded up in favour of the vault. */
export function tradeFee(size: bigint): bigint {
  return ceilDiv(size * TRADE_FEE_BPS, BPS);
}

export function maintenanceMargin(size: bigint, maxLeverage: number): bigint {
  return ceilDiv(size, 2n * BigInt(maxLeverage));
}

/** Hourly borrow rate for a side carrying `oi` of `maxOi`, as a fraction of `RATE_PRECISION`. */
export function borrowRatePerHour(oi: bigint, maxOi: bigint): bigint {
  const slope =
    maxOi === 0n || oi >= maxOi ? BORROW_SLOPE_PER_HOUR : ceilDiv(BORROW_SLOPE_PER_HOUR * oi, maxOi);
  return BORROW_BASE_PER_HOUR + slope;
}

/** Hourly borrow rate in percent of notional, for display ("0.0010%"). */
export function borrowRatePercent(ratePerHour: bigint): string {
  return `${((Number(ratePerHour) / Number(RATE_PRECISION)) * 100).toFixed(4)}%`;
}

export function sideOpenInterest(market: Market, side: Side): bigint {
  return side === "long" ? market.oi_long : market.oi_short;
}

/** Notional still accepted on one side before the exit-liquidity cap, USDC units. */
export function capRoom(market: Market, side: Side): bigint {
  const oi = sideOpenInterest(market, side);
  return market.max_oi_per_side > oi ? market.max_oi_per_side - oi : 0n;
}

export interface OrderPreview {
  /** Notional = margin × leverage, USDC units. */
  size: bigint;
  openFee: bigint;
  /** Collateral left in the position after the opening fee. */
  positionMargin: bigint;
  maintenance: bigint;
  /** 8-decimal price at which the position becomes liquidatable; 0 when it would be negative. */
  liquidationPrice: bigint;
  /** Hourly borrow rate once this position is added to its side. */
  borrowRatePerHour: bigint;
  capRoom: bigint;
  exceedsCap: boolean;
}

/**
 * What `open_position(margin, leverage)` would produce at `entryPrice`: the mark price for a
 * market order, the trigger price for a Limit or Stop Market entry.
 */
export function previewOrder(
  market: Market,
  side: Side,
  margin: bigint,
  leverage: number,
  entryPrice: bigint = market.price,
): OrderPreview {
  const size = margin * BigInt(leverage);
  const openFee = tradeFee(size);
  const positionMargin = margin > openFee ? margin - openFee : 0n;
  const maintenance = maintenanceMargin(size, market.max_leverage);
  const buffer = positionMargin - maintenance;
  let liquidationPrice = 0n;
  if (size > 0n && entryPrice > 0n) {
    const absBuffer = buffer < 0n ? -buffer : buffer;
    const move = (entryPrice * absBuffer) / size;
    const below = (side === "long") === buffer > 0n;
    liquidationPrice = below ? (entryPrice > move ? entryPrice - move : 0n) : entryPrice + move;
  }
  const room = capRoom(market, side);
  return {
    size,
    openFee,
    positionMargin,
    maintenance,
    liquidationPrice,
    borrowRatePerHour: borrowRatePerHour(sideOpenInterest(market, side) + size, market.max_oi_per_side),
    capRoom: room,
    exceedsCap: size > room,
  };
}

export type EntryKind = "market" | "limit" | "stop_market";
export type BracketKind = "take_profit" | "stop_loss";

/**
 * Price where a bracket sits `moveBps` away from `reference`, on the profitable side for a take
 * profit and the losing side for a stop loss. Null when a stop loss would reach zero.
 */
export function bracketPriceFromMove(side: Side, kind: BracketKind, reference: bigint, moveBps: bigint): bigint | null {
  const up = (side === "long") === (kind === "take_profit");
  if (!up && moveBps >= BPS) return null;
  return (reference * (up ? BPS + moveBps : BPS - moveBps)) / BPS;
}

/** Distance of `price` from `reference` in basis points, always positive. */
export function moveBpsFromPrice(reference: bigint, price: bigint): bigint {
  if (reference === 0n) return 0n;
  const diff = price > reference ? price - reference : reference - price;
  return (diff * BPS) / reference;
}

/**
 * Same rule as `Brackets::validate` in the contract: a take profit strictly beyond the reference
 * price in the position's favour, a stop loss strictly on the other side.
 */
export function bracketError(side: Side, kind: BracketKind, reference: bigint, price: bigint): string | null {
  if (price <= 0n) return "Enter a price above zero.";
  const above = (side === "long") === (kind === "take_profit");
  const ok = above ? price > reference : price < reference;
  if (ok) return null;
  const label = kind === "take_profit" ? "Take profit" : "Stop loss";
  const where = above ? "above" : "below";
  return `${label} must be ${where} the ${side === "long" ? "long" : "short"} entry.`;
}

/** PnL of `size` USDC of notional entered at `entry` and closed at `exit`, before fees. */
export function pnlAt(side: Side, size: bigint, entry: bigint, exit: bigint): bigint {
  if (entry === 0n) return 0n;
  const move = ((exit - entry) * size) / entry;
  return side === "long" ? move : -move;
}

/**
 * Whether an entry order would fill at the given oracle price, as `execute_orders` decides:
 * a long Limit buys at or below its price, a long Stop Market at or above, shorts the reverse.
 */
export function entryTriggered(kind: Exclude<EntryKind, "market">, side: Side, trigger: bigint, price: bigint): boolean {
  const above = kind === "limit" ? side === "short" : side === "long";
  return above ? price >= trigger : price <= trigger;
}
