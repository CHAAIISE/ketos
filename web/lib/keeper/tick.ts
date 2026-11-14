import { type CrossAccount, type DepthSample, type Market, type MarketId, type Order, type OrderExecution, type Position, type Vault, type VaultId } from "../near/types";
import { isPriceFresh } from "../near/market-status";
import { errorMessage } from "../utils";
import { findLiquidatable, findTriggeredOrders } from "./scan";
import type { Hedge } from "../near/types";
import type { HedgeStep } from "./hedge";

export const MIN_KETOS_BALANCE_YOCTO = 2n * 10n ** 24n;
export const ORDER_BATCH_SIZE = 5;
export const SNAPSHOT_INTERVAL_MS = 3_600_000;
export const PRICE_REFRESH_INTERVAL_MS = 5_000;
export const FAST_TICK_INTERVAL_MS = 10_000;
export const DEPTH_INTERVAL_MS = 10 * 60_000;
export const FUNDING_INTERVAL_MS = 3_600_000;

export interface KeeperChain {
  markets(): Promise<Market[]>;
  hedge(): Promise<Hedge | null>;
  rebalanceHedge(): Promise<HedgeStep>;
  openPositions(): Promise<Position[]>;
  openOrders(): Promise<Order[]>;
  crossAccount(accountId: string): Promise<CrossAccount>;
  vaults(): Promise<Pick<Vault, "id" | "last_snapshot_at_ms">[]>;
  ketosBalanceYocto(): Promise<bigint>;
  setDepth(market: MarketId, samples: DepthSample[], measuredAtMs: number): Promise<string>;
  /** Null means no transaction was submitted; thrown errors may have changed chain state. */
  refreshPrices(markets: readonly Market[]): Promise<string | null>;
  executeOrders(ids: number[]): Promise<{ tx: string; results: OrderExecution[] }>;
  liquidate(positionId: number): Promise<string>;
  liquidateCross(accountId: string): Promise<string>;
  settleFunding(market: MarketId): Promise<string>;
  snapshotVaults(vaultIds: VaultId[]): Promise<string>;
}

export type SlowSummary = {
  startedAt: string;
  durationMs: number;
  depth: Step<{ market: MarketId; measuredAtMs?: number }>[];
  funding: Step<{ market: MarketId }>[];
  snapshots: Step<{ vaultIds: VaultId[] }>[];
  errors: { step: string; error: string }[];
};

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
      activeObservations: { market: MarketId; sourceTimestampMs: number; ageMs: number | null }[];
      degraded: boolean;
      depth: Step<{ market: MarketId; measuredAtMs?: number }>[];
      prices: Step<{ fresh: number; total: number }> | { fresh: number; total: number; skipped: true };
      funding: Step<{ market: MarketId }>[];
      orders: Step<{ ids: number[]; results?: OrderResult[] }>[];
      scannedOrders: number;
      scanned: number;
      liquidations: Step<{ positionId: number; market: MarketId; accountId: string }>[];
      crossLiquidations: Step<{ accountId: string }>[];
      snapshots: Step<{ vaultIds: VaultId[] }>[];
      hedge: HedgeStep | { error: string };
      errors: { step: string; error: string }[];
    }
  | { ok: false; startedAt: string; reason: string };

const message = (error: unknown) => errorMessage(error).slice(0, 300);

