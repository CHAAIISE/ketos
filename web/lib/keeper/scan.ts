import { isLiquidatable, type Market, type MarketId, type Position } from "../near/types";

/** Oracle prices older than this are refused by the contract (`ERR_STALE_PRICE`). */
export const MAX_PRICE_AGE_MS = 120_000;

/**
 * Positions the contract will accept to liquidate now: equity at or below maintenance,
 * marked at a price still fresh enough for `liquidate` to use. Most under water first.
 */
export function findLiquidatable(positions: readonly Position[], markets: readonly Market[], nowMs: number): Position[] {
  const priceAt = new Map<MarketId, Market>(markets.map((m) => [m.id, m]));
  return positions
    .filter((p) => {
      const market = priceAt.get(p.market_id);
      if (!market || market.price === 0n) return false;
      return nowMs - market.price_timestamp_ms <= MAX_PRICE_AGE_MS && isLiquidatable(p);
    })
    .sort((a, b) => {
      const gapA = a.equity - a.maintenance_margin;
      const gapB = b.equity - b.maintenance_margin;
      return gapA < gapB ? -1 : gapA > gapB ? 1 : 0;
    });
}
