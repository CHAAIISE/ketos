import type { CrossAccount, DepthSample, Market, MarketId, Order, OrderExecution, Position } from "../near/types";
import { findLiquidatable, findTriggeredOrders, isFreshPrice } from "./scan";
import { MIN_TICK_INTERVAL_MS } from "./throttle";

export const MIN_KETOS_BALANCE_YOCTO = 2n * 10n ** 24n;
export const DEPTH_BATCH_SIZE = 8;
export const ORDER_BATCH_SIZE = 5;
export const SNAPSHOT_INTERVAL_MS = 3_600_000;

export interface KeeperChain {
  markets(): Promise<Market[]>;
  openPositions(): Promise<Position[]>;
  openOrders(): Promise<Order[]>;
  crossAccount(accountId: string): Promise<CrossAccount>;
  lastSnapshotMs(): Promise<number | null>;
  ketosBalanceYocto(): Promise<bigint>;
  setDepth(market: MarketId, samples: DepthSample[], measuredAtMs: number): Promise<string>;
  refreshPrices(): Promise<string>;
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
      prices: Step<{ fresh: number; total: number }>;
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

/** Stable minute slots cover the entire registry, even when a market repeatedly fails measurement. */
export function depthBatch(markets: readonly Market[], nowMs: number): Market[] {
  if (markets.length <= DEPTH_BATCH_SIZE) return [...markets];
  const batches = Math.ceil(markets.length / DEPTH_BATCH_SIZE);
  const start = (Math.floor(nowMs / MIN_TICK_INTERVAL_MS) % batches) * DEPTH_BATCH_SIZE;
  return markets.slice(start, start + DEPTH_BATCH_SIZE);
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

  let prices: Step<{ fresh: number; total: number }>;
  try {
    const tx = await chain.refreshPrices();
    markets = await chain.markets();
    prices = { fresh: markets.filter((m) => isFreshPrice(m, now())).length, total: markets.length, tx };
  } catch (e) {
    markets = await chain.markets();
    prices = { fresh: markets.filter((m) => isFreshPrice(m, now())).length, total: markets.length, error: message(e) };
  }

  const openOrders = await chain.openOrders();
  const positionsBeforeOrders = openOrders.length ? await chain.openPositions() : [];
  const triggered = findTriggeredOrders(openOrders, positionsBeforeOrders, markets, now());
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