/** Transactions remain serial: one restricted signer, no overlapping nonce allocation. */
export async function runTick(chain: KeeperChain, depthSource: DepthSource | null, now: () => number = Date.now): Promise<TickSummary> {
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

  const errors: { step: string; error: string }[] = [];
  const read = async <T>(step: string, load: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await load();
    } catch (e) {
      errors.push({ step, error: message(e) });
      return fallback;
    }
  };

  const [initialMarkets, openOrders, positionsBeforeOrders, hedgeBefore] = await Promise.all([
    chain.markets(),
    read("orders", () => chain.openOrders(), []),
    read("positions", () => chain.openPositions(), []),
    read("hedge", () => chain.hedge(), null),
  ]);
  let markets = initialMarkets;
  const positionAt = new Map(positionsBeforeOrders.map((position) => [position.id, position]));
  const activeMarkets = new Set(markets.filter((m) => m.oi_long > 0n || m.oi_short > 0n).map((m) => m.id));
  if (hedgeBefore && (hedgeBefore.pending || (hedgeBefore.confirmed?.inventory ?? 0n) > 0n)) {
    activeMarkets.add(hedgeBefore.market_id);
  }
  for (const position of positionsBeforeOrders) activeMarkets.add(position.market_id);
  for (const { request, execution } of openOrders) {
    if (!execution || now() > execution.expires_at_ms) continue;
    const market = "market_id" in request ? request.market_id : positionAt.get(request.position_id)?.market_id;
    if (market !== undefined) activeMarkets.add(market);
  }
  const active = markets.filter((m) => activeMarkets.has(m.id));
  const refreshMarkets = active.some((m) => m.price_timestamp_ms > now() || now() - m.price_timestamp_ms >= PRICE_REFRESH_INTERVAL_MS)
    ? active : [];
  let prices: Extract<TickSummary, { ok: true }>["prices"];
  let requestedPrices = false;
  try {
    if (refreshMarkets.length === 0) {
      prices = { fresh: markets.filter((m) => isPriceFresh(m, now())).length, total: markets.length, skipped: true };
    } else {
      requestedPrices = true;
      const tx = await chain.refreshPrices(refreshMarkets);
      requestedPrices = tx !== null;
      if (requestedPrices) markets = await read("prices markets", () => chain.markets(), markets);
      prices = { fresh: markets.filter((m) => isPriceFresh(m, now())).length, total: markets.length,
        ...(tx !== null ? { tx } : { error: "Fresh signed observations unavailable" }) };
      const unobserved = active.filter((before) => {
        const after = markets.find((market) => market.id === before.id);
        return !after || after.price_timestamp_ms <= before.price_timestamp_ms
          || after.price_timestamp_ms > now() || now() - after.price_timestamp_ms > 30_000;
      });
      if (unobserved.length) prices = { ...prices, error: `No fresh advancing observation: ${unobserved.map((market) => market.id).join(", ")}` };
    }
  } catch (e) {
    markets = await read("prices markets", () => chain.markets(), markets);
    prices = { fresh: markets.filter((m) => isPriceFresh(m, now())).length, total: markets.length, error: message(e) };
  }
  // Price refresh changes position equity as well as market prices.
  const orderPositions = requestedPrices
    ? await read("refreshed positions", () => chain.openPositions(), []) : positionsBeforeOrders;
  const triggered = findTriggeredOrders(openOrders, orderPositions, markets, now());
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
  const positions = orders.length
    ? await read("liquidation positions", () => chain.openPositions(), []) : orderPositions;
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

  let hedge: HedgeStep | { error: string };
  try {
    hedge = await chain.rebalanceHedge();
  } catch (error) {
    hedge = { error: message(error) };
  }

  const maintenance = depthSource ? await runSlowTick(chain, depthSource, now) : {
    depth: [], funding: [], snapshots: [], errors: [],
  };
  errors.push(...maintenance.errors);
  const activeObservations = markets.filter((market) => activeMarkets.has(market.id)).map((market) => ({
    market: market.id,
    sourceTimestampMs: market.price_timestamp_ms,
    ageMs: market.price_timestamp_ms > 0 && market.price_timestamp_ms <= now() ? now() - market.price_timestamp_ms : null,
  }));
  return {
    ok: true, startedAt, durationMs: now() - started, marketCount: markets.length,
    activeObservations,
    degraded: errors.length > 0 || "error" in hedge || "error" in prices || activeObservations.some((m) => m.ageMs === null || m.ageMs > 30_000)
      || orders.some((step) => "error" in step) || liquidations.some((step) => "error" in step)
      || crossLiquidations.some((step) => "error" in step) || maintenance.depth.some((step) => "error" in step)
      || maintenance.funding.some((step) => "error" in step) || maintenance.snapshots.some((step) => "error" in step),
    depth: maintenance.depth, prices, funding: maintenance.funding, orders,
    scannedOrders: openOrders.length, scanned: positions.length,
    liquidations, crossLiquidations, snapshots: maintenance.snapshots, hedge, errors,
  };
}

/** Slow I/O runs independently of active-risk cycles; the chain adapter serializes writes. */
export async function runSlowTick(chain: KeeperChain, depthSource: DepthSource, now: () => number = Date.now): Promise<SlowSummary> {
  const started = now();
  const summary: SlowSummary = {
    startedAt: new Date(started).toISOString(), durationMs: 0, depth: [], funding: [],
    snapshots: [], errors: [],
  };
  if (await chain.ketosBalanceYocto() < MIN_KETOS_BALANCE_YOCTO) {
    summary.errors.push({ step: "budget", error: "Contract below the 2 NEAR operational reserve" });
    return summary;
  }
  let markets: Market[];
  try {
    markets = await chain.markets();
  } catch (error) {
    summary.errors.push({ step: "depth markets", error: message(error) });
    summary.durationMs = now() - started;
    return summary;
  }
  try {
    for (const curve of await depthSource.sample(markets)) {
      if ("error" in curve) { summary.depth.push(curve); continue; }
      const base = { market: curve.market, measuredAtMs: curve.measuredAtMs };
      try {
        summary.depth.push({ ...base, tx: await chain.setDepth(curve.market, curve.samples, curve.measuredAtMs) });
      } catch (error) {
        summary.depth.push({ ...base, error: message(error) });
      }
    }
  } catch (error) {
    summary.errors.push({ step: "depth", error: message(error) });
  }
  // Fills/liquidations may have changed funding during the quote fanout.
  try {
    markets = await chain.markets();
  } catch (error) {
    summary.errors.push({ step: "funding markets", error: message(error) });
    markets = [];
  }
  for (const market of markets) {
    if ((market.oi_long === 0n && market.oi_short === 0n)
      || now() - market.funding.last_accrual_ms <= FUNDING_INTERVAL_MS) continue;
    try {
      summary.funding.push({ market: market.id, tx: await chain.settleFunding(market.id) });
    } catch (error) {
      summary.funding.push({ market: market.id, error: message(error) });
    }
  }
  try {
    const due = (await chain.vaults()).filter((vault) =>
      vault.last_snapshot_at_ms === null || now() >= vault.last_snapshot_at_ms + SNAPSHOT_INTERVAL_MS);
    for (let offset = 0; offset < due.length; offset += 8) {
      const vaultIds = due.slice(offset, offset + 8).map((vault) => vault.id);
      try {
        summary.snapshots.push({ vaultIds, tx: await chain.snapshotVaults(vaultIds) });
      } catch (error) {
        summary.snapshots.push({ vaultIds, error: message(error) });
      }
    }
  } catch (error) {
    summary.errors.push({ step: "vaults", error: message(error) });
  }
  summary.durationMs = now() - started;
  return summary;
}
