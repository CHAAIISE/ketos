import { describe, expect, it } from "vitest";
import type { CrossAccount, Market, MarketId, Order, Position } from "../near/types";
import { isPriceFresh } from "../near/market-status";
import { findLiquidatable, findTriggeredOrders } from "./scan";
import { MIN_TICK_INTERVAL_MS, TickGate, retryAfterMs } from "./throttle";
import { FUNDING_INTERVAL_MS, MIN_KETOS_BALANCE_YOCTO, ORDER_BATCH_SIZE, PRICE_REFRESH_INTERVAL_MS, runTick, SNAPSHOT_INTERVAL_MS, type KeeperChain } from "./tick";

const NOW = 1_762_190_000_000;
const USD = 1_000_000n;

function market(id: MarketId, priceAgeMs = 10_000): Market {
  return {
    id,
    oracle_asset_id: id,
    intents_asset_id: `nep141:${id.toLowerCase()}.near`,
    price_source: "tee",
    vault_id: "core",
    fee_bps: 10,
    max_leverage_cap: 20,
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
    funding: { paid_index: [0n, 0n], received_index: [0n, 0n], last_accrual_ms: NOW },
    max_oi_per_side: 100_000n * USD,
    is_open: true,
    funding_rate_per_hour: 0n,
  };
}

function position(id: number, market_id: MarketId, equity: bigint, maintenance = 50n * USD): Position {
  return {
    id,
    account_id: "trader.test",
    market_id,
    side: "long",
    margin_mode: "isolated",
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
    funding_paid: 0n,
    funding_received: 0n,
    funding_payment: 0n,
    equity,
    maintenance_margin: maintenance,
    liquidation_price: 360_400_000n,
    take_profit: null,
    stop_loss: null,
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

  it("rejects future-dated marks and includes the exact freshness boundary", () => {
    const liquidatable = [position(6, "NEAR", 0n)];
    expect(findLiquidatable(liquidatable, [market("NEAR", -1)], NOW)).toEqual([]);
    expect(findLiquidatable(liquidatable, [market("NEAR", 120_000)], NOW)).toEqual(liquidatable);
    expect(findLiquidatable(liquidatable, [market("NEAR", 120_001)], NOW)).toEqual([]);
  });
});

function fakeChain(overrides: Partial<KeeperChain> = {}): KeeperChain & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    markets: async () => [market("NEAR")],
    openPositions: async () => [position(1, "NEAR", 10n * USD), position(2, "NEAR", 90n * USD), position(3, "NEAR", 0n)],
    openOrders: async () => [],
    crossAccount: async () => { throw new Error("unexpected cross read"); },
    lastSnapshotMs: async () => NOW,
    lastPriceRequestMs: async () => null,
    settleFunding: async (m) => (calls.push(`settle_funding ${m}`), `tx-funding-${m}`),
    executeOrders: async () => { throw new Error("unexpected order execution"); },
    liquidateCross: async (id) => (calls.push(`liquidate_cross ${id}`), `tx-cross-${id}`),
    snapshotVaults: async () => (calls.push("snapshot_vaults"), "tx-snapshot"),
    ketosBalanceYocto: async () => MIN_KETOS_BALANCE_YOCTO,
    setDepth: async (m) => (calls.push(`set_depth ${m}`), `tx-depth-${m}`),
    refreshPrices: async (ids) => (calls.push(`refresh_prices ${ids.join(",")}`), "tx-prices"),
    liquidate: async (id) => (calls.push(`liquidate ${id}`), `tx-liq-${id}`),
    ...overrides,
  };
}

