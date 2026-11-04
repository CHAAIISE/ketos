import type { DepthSample, Market, MarketId, Position } from "../near/types";
import { findLiquidatable } from "./scan";

/** Below this the perps contract may not cover the 0.02 NEAR oracle deposit and storage. */
export const MIN_KETOS_BALANCE_YOCTO = 2n * 10n ** 24n;

export interface KeeperChain {
  markets(): Promise<Market[]>;
  openPositions(): Promise<Position[]>;
  ketosBalanceYocto(): Promise<bigint>;
  /** Each call returns the transaction hash. */
  setDepth(market: MarketId, samples: DepthSample[], measuredAtMs: number): Promise<string>;
  refreshPrices(): Promise<string>;
  liquidate(positionId: number): Promise<string>;
}

export interface MarketDepth {
  market: MarketId;
  samples: DepthSample[];
}

export interface DepthSource {
  /** Exit-liquidity curve of every market measured now, or why one could not be measured. */
  sample(): Promise<(MarketDepth | { market: MarketId; error: string })[]>;
}

type Step<T> = (T & { tx: string }) | (T & { error: string });

export type TickSummary =
  | {
      ok: true;
      startedAt: string;
      durationMs: number;
      depth: Step<{ market: MarketId }>[];
      prices: Step<{ fresh: number }>;
      scanned: number;
      liquidations: Step<{ positionId: number; market: MarketId; accountId: string }>[];
    }
  | { ok: false; startedAt: string; reason: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/**
 * One keeper pass: push fresh 1Click depth for each market, pull oracle prices, then
 * liquidate every position the contract considers under-margined. Steps fail independently.
 */
export async function runTick(chain: KeeperChain, depthSource: DepthSource, now: () => number = Date.now): Promise<TickSummary> {
  const started = now();
  const startedAt = new Date(started).toISOString();

  const balance = await chain.ketosBalanceYocto();
  if (balance < MIN_KETOS_BALANCE_YOCTO) {
    return {
      ok: false,
      startedAt,
      reason: `perps contract balance is ${Number(balance / 10n ** 21n) / 1000} NEAR, below the 2 NEAR needed for oracle requests; top it up from a NEAR faucet`,
    };
  }
  const depth: Step<{ market: MarketId }>[] = [];
  const measuredAtMs = now();
  for (const curve of await depthSource.sample()) {
    if ("error" in curve) {
      depth.push(curve);
      continue;
    }
    try {
      depth.push({ market: curve.market, tx: await chain.setDepth(curve.market, curve.samples, measuredAtMs) });
    } catch (e) {
      depth.push({ market: curve.market, error: message(e) });
    }
  }

  let prices: Step<{ fresh: number }>;
  let markets: Market[] = [];
  try {
    const tx = await chain.refreshPrices();
    markets = await chain.markets();
    const fresh = markets.filter((m) => m.price > 0n && now() - m.price_timestamp_ms <= 120_000).length;
    prices = { fresh, tx };
  } catch (e) {
    prices = { fresh: 0, error: message(e) };
    markets = await chain.markets();
  }

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

  return {
    ok: true,
    startedAt,
    durationMs: now() - started,
    depth,
    prices,
    scanned: positions.length,
    liquidations,
  };
}
