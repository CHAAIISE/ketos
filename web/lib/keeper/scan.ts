import { isLiquidatable, type Market, type MarketId, type Order, type Position } from "../near/types";
import { isPriceFresh } from "../near/market-status";

/** Cross equity includes cash and every cross position; it cannot be inferred from one leg. */
export function findLiquidatable(positions: readonly Position[], markets: readonly Market[], nowMs: number): Position[] {
  const priceAt = new Map<MarketId, Market>(markets.map((m) => [m.id, m]));
  return positions
    .filter((p) => {
      const market = priceAt.get(p.market_id);
      return p.margin_mode === "isolated" && market !== undefined && isPriceFresh(market, nowMs) && isLiquidatable(p);
    })
    .sort((a, b) => {
      const gapA = a.equity - a.maintenance_margin;
      const gapB = b.equity - b.maintenance_margin;
      return gapA < gapB ? -1 : gapA > gapB ? 1 : 0;
    });
}

/** Cached prices only nominate candidates; each contract execution pulls and rechecks its market. */
export function findTriggeredOrders(orders: readonly Order[], positions: readonly Position[], markets: readonly Market[]): Order[] {
  const priceAt = new Map(markets.map((m) => [m.id, m]));
  const positionAt = new Map(positions.map((p) => [p.id, p]));
  return orders.filter((order) => {
    const request = order.request;
    const target = "position_id" in request ? positionAt.get(request.position_id) : request;
    if (!target) return false;
    const market = priceAt.get(target.market_id);
    if (!market || market.price <= 0n) return false;
    const above = request.kind === "limit" || request.kind === "stop_loss"
      ? target.side === "short" : target.side === "long";
    return above ? market.price >= request.trigger_price : market.price <= request.trigger_price;
  });
}
