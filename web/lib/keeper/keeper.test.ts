import { describe, expect, it } from "vitest";
import type { Market, MarketId, Position } from "../near/types";
import { findLiquidatable } from "./scan";
import { MIN_TICK_INTERVAL_MS, TickGate, retryAfterMs } from "./throttle";
import { MIN_KETOS_BALANCE_YOCTO, runTick, type KeeperChain } from "./tick";

const NOW = 1_762_190_000_000;
const USD = 1_000_000n;

function market(id: MarketId, priceAgeMs = 10_000): Market {
  return {
    id,
    oracle_asset_id: id,
    hard_cap: 500_000n * USD,
    exit_capacity: 100_000n * USD,
    depth_measured_at_ms: NOW - 30_000,
    oi_long: 0n,
    oi_short: 0n,
    max_leverage: 5,
    price: 400_000_000n,
    price_timestamp_ms: NOW - priceAgeMs,
    borrow_index_long: 0n,
    borrow_index_short: 0n,
    last_accrual_ms: NOW,
    max_oi_per_side: 100_000n * USD,
    is_open: true,
  };
}

function position(id: number, market_id: MarketId, equity: bigint, maintenance = 50n * USD): Position {
  return {
    id,
    account_id: "trader.test",
    market_id,
    side: "long",
    margin: 99_500_000n,
    size: 500n * USD,
    entry_price: 400_000_000n,
    leverage: 5,
    max_leverage: 5,
    opened_at_ms: NOW - 3_600_000,
    mark_price: 360_000_000n,
    mark_price_timestamp_ms: NOW - 10_000,
    unrealized_pnl: equity - 99_500_000n,
    borrow_fee: 0n,
    close_fee: 500_000n,
    equity,
    maintenance_margin: maintenance,
    liquidation_price: 360_400_000n,
  };
}

describe("keeper throttle", () => {
  it("allows the first tick and waits out the rest of the minute", () => {
    expect(retryAfterMs(null, NOW)).toBe(0);
    expect(retryAfterMs(NOW - 45_000, NOW)).toBe(15_000);
    expect(retryAfterMs(NOW - MIN_TICK_INTERVAL_MS, NOW)).toBe(0);
  });

  it("refuses a second tick within 60 s, and while one is running", () => {
    const gate = new TickGate();
    const first = gate.enter(NOW);
    expect(first.ok).toBe(true);
    expect(gate.enter(NOW + 61_000)).toEqual({ ok: false, retryAfterMs: MIN_TICK_INTERVAL_MS });
    if (first.ok) first.release();
    expect(gate.enter(NOW + 59_000)).toEqual({ ok: false, retryAfterMs: 1_000 });
    expect(gate.enter(NOW + 60_000).ok).toBe(true);
  });

  it("honours a recent tick from another server instance seen on chain", () => {
    expect(new TickGate().enter(NOW, NOW - 20_000)).toEqual({ ok: false, retryAfterMs: 40_000 });
  });
});

describe("liquidation scan", () => {
  const markets = [market("NEAR"), market("ZEC", 121_000)];

  it("picks positions at or below maintenance, most under water first", () => {
    const found = findLiquidatable(
      [position(1, "NEAR", 80n * USD), position(2, "NEAR", 50n * USD), position(3, "NEAR", -5n * USD)],
      markets,
      NOW,
    );
    expect(found.map((p) => p.id)).toEqual([3, 2]);
  });

  it("skips markets whose price the contract would refuse as stale", () => {
    expect(findLiquidatable([position(4, "ZEC", 0n)], markets, NOW)).toEqual([]);
  });

  it("skips markets that never had a price", () => {
    expect(findLiquidatable([position(5, "BTC", 0n)], [{ ...market("BTC"), price: 0n }], NOW)).toEqual([]);
  });
});

function fakeChain(overrides: Partial<KeeperChain> = {}): KeeperChain & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    markets: async () => [market("NEAR")],
    openPositions: async () => [position(1, "NEAR", 10n * USD), position(2, "NEAR", 90n * USD), position(3, "NEAR", 0n)],
    ketosBalanceYocto: async () => MIN_KETOS_BALANCE_YOCTO,
    setDepth: async (m) => (calls.push(`set_depth ${m}`), `tx-depth-${m}`),
    refreshPrices: async () => (calls.push("refresh_prices"), "tx-prices"),
    liquidate: async (id) => (calls.push(`liquidate ${id}`), `tx-liq-${id}`),
    ...overrides,
  };
}

const depthSource = {
  sample: async () => [
    { market: "NEAR" as const, samples: [{ size_usd: 1_000, impact_bps: 25 }] },
    { market: "ZEC" as const, error: "1Click returned 503" },
  ],
};

describe("keeper tick", () => {
  it("refuses to run when the perps contract cannot fund oracle requests", async () => {
    const chain = fakeChain({ ketosBalanceYocto: async () => MIN_KETOS_BALANCE_YOCTO - 1n });
    const summary = await runTick(chain, depthSource, () => NOW);
    expect(summary.ok).toBe(false);
    expect(chain.calls).toEqual([]);
  });

  it("pushes depth, refreshes prices before scanning, and keeps going after a failed step", async () => {
    const chain = fakeChain({
      liquidate: async (id) => {
        throw new Error(`Smart contract panicked: ERR_NOT_LIQUIDATABLE ${id}`);
      },
    });
    const summary = await runTick(chain, depthSource, () => NOW);
    expect(chain.calls).toEqual(["set_depth NEAR", "refresh_prices"]);
    expect(summary).toMatchObject({
      ok: true,
      depth: [{ market: "NEAR", tx: "tx-depth-NEAR" }, { market: "ZEC", error: "1Click returned 503" }],
      prices: { fresh: 1, tx: "tx-prices" },
      scanned: 3,
      liquidations: [
        { positionId: 3, error: "Smart contract panicked: ERR_NOT_LIQUIDATABLE 3" },
        { positionId: 1, error: "Smart contract panicked: ERR_NOT_LIQUIDATABLE 1" },
      ],
    });
  });

  it("liquidates every under-margined position", async () => {
    const chain = fakeChain();
    const summary = await runTick(chain, depthSource, () => NOW);
    expect(chain.calls.slice(2)).toEqual(["liquidate 3", "liquidate 1"]);
    expect(summary.ok && summary.liquidations.map((l) => ("tx" in l ? l.tx : l.error))).toEqual(["tx-liq-3", "tx-liq-1"]);
  });
});