const depthSource = {
  sample: async () => [
    { market: "NEAR" as const, measuredAtMs: NOW - 20_000, samples: [{ size_usd: 1_000, impact_bps: 25 }] },
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

  it("pushes depth, refreshes overdue active prices before scanning, and keeps going after a failed step", async () => {
    let reads = 0;
    const chain = fakeChain({
      markets: async () => [{ ...market("NEAR", reads++ === 0 ? PRICE_REFRESH_INTERVAL_MS : 10_000), oi_long: USD }],
      liquidate: async (id) => {
        throw new Error(`Smart contract panicked: ERR_NOT_LIQUIDATABLE ${id}`);
      },
    });
    const summary = await runTick(chain, depthSource, () => NOW);
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
    expect(chain.calls).toContain("refresh_prices NEAR");
  });

  it("liquidates every under-margined position", async () => {
    const chain = fakeChain();
    const summary = await runTick(chain, depthSource, () => NOW);
    expect(summary.ok && summary.liquidations.map((l) => l.positionId)).toEqual([3, 1]);
  });

  it("skips oracle requests for inactive markets, even if they have never had a price", async () => {
    const chain = fakeChain({ markets: async () => [
      { ...market("NEAR", PRICE_REFRESH_INTERVAL_MS), price: 0n, price_timestamp_ms: 0 },
      market("IDLE", PRICE_REFRESH_INTERVAL_MS * 10),
    ], openPositions: async () => [] });
    const summary = await runTick(chain, depthSource, () => NOW);
    expect(chain.calls.filter((call) => call.startsWith("refresh_prices"))).toEqual([]);
    expect(summary.ok && summary.prices).toEqual({ fresh: 0, total: 2, skipped: true });
  });

  it("keeps staggered active markets under surveillance without a second bill inside five minutes", async () => {
    let clock = NOW;
    let lastRequest = NOW - PRICE_REFRESH_INTERVAL_MS;
    let requests = 0;
    const registry = [
      market("NEAR", PRICE_REFRESH_INTERVAL_MS),
      market("EXIT", PRICE_REFRESH_INTERVAL_MS),
      { ...market("FRESH", PRICE_REFRESH_INTERVAL_MS - 10_000), oi_long: USD },
      market("IDLE", PRICE_REFRESH_INTERVAL_MS * 10),
    ];
    const order = entry(1);
    const exit: Order = { id: 2, account_id: "trader.test", created_at_ms: NOW,
      request: { kind: "stop_loss", position_id: 99, trigger_price: 0n } };
    const orphan: Order = { ...exit, id: 3,
      request: { kind: "stop_loss", position_id: 100, trigger_price: 0n } };
    const chain = fakeChain({
      markets: async () => registry.map((m) => ({ ...m })),
      lastPriceRequestMs: async () => lastRequest,
      openOrders: async () => [order, { ...order, id: 4 }, exit, orphan],
      openPositions: async () => [position(99, "EXIT", 90n * USD)],
      refreshPrices: async (ids) => {
        requests++;
        lastRequest = clock;
        for (const m of registry) if (ids.includes(m.id)) m.price_timestamp_ms = clock;
        return `tx-prices-${requests}`;
      },
      executeOrders: async (ids) => ({ tx: "tx-orders", results: ids.map((order_id) => ({ status: "skipped", order_id })) }),
    });
    const noDepth = { sample: async () => [] };
    await runTick(chain, noDepth, () => clock);
    expect(registry.slice(0, 3).every((m) => isPriceFresh(m, clock))).toBe(true);
    expect(registry[3].price_timestamp_ms).toBe(NOW - PRICE_REFRESH_INTERVAL_MS * 10);
    clock += PRICE_REFRESH_INTERVAL_MS - 1;
    await runTick(chain, noDepth, () => clock);
    expect(requests).toBe(1);
    clock++;
    await runTick(chain, noDepth, () => clock);
    expect(requests).toBe(2);
    expect(registry.slice(0, 3).every((m) => isPriceFresh(m, clock))).toBe(true);
  });

  it("does not refresh active prices again before the five-minute boundary", async () => {
    const chain = fakeChain({ markets: async () => [{ ...market("NEAR", PRICE_REFRESH_INTERVAL_MS - 1), oi_long: USD }] });
    const summary = await runTick(chain, depthSource, () => NOW);
    expect(chain.calls.filter((call) => call.startsWith("refresh_prices"))).toEqual([]);
    expect(summary.ok && summary.prices).toEqual({ fresh: 0, total: 1, skipped: true });
  });

  it.each([NOW - PRICE_REFRESH_INTERVAL_MS + 1, NOW + 1])(
    "honours a persisted recent request at %s even when the cached price is old after an oracle failure",
    async (lastRequest) => {
      const chain = fakeChain({
        markets: async () => [{ ...market("NEAR", PRICE_REFRESH_INTERVAL_MS * 10), oi_long: USD }],
        lastPriceRequestMs: async () => lastRequest,
      });
      const summary = await runTick(chain, depthSource, () => NOW);
      expect(chain.calls.filter((call) => call.startsWith("refresh_prices"))).toEqual([]);
      expect(summary.ok && summary.prices).toEqual({ fresh: 0, total: 1, skipped: true });
    },
  );

  it("allows an overdue active-market refresh at the persisted five-minute boundary", async () => {
    const chain = fakeChain({
      markets: async () => [{ ...market("NEAR", PRICE_REFRESH_INTERVAL_MS), oi_long: USD }],
      lastPriceRequestMs: async () => NOW - PRICE_REFRESH_INTERVAL_MS,
    });
    await runTick(chain, depthSource, () => NOW);
    expect(chain.calls.filter((call) => call.startsWith("refresh_prices"))).toEqual(["refresh_prices NEAR"]);
  });

  it("still executes triggered orders and liquidations when refresh and both registry re-reads fail", async () => {
    let reads = 0;
    const chain = fakeChain({
      markets: async () => {
        if (reads++ > 0) throw new Error("registry RPC unavailable");
        return [market("NEAR"), { ...market("OTHER", PRICE_REFRESH_INTERVAL_MS), oi_long: USD }];
      },
      openOrders: async () => [entry(1)],
      refreshPrices: async () => { throw new Error("oracle unavailable"); },
      executeOrders: async () => ({ tx: "tx-filled", results: [
        { status: "filled", order_id: 1, position_id: 4, price: 400_000_000n },
      ] }),
    });
    const summary = await runTick(chain, depthSource, () => NOW);
    expect(summary).toMatchObject({
      ok: true,
      prices: { error: "oracle unavailable" },
      orders: [{ tx: "tx-filled" }],
      liquidations: [{ positionId: 3, tx: "tx-liq-3" }, { positionId: 1, tx: "tx-liq-1" }],
    });
  });
});

