import type { Side } from "./types";

/** Authorization captured before the wallet prompt; fees are charged separately. */
export interface ExecutionLimits {
  limitPrice: bigint;
  expiresAtMs: number;
}

export interface BracketLimits {
  takeProfit?: ExecutionLimits | null;
  stopLoss?: ExecutionLimits | null;
}

/** Round inward: a buy ceiling never grows and a sell floor never shrinks. */
export function executionLimits(price: bigint, side: Side, closing: boolean, toleranceBps: number, expiresAtMs: number): ExecutionLimits {
  if (price <= 0n || !Number.isInteger(toleranceBps) || toleranceBps < 0 || toleranceBps >= 10_000) {
    throw new RangeError("Execution requires a positive reference price and tolerance below 100%.");
  }
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) throw new RangeError("Execution requires an expiry.");
  const buying = (side === "long") !== closing;
  const numerator = price * BigInt(buying ? 10_000 + toleranceBps : 10_000 - toleranceBps);
  const limitPrice = buying ? numerator / 10_000n : (numerator + 9_999n) / 10_000n;
  return { limitPrice, expiresAtMs };
}

export function executionArg(execution: ExecutionLimits) {
  return { limit_price: execution.limitPrice.toString(), expires_at_ms: execution.expiresAtMs };
}

export function bracketLimitsArg(bounds: BracketLimits | undefined) {
  return bounds ? {
    take_profit: bounds.takeProfit ? executionArg(bounds.takeProfit) : null,
    stop_loss: bounds.stopLoss ? executionArg(bounds.stopLoss) : null,
  } : null;
}
