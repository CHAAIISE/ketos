import { isMeasuring, type CrossAccount, type DepthSample, type Market, type MarketId, type Order, type OrderExecution, type Position } from "../near/types";
import { findLiquidatable, findTriggeredOrders, isFreshPrice } from "./scan";
import { MIN_TICK_INTERVAL_MS } from "./throttle";

export const MIN_KETOS_BALANCE_YOCTO = 2n * 10n ** 24n;
export const DEPTH_BATCH_SIZE = 8;
export const MEASURING_PRIORITY = 4;
export const ORDER_BATCH_SIZE = 5;
export const SNAPSHOT_INTERVAL_MS = 3_600_000;
export const PRICE_REFRESH_INTERVAL_MS = 300_000;

export interface KeeperChain {
  markets(): Promise<Market[]>;
  openPositions(): Promise<Position[]>;
  openOrders(): Promise<Order[]>;
  crossAccount(accountId: string): Promise<CrossAccount>;
  lastPriceRequestMs(): Promise<number | null>;
  lastSnapshotMs(): Promise<number | null>;
  ketosBalanceYocto(): Promise<bigint>;
  setDepth(market: MarketId, samples: DepthSample[], measuredAtMs: number): Promise<string>;
  refreshPrices(marketIds: MarketId[]): Promise<string>;
  executeOrders(ids: number[]): Promise<{ tx: string; results: OrderExecution[] }>;
  liquidate(positionId: number): Promise<string>;
  liquidateCross(accountId: string): Promise<string>;
  settleFunding(market: MarketId): Promise<string>;
  snapshotVaults(): Promise<string>;
}

export interface MarketDepth {
  market: MarketId;
  samples: DepthSample[];
  /** Start of this curve's measurements, never the time its transaction was sent. */
  measuredAtMs: number;
}

export interface DepthSource {
  sample(markets: readonly Market[]): Promise<(MarketDepth | { market: MarketId; error: string })[]>;
}

type Step<T> = (T & { tx: string }) | (T & { error: string });
type OrderResult = Exclude<OrderExecution, { status: "filled" }> | { status: "filled"; order_id: number; position_id: number; price: string };

