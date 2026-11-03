import type { Market, Side } from "@/lib/near/types";

// Mirrors contracts/perps/src/math.rs so the ticket previews exactly what `open_position` will do.
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

/** What `open_position(margin, leverage)` would produce at the current mark price. */
export function previewOrder(market: Market, side: Side, margin: bigint, leverage: number): OrderPreview {
  const size = margin * BigInt(leverage);
  const openFee = tradeFee(size);
  const positionMargin = margin > openFee ? margin - openFee : 0n;
  const maintenance = maintenanceMargin(size, market.max_leverage);
  const buffer = positionMargin - maintenance;
  let liquidationPrice = 0n;
  if (size > 0n && market.price > 0n) {
    const absBuffer = buffer < 0n ? -buffer : buffer;
    const move = (market.price * absBuffer) / size;
    const below = (side === "long") === buffer > 0n;
    liquidationPrice = below ? (market.price > move ? market.price - move : 0n) : market.price + move;
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