function entry(id: number, kind: "limit" | "stop_market" = "limit", side: "long" | "short" = "long"): Order {
  return {
    id, account_id: "trader.test", created_at_ms: NOW - 1_000,
    request: { kind, side, market_id: "NEAR", margin: 100n * USD, leverage: 5, trigger_price: 400_000_000n, brackets: null, margin_mode: "isolated" },
  };
}

function crossHealth(accountId: string, overrides: Partial<CrossAccount> = {}): CrossAccount {
  return {
    account_id: accountId, cash: 0n, equity: 100n * USD, maintenance_margin: 50n * USD,
    health_bps: 20_000n, position_count: 2, prices_fresh: true, liquidatable: false,
    debt_by_vault: [0n, 0n], ...overrides,
  };
}

describe("keeper order triggers", () => {
  it.each(["limit", "stop_market", "take_profit", "stop_loss"] as const)("%s uses both sides and inclusive thresholds", (kind) => {
    for (const side of ["long", "short"] as const) {
      const p = { ...position(9, "NEAR", 99n * USD), side };
      const order: Order = kind === "limit" || kind === "stop_market"
        ? entry(1, kind, side)
        : { id: 1, account_id: p.account_id, created_at_ms: NOW, request: { kind, position_id: 9, trigger_price: 400_000_000n } };
      const above = kind === "limit" || kind === "stop_loss" ? side === "short" : side === "long";
      expect(findTriggeredOrders([order], [p], [market("NEAR")])).toEqual([order]);
      expect(findTriggeredOrders([order], [p], [{ ...market("NEAR"), price: 400_000_000n + (above ? 1n : -1n) }])).toEqual([order]);
      expect(findTriggeredOrders([order], [p], [{ ...market("NEAR"), price: 400_000_000n + (above ? -1n : 1n) }])).toEqual([]);
    }
  });

  it("uses stale observed triggers for contract-side pulls, but skips unknown markets and orphan exits", () => {
    const exit: Order = { id: 2, account_id: "trader.test", created_at_ms: NOW, request: { kind: "stop_loss", position_id: 99, trigger_price: 500_000_000n } };
    expect(findTriggeredOrders([entry(1), exit], [], [market("NEAR", 120_001)])).toEqual([entry(1)]);
    expect(findTriggeredOrders([entry(1)], [], [])).toEqual([]);
    expect(findTriggeredOrders([entry(1)], [], [{ ...market("NEAR"), price: 0n }])).toEqual([]);
    expect(findTriggeredOrders([entry(1)], [], [market("NEAR", 30_000)]).map((o) => o.id)).toEqual([1]);
    expect(findTriggeredOrders([entry(1)], [], [market("NEAR", 30_001)])).toEqual([entry(1)]);
  });

  it("submits observed exit triggers regardless of age, without using fallback spread to invent triggers", () => {
    const p = position(9, "NEAR", 99n * USD);
    const exit: Order = { id: 2, account_id: p.account_id, created_at_ms: NOW,
      request: { kind: "stop_loss", position_id: 9, trigger_price: 400_000_000n } };
    for (const age of [120_001, 600_000]) {
      expect(findTriggeredOrders([exit], [p], [market("NEAR", age)])).toEqual([exit]);
    }
    expect(findTriggeredOrders([exit], [p], [market("NEAR", 120_000)])).toEqual([exit]);
    expect(findTriggeredOrders([exit], [p], [market("NEAR", 600_001)])).toEqual([exit]);
    expect(findTriggeredOrders([exit], [p], [
      { ...market("NEAR", 600_001), price: 400_000_001n },
    ])).toEqual([]);
  });
});