export type TickSummary =
  | {
      ok: true;
      startedAt: string;
      durationMs: number;
      marketCount: number;
      depth: Step<{ market: MarketId; measuredAtMs?: number }>[];
      prices: Step<{ fresh: number; total: number }> | { fresh: number; total: number; skipped: true };
      funding: Step<{ market: MarketId }>[];
      orders: Step<{ ids: number[]; results?: OrderResult[] }>[];
      scannedOrders: number;
      scanned: number;
      liquidations: Step<{ positionId: number; market: MarketId; accountId: string }>[];
      crossLiquidations: Step<{ accountId: string }>[];
      snapshots: Step<Record<never, never>> | { skipped: true; nextAtMs: number };
    }
  | { ok: false; startedAt: string; reason: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/**
 * Stable minute slots cover the entire registry, even when a market repeatedly fails measurement.
 * Markets never measured (just listed) are added on top of the slot, at most
 * MEASURING_PRIORITY of them, so a new listing opens after the next tick instead of waiting for
 * its slot, and assets 1Click cannot quote never push measured markets out of rotation.
 */
export function depthBatch(markets: readonly Market[], nowMs: number): Market[] {
  if (markets.length <= DEPTH_BATCH_SIZE) return [...markets];
  const batches = Math.ceil(markets.length / DEPTH_BATCH_SIZE);
  const start = (Math.floor(nowMs / MIN_TICK_INTERVAL_MS) % batches) * DEPTH_BATCH_SIZE;
  const slot = markets.slice(start, start + DEPTH_BATCH_SIZE);
  const extra = markets.filter((m) => isMeasuring(m) && !slot.includes(m)).slice(0, MEASURING_PRIORITY);
  return [...slot, ...extra];
}

/** Transactions remain serial: one restricted signer, no overlapping nonce allocation. */
export async function runTick(chain: KeeperChain, depthSource: DepthSource, now: () => number = Date.now): Promise<TickSummary> {
  const started = now();
  const startedAt = new Date(started).toISOString();
  const balance = await chain.ketosBalanceYocto();
  if (balance < MIN_KETOS_BALANCE_YOCTO) {
    return {
      ok: false,
      startedAt,
      reason: `Ketos contract has ${Number(balance / 10n ** 21n) / 1000} spendable NEAR, below the 2 NEAR reserve; top it up before requesting oracle prices`,
    };
  }

  let markets = await chain.markets();
  const depth: Step<{ market: MarketId; measuredAtMs?: number }>[] = [];
  for (const curve of await depthSource.sample(depthBatch(markets, started))) {
    if ("error" in curve) {
      depth.push(curve);
      continue;
    }
    const base = { market: curve.market, measuredAtMs: curve.measuredAtMs };
    try {
      depth.push({ ...base, tx: await chain.setDepth(curve.market, curve.samples, curve.measuredAtMs) });
    } catch (e) {
      depth.push({ ...base, error: message(e) });
    }
  }

  const funding: Step<{ market: MarketId }>[] = [];
  for (const market of markets) {
    try {
      funding.push({ market: market.id, tx: await chain.settleFunding(market.id) });
    } catch (e) {
      funding.push({ market: market.id, error: message(e) });
    }
  }

  const openOrders = await chain.openOrders();
  const positionsBeforeOrders = openOrders.length ? await chain.openPositions() : [];
  const positionAt = new Map(positionsBeforeOrders.map((p) => [p.id, p]));
  const activeMarkets = new Set(markets.filter((m) => m.oi_long > 0n || m.oi_short > 0n).map((m) => m.id));
  for (const { request } of openOrders) {
    const market = "market_id" in request ? request.market_id : positionAt.get(request.position_id)?.market_id;
    if (market !== undefined) activeMarkets.add(market);
  }
  const active = markets.filter((m) => activeMarkets.has(m.id));
  // One shared lease must cover staggered cache ages, not postpone the younger active feeds.
  const refreshMarkets = active.some((m) => started - m.price_timestamp_ms >= PRICE_REFRESH_INTERVAL_MS)
    ? active.map((m) => m.id) : [];
  let prices: Extract<TickSummary, { ok: true }>["prices"];
  let requestedPrices = false;
  try {
    const lastRequest = refreshMarkets.length ? await chain.lastPriceRequestMs() : null;
    if (refreshMarkets.length === 0 || (lastRequest !== null && started - lastRequest < PRICE_REFRESH_INTERVAL_MS)) {
      prices = { fresh: markets.filter((m) => isFreshPrice(m, now())).length, total: markets.length, skipped: true };
    } else {
      requestedPrices = true;
      const tx = await chain.refreshPrices(refreshMarkets);
      markets = await chain.markets();
      prices = { fresh: markets.filter((m) => isFreshPrice(m, now())).length, total: markets.length, tx };
    }
  } catch (e) {
    markets = await chain.markets();
    prices = { fresh: markets.filter((m) => isFreshPrice(m, now())).length, total: markets.length, error: message(e) };
  }
  // Price refresh changes position equity as well as market prices.
  const orderPositions = requestedPrices && openOrders.length ? await chain.openPositions() : positionsBeforeOrders;
  const triggered = findTriggeredOrders(openOrders, orderPositions, markets);
  const orders: Step<{ ids: number[]; results?: OrderResult[] }>[] = [];
  for (let i = 0; i < triggered.length; i += ORDER_BATCH_SIZE) {
    const ids = triggered.slice(i, i + ORDER_BATCH_SIZE).map((o) => o.id);
    try {
      const { tx, results } = await chain.executeOrders(ids);
      orders.push({ ids, tx, results: results.map((r) => r.status === "filled" ? { ...r, price: r.price.toString() } : r) });
    } catch (e) {
      orders.push({ ids, error: message(e) });
    }
  }

  // Orders can open or close positions and change cross cash. Never liquidate the pre-execution view.
  const positions = await chain.openPositions();
  const liquidations: Step<{ positionId: number; market: MarketId; accountId: string }>[] = [];
  for (const p of findLiquidatable(positions, markets, now())) {
    const base = { positionId: p.id, market: p.market_id, accountId: p.account_id };
    try {
      liquidations.push({ ...base, tx: await chain.liquidate(p.id) });
    } catch (e) {
      liquidations.push({ ...base, error: message(e) });
    }
  }

  const crossLiquidations: Step<{ accountId: string }>[] = [];
  for (const accountId of new Set(positions.filter((p) => p.margin_mode === "cross").map((p) => p.account_id))) {
    try {
      const health = await chain.crossAccount(accountId);
      if (health.position_count > 0 && health.prices_fresh && health.liquidatable) {
        crossLiquidations.push({ accountId, tx: await chain.liquidateCross(accountId) });
      }
    } catch (e) {
      crossLiquidations.push({ accountId, error: message(e) });
    }
  }

  let snapshots: Extract<TickSummary, { ok: true }>["snapshots"];
  try {
    const last = await chain.lastSnapshotMs();
    snapshots = last !== null && now() < last + SNAPSHOT_INTERVAL_MS
      ? { skipped: true, nextAtMs: last + SNAPSHOT_INTERVAL_MS }
      : { tx: await chain.snapshotVaults() };
  } catch (e) {
    snapshots = { error: message(e) };
  }

  return {
    ok: true, startedAt, durationMs: now() - started, marketCount: markets.length,
    depth, prices, funding, orders, scannedOrders: openOrders.length, scanned: positions.length,
    liquidations, crossLiquidations, snapshots,
  };
}
