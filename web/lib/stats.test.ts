import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoryEvent, HistoryKind, LeaderboardEntry, Market, Vault } from "./near/types";
import { DAY_MS } from "./near/volume";
import { collectStats, STATS_CACHE_MS, StatsCache, type StatsViews } from "./stats-server";
import { fetchStats, statsResponseSchema, type StatsResponse } from "./stats";

const NOW = 1_800_000_000_000;
const HUGE = 9_007_199_254_740_993n;

function market(overrides: Partial<Market> = {}): Market {
  return {
    id: "NEAR", oracle_asset_id: "near", intents_asset_id: "near", price_source: "signed",
    vault_id: "core", fee_bps: 10, max_leverage_cap: 5, hard_cap: 1n,
    exit_capacity: 10_000_000_000n, depth_measured_at_ms: NOW,
    oi_long: HUGE, oi_short: 7n, max_leverage: 5, price: 300_000_000n,
    price_timestamp_ms: NOW, borrow_index_long: 0n, borrow_index_short: 0n,
    last_accrual_ms: NOW, funding: { paid_index: [0n, 0n], received_index: [0n, 0n], last_accrual_ms: NOW },
    vault_backed_cap_usd: 1n, effective_max_oi_per_side: 1n, measured_cap_is_grid_max: false,
    close_only: false,
    max_oi_per_side: 1n, is_open: true, funding_rate_per_hour: 0n, ...overrides,
  };
}

function vault(id: Vault["id"], nav: bigint): Vault {
  return {
    id, nav, balance: nav + 100n, total_shares: 1n, share_price: 1n,
    reserved: 0n, available: 0n, cross_receivable: 0n, traders_unrealized_pnl: 0n,
    borrow_fees_due: 0n, funding_net_due: 0n, fees_7d: 0n, fee_apr_bps: 0,
    revenue: { fees: 0n, funding: 0n, trader_pnl: 0n, liquidations: 0n, listing: 0n },
  };
}

function event(kind: HistoryKind, size: bigint, at = NOW, sequence = 0): HistoryEvent {
  return {
    sequence, kind, position_id: 1, order_id: null, market_id: "NEAR", side: "long",
    price: 1n, size, pnl: 0n, realized_pnl: 0n, fees: 0n, funding_paid: 0n,
    funding_received: 0n, funding_payment: 0n, timestamp_ms: at,
  };
}

