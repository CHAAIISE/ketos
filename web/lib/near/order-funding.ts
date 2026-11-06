import type { Brackets } from "./calls";

/** Separate refundable collateral per keeper-executed order: 5 bps, minimum 0.10 USDC. */
export function executionReward(size: bigint): bigint {
  const reward = (size * 5n + 9_999n) / 10_000n;
  return reward > 100_000n ? reward : 100_000n;
}

export function executionSlots(entryOrder: boolean, brackets?: Brackets): number {
  return Number(entryOrder) + Number(brackets?.takeProfit != null) + Number(brackets?.stopLoss != null);
}

export function entryFundingRequired(margin: bigint, leverage: number, slots: number): bigint {
  return margin + executionReward(margin * BigInt(leverage)) * BigInt(slots);
}

/** Largest micro-USDC collateral that fits after independently rounded keeper reservations. */
export function maxEntryMargin(available: bigint, leverage: number, slots: number): bigint {
  if (available <= 0n) return 0n;
  let low = 0n;
  let high = available;
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    if (entryFundingRequired(mid, leverage, slots) <= available) low = mid;
    else high = mid - 1n;
  }
  return low;
}