describe("keeper maintenance", () => {
  it("publishes every market in one pass, including never-measured listings", async () => {
    const registry = Array.from({ length: 19 }, (_, i) => ({
      ...market(`LISTED${i}`), depth_measured_at_ms: i % 2 ? 0 : NOW - 60_000,
    }));
    const published = new Map<string, number>();
    const chain = fakeChain({
      markets: async () => registry,
      openPositions: async () => [],
      setDepth: async (id, _samples, measuredAtMs) => {
        published.set(id, measuredAtMs);
        return `tx-${id}`;
      },
    });
    await runTick(chain, {
      sample: async (markets) => markets.map(({ id: market }) => ({
        market, measuredAtMs: NOW, samples: [{ size_usd: 10_000, impact_bps: 50 }],
      })),
    }, () => NOW);
    expect(published).toEqual(new Map(registry.map(({ id }) => [id, NOW])));
  });

  it("settles only overdue active funding, after both liquidation paths", async () => {
    const registry = [
      { ...market("DUE"), oi_short: USD, funding: { ...market("DUE").funding, last_accrual_ms: NOW - FUNDING_INTERVAL_MS - 1 } },
      { ...market("BOUNDARY"), oi_long: USD, funding: { ...market("BOUNDARY").funding, last_accrual_ms: NOW - FUNDING_INTERVAL_MS } },
      { ...market("IDLE"), funding: { ...market("IDLE").funding, last_accrual_ms: 0 } },
      { ...market("FRESH"), oi_long: USD },
    ];
    const chain = fakeChain({
      markets: async () => registry,
      openPositions: async () => [
        position(1, "DUE", 0n),
        { ...position(2, "DUE", 0n), margin_mode: "cross" },
      ],
      crossAccount: async (id) => crossHealth(id, { liquidatable: true }),
    });
    const summary = await runTick(chain, { sample: async () => [] }, () => NOW);
    expect(summary.ok && summary.funding).toEqual([{ market: "DUE", tx: "tx-funding-DUE" }]);
    expect(chain.calls).toEqual(["liquidate 1", "liquidate_cross trader.test", "settle_funding DUE"]);
  });

  it("continues liquidation scanning when the depth provider and order index are unavailable", async () => {
    const chain = fakeChain({ openOrders: async () => { throw new Error("orders RPC unavailable"); } });
    const summary = await runTick(chain, { sample: async () => { throw new Error("1Click offline"); } }, () => NOW);
    expect(summary).toMatchObject({
      errors: [{ step: "depth", error: "1Click offline" }, { step: "orders", error: "orders RPC unavailable" }],
      liquidations: [{ positionId: 3, tx: "tx-liq-3" }, { positionId: 1, tx: "tx-liq-1" }],
    });
  });

  it("never liquidates a cross leg individually; uses aggregate cash, freshness and account health once", async () => {
    const legs = ["healthy.test", "unhealthy.test", "stale.test"].flatMap((account_id, index) =>
      [1, 2].map((n) => ({ ...position(index * 10 + n, "NEAR", 0n), account_id, margin_mode: "cross" as const })));
    const liquidated = new Set<string>();
    const read: string[] = [];
    const chain = fakeChain({
      openPositions: async () => legs,
      crossAccount: async (id) => {
        read.push(id);
        return crossHealth(id, {
          cash: id === "healthy.test" ? 1_000n * USD : 0n,
          liquidatable: id !== "healthy.test",
          prices_fresh: id !== "stale.test",
        });
      },
      liquidate: async () => { throw new Error("cross legs must never reach isolated liquidation"); },
      liquidateCross: async (id) => { liquidated.add(id); return "tx-cross"; },
    });
    const summary = await runTick(chain, depthSource, () => NOW);
    expect(new Set(read)).toEqual(new Set(["healthy.test", "unhealthy.test", "stale.test"]));
    expect(read.length).toBe(3);
    expect(liquidated).toEqual(new Set(["unhealthy.test"]));
    expect(summary.ok && summary.liquidations).toEqual([]);
    expect(findLiquidatable(legs, [market("NEAR")], NOW)).toEqual([]);
  });

  it("rescans after fills and exits instead of liquidating a position already closed by its stop", async () => {
    let positions = [position(1, "NEAR", 0n)];
    const stop: Order = { id: 10, account_id: "trader.test", created_at_ms: NOW, request: { kind: "stop_loss", position_id: 1, trigger_price: 400_000_000n } };
    const liquidated: number[] = [];
    const chain = fakeChain({
      openOrders: async () => [stop, entry(11)],
      openPositions: async () => positions,
      executeOrders: async () => {
        positions = [position(2, "NEAR", 0n)];
        return { tx: "tx-fill", results: [
          { status: "filled", order_id: 10, position_id: 1, price: 400_000_000n },
          { status: "filled", order_id: 11, position_id: 2, price: 400_000_000n },
        ] };
      },
      liquidate: async (id) => { liquidated.push(id); return "tx-liq"; },
    });
    const summary = await runTick(chain, depthSource, () => NOW);
    expect(liquidated).toEqual([2]);
    expect(summary.ok && summary.scanned).toBe(1);
    expect(JSON.parse(JSON.stringify(summary)).orders[0].results[0].price).toBe("400000000");
  });

  it("does not reuse a pre-fill liquidation candidate when the post-fill position read fails", async () => {
    let closed = false;
    const stop: Order = { id: 10, account_id: "trader.test", created_at_ms: NOW,
      request: { kind: "stop_loss", position_id: 1, trigger_price: 400_000_000n } };
    const chain = fakeChain({
      openOrders: async () => [stop],
      openPositions: async () => {
        if (closed) throw new Error("position RPC unavailable");
        return [position(1, "NEAR", 0n)];
      },
      executeOrders: async () => {
        closed = true;
        return { tx: "tx-stop", results: [{ status: "filled", order_id: 10, position_id: 1, price: 400_000_000n }] };
      },
    });
    const summary = await runTick(chain, depthSource, () => NOW);
    expect(closed).toBe(true);
    expect(summary).toMatchObject({
      orders: [{ tx: "tx-stop" }], liquidations: [], crossLiquidations: [],
      errors: [{ step: "liquidation positions", error: "position RPC unavailable" }],
    });
    expect(chain.calls.filter((call) => call.startsWith("liquidate"))).toEqual([]);
  });

  it("bounds order gas and reports refunded rejections distinctly from OCO skips", async () => {
    const ids = Array.from({ length: ORDER_BATCH_SIZE * 2 + 1 }, (_, i) => i + 1);
    const executed: number[] = [];
    const sizes: number[] = [];
    const chain = fakeChain({
      openOrders: async () => ids.map((id) => entry(id)),
      executeOrders: async (batch) => {
        sizes.push(batch.length);
        executed.push(...batch);
        return { tx: "tx-orders", results: batch.map((order_id) => order_id === 1
          ? { status: "rejected" as const, order_id, reason: "ERR_EXCEEDS_EXIT_LIQUIDITY: cap 0" }
          : { status: "skipped" as const, order_id }) };
      },
    });
    const summary = await runTick(chain, depthSource, () => NOW);
    expect(executed).toEqual(ids);
    expect(sizes).toEqual([5, 5, 1]);
    expect(summary.ok && summary.orders[0]).toMatchObject({ results: [{ status: "rejected", order_id: 1 }, ...[2, 3, 4, 5].map((order_id) => ({ status: "skipped", order_id }))] });
  });

  it.each([null, NOW - SNAPSHOT_INTERVAL_MS, NOW - SNAPSHOT_INTERVAL_MS + 1])("takes hourly snapshots based on persisted time %s", async (last) => {
    let writes = 0;
    const chain = fakeChain({
      lastSnapshotMs: async () => last,
      snapshotVaults: async () => { writes++; return "tx-snapshot"; },
    });
    const summary = await runTick(chain, depthSource, () => NOW);
    const due = last === null || NOW - last >= SNAPSHOT_INTERVAL_MS;
    expect(writes).toBe(due ? 1 : 0);
    if (!due) expect(summary.ok && summary.snapshots).toEqual({ skipped: true, nextAtMs: NOW + 1 });
  });

  it("isolates failed depth, funding, oracle, order and snapshot steps without suppressing liquidations", async () => {
    let reads = 0;
    const chain = fakeChain({
      markets: async () => [{ ...market("NEAR", reads++ === 0 ? PRICE_REFRESH_INTERVAL_MS : 10_000), oi_long: USD,
        funding: { ...market("NEAR").funding, last_accrual_ms: NOW - FUNDING_INTERVAL_MS - 1 } }],
      setDepth: async () => { throw new Error("depth failed"); },
      settleFunding: async () => { throw new Error("funding failed"); },
      refreshPrices: async () => { throw new Error("oracle receipt failed"); },
      openOrders: async () => [entry(1)],
      executeOrders: async () => { throw new Error("order race"); },
      lastSnapshotMs: async () => null,
      snapshotVaults: async () => { throw new Error("snapshot race"); },
    });
    const summary = await runTick(chain, depthSource, () => NOW);
    expect(summary).toMatchObject({
      ok: true, depth: [{ error: "depth failed" }, { error: "1Click returned 503" }],
      funding: [{ market: "NEAR", error: "funding failed" }],
      prices: { fresh: 1, total: 1, error: "oracle receipt failed" },
      orders: [{ ids: [1], error: "order race" }], snapshots: { error: "snapshot race" },
    });
    expect(summary.ok && summary.liquidations.map((l) => l.positionId)).toEqual([3, 1]);
  });

  it("does not replace measurement time with publication time", async () => {
    let timestamp = 0;
    const chain = fakeChain({ setDepth: async (_id, _samples, at) => { timestamp = at; return "tx"; } });
    await runTick(chain, depthSource, () => NOW);
    expect(timestamp).toBe(NOW - 20_000);
  });
});