function views(histories: Record<string, HistoryEvent[]> = {}): StatsViews {
  return {
    markets: async () => [market()],
    vaults: async () => [vault("core", HUGE), vault("long-tail", 13n)],
    leaderboard: async () => Object.keys(histories).map((account_id): LeaderboardEntry => ({
      account_id, realized_pnl: 0n, volume: 0n, trades: 0, committed_margin: 0n, roi_bps: 0n,
    })),
    history: async (accountId) => histories[accountId],
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("onchain aggregate statistics", () => {
  it("counts entry/exit activity and active accounts without counting fills twice", async () => {
    const source = views({
      "alice.near": [
        event("open", 1n, NOW - DAY_MS - 1, 0),
        event("open", HUGE, NOW - DAY_MS, 1),
        event("order_fill", HUGE, NOW - DAY_MS, 2),
        event("funding", 999n, NOW - 1, 3),
        event("close", 7n, NOW, 4),
        event("open", 1n, NOW + 1, 5),
      ],
      "bob.near": [event("liquidation", 11n)],
      "carol.near": [event("deposit", 100n), event("withdrawal", 90n, NOW, 1)],
      "dave.near": [event("order_fill", 300n)],
    });
    expect(await collectStats(source, () => NOW)).toEqual({
      volume24h: (HUGE + 18n).toString(), trades24h: 3, traders24h: 2,
      totalOi: (HUGE + 7n).toString(), vaultTvl: (HUGE + 13n).toString(),
      marketsCount: 1, openMarketsCount: 1, fetchedAtMs: NOW,
      coverage: { complete: true, accountsScanned: 4, accountLimit: 500,
        eventsPerAccountLimit: 200, accountLimitReached: false, historyWindowIncomplete: false },
    });
  });

  it("requires fresh depth AND price, including exact age and liquidity boundaries", async () => {
    const source = views();
    source.markets = async () => [
      market({ id: "boundary", depth_measured_at_ms: NOW - 30 * 60_000, price_timestamp_ms: NOW - 30_000 }),
      market({ id: "old-depth", depth_measured_at_ms: NOW - 30 * 60_000 - 1 }),
      market({ id: "old-price", price_timestamp_ms: NOW - 30_001 }),
      market({ id: "no-price", price: 0n }),
      market({ id: "no-price-time", price_timestamp_ms: 0 }),
      market({ id: "no-depth", depth_measured_at_ms: 0 }),
      market({ id: "future-depth", depth_measured_at_ms: NOW + 1 }),
      market({ id: "future-price", price_timestamp_ms: NOW + 1 }),
      market({ id: "thin", exit_capacity: 9_999_999_999n }),
      market({ id: "closed", is_open: false }),
      market({ id: "close-only", close_only: true }),
    ];
    const result = await collectStats(source, () => NOW);
    expect(result.marketsCount).toBe(11);
    expect(result.openMarketsCount).toBe(1);
    expect(result.totalOi).toBe(((HUGE + 7n) * 11n).toString());
  });

  it("reports observed empty activity as zero only after reading valid sources", async () => {
    const source = views();
    source.markets = async () => [];
    expect(await collectStats(source, () => NOW)).toMatchObject({
      volume24h: "0", trades24h: 0, traders24h: 0, totalOi: "0",
      marketsCount: 0, openMarketsCount: 0, coverage: { complete: true, accountsScanned: 0 },
    });
  });

  it("flags full recent rings but not full rings extending before the window", async () => {
    const ring = Array.from({ length: 200 }, (_, index) => event("open", 1n, NOW - 200 + index, index));
    const source = views({ "alice.near": ring });
    expect(await collectStats(source, () => NOW)).toMatchObject({
      volume24h: "200", trades24h: 200, traders24h: 1,
      coverage: { complete: false, historyWindowIncomplete: true },
    });
    ring[0] = event("open", 1n, NOW - DAY_MS - 1, 0);
    expect(await collectStats(source, () => NOW)).toMatchObject({
      volume24h: "199", coverage: { complete: true, historyWindowIncomplete: false },
    });
    ring[0] = event("open", 1n, NOW - DAY_MS, 0);
    expect((await collectStats(source, () => NOW)).coverage.complete).toBe(false);
  });

  it("marks the 500-account index as a lower bound and bounds RPC history fanout", async () => {
    const histories = Object.fromEntries(Array.from({ length: 500 }, (_, index) =>
      [`trader${index}.near`, [event("close", 2n)]]));
    const source = views(histories);
    let active = 0;
    let peak = 0;
    source.history = async (accountId) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return histories[accountId];
    };
    expect(await collectStats(source, () => NOW)).toMatchObject({
      volume24h: "1000", trades24h: 500, traders24h: 500,
      coverage: { complete: false, accountsScanned: 500, accountLimitReached: true },
    });
    expect(peak).toBe(8);
  });

  it("propagates source outages instead of manufacturing partial zero aggregates", async () => {
    for (const method of ["markets", "vaults", "leaderboard", "history"] as const) {
      const source = views({ "alice.near": [event("open", 5n)] });
      source[method] = async () => { throw new Error("RPC unavailable"); };
      await expect(collectStats(source, () => NOW)).rejects.toThrow("RPC unavailable");
    }
  });

  it("rejects unknown fields, duplicate indexes, incomplete vaults and unordered histories", async () => {
    const missingVault = views();
    missingVault.vaults = async () => [vault("core", 1n)];
    await expect(collectStats(missingVault, () => NOW)).rejects.toThrow();
    const negativeOi = views();
    negativeOi.markets = async () => [market({ oi_long: -1n })];
    await expect(collectStats(negativeOi, () => NOW)).rejects.toThrow();
    const missingNav = views();
    missingNav.vaults = async () => [vault("core", undefined as unknown as bigint), vault("long-tail", 1n)];
    await expect(collectStats(missingNav, () => NOW)).rejects.toThrow();
    const duplicate = views({ "alice.near": [] });
    const leaderboard = duplicate.leaderboard;
    duplicate.leaderboard = async () => { const rows = await leaderboard("volume"); return [...rows, ...rows]; };
    await expect(collectStats(duplicate, () => NOW)).rejects.toThrow();
    await expect(collectStats(views({ "alice.near": [event("open", 5n), event("close", 5n)] }), () => NOW)).rejects.toThrow("Unordered");
    const badKind = event("open", 5n);
    badKind.kind = "unknown" as HistoryKind;
    await expect(collectStats(views({ "alice.near": [badKind] }), () => NOW)).rejects.toThrow();
  });
});

describe("shared aggregate cache", () => {
  it("shares concurrent computation and expires exactly at 60 seconds without retimestamping hits", async () => {
    let now = NOW;
    const source = views({ "alice.near": [event("open", 5n)] });
    const { promise, resolve } = Promise.withResolvers<void>();
    const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
    source.history = async () => { markStarted(); await promise; return [event("open", 5n)]; };
    const load = vi.fn(() => collectStats(source, () => now));
    const cache = new StatsCache(load, () => now);
    const first = cache.get();
    const second = cache.get();
    expect(first).toBe(second);
    await started;
    resolve();
    const original = await first;
    expect(load).toHaveBeenCalledTimes(1);
    now += STATS_CACHE_MS - 1;
    expect(await cache.get()).toBe(original);
    expect((await cache.get()).fetchedAtMs).toBe(NOW);
    now += 1;
    const refreshed = await cache.get();
    expect(load).toHaveBeenCalledTimes(2);
    expect(refreshed.fetchedAtMs).toBe(now);
    expect(refreshed.volume24h).toBe("5");
  });

  it("does not cache failures or serve expired success when a refresh fails", async () => {
    let now = NOW;
    const source = views({ "alice.near": [event("open", 5n)] });
    const cache = new StatsCache(() => collectStats(source, () => now), () => now);
    await cache.get();
    now += STATS_CACHE_MS;
    source.history = async () => { throw new Error("history unavailable"); };
    await expect(cache.get()).rejects.toThrow("history unavailable");
    source.history = async () => [event("close", 7n)];
    expect(await cache.get()).toMatchObject({ volume24h: "7", fetchedAtMs: now });
  });

  it("keeps failed batches single-flight until their remaining RPC calls settle", async () => {
    const source = views({ "alice.near": [], "bob.near": [] });
    const { promise, resolve } = Promise.withResolvers<void>();
    const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
    source.history = async (accountId) => {
      if (accountId === "alice.near") throw new Error("history unavailable");
      markStarted();
      await promise;
      return [];
    };
    const load = vi.fn(() => collectStats(source, () => NOW));
    const cache = new StatsCache(load, () => NOW);
    const first = cache.get();
    await started;
    expect(cache.get()).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    const failure = expect(first).rejects.toThrow("history unavailable");
    resolve();
    await failure;
  });

  it("releases single-flight even if a loader throws synchronously", async () => {
    const source = views();
    const load = vi.fn((): Promise<StatsResponse> => { throw new Error("configuration unavailable"); });
    const cache = new StatsCache(load, () => NOW);
    await expect(cache.get()).rejects.toThrow("configuration unavailable");
    load.mockImplementation(() => collectStats(source, () => NOW));
    expect((await cache.get()).coverage.complete).toBe(true);
  });
});

describe("validated browser statistics", () => {
  it("rejects missing/invalid monetary and count fields rather than treating them as zero", async () => {
    const valid = await collectStats(views(), () => NOW);
    for (const change of [
      { volume24h: null }, { totalOi: 123 }, { vaultTvl: "1e6" }, { volume24h: "-1" },
      { trades24h: -1 }, { traders24h: 1 }, { openMarketsCount: 2 }, { fetchedAtMs: 0 },
      { coverage: { ...valid.coverage, complete: false } },
    ]) {
      expect(statsResponseSchema.safeParse({ ...valid, ...change }).success).toBe(false);
    }
    expect(statsResponseSchema.safeParse({ ...valid, volume24h: undefined }).success).toBe(false);
  });

  it("rejects unavailable or malformed endpoint data, preserving the server timestamp on success", async () => {
    const valid = await collectStats(views(), () => NOW);
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    fetch.mockResolvedValueOnce(Response.json({ ...valid, trades24h: "0" }));
    await expect(fetchStats()).rejects.toThrow();
    fetch.mockResolvedValueOnce(Response.json({ error: "upstream details" }, { status: 502 }));
    await expect(fetchStats()).rejects.toThrow("Onchain statistics unavailable");
    fetch.mockResolvedValueOnce(Response.json(valid));
    expect((await fetchStats()).fetchedAtMs).toBe(NOW);
  });
});
