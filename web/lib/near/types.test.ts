import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  accountSchema,
  accountStatsSchema,
  crossAccountSchema,
  depthViewSchema,
  historyEventSchema,
  isLiquidatable,
  isMeasuring,
  leaderboardEntrySchema,
  liquidationSchema,
  marketSchema,
  orderSchema,
  positionSchema,
  priceSchema,
  vaultAccountSchema,
  vaultSchema,
  vaultSnapshotSchema,
} from "./types";

// Shapes follow view responses captured from the contract on a local sandbox; some values vary them.
const market = {
  id: "ETH",
  oracle_asset_id: "aurora",
  intents_asset_id: "nep141:eth.omft.near",
  price_source: "tee",
  vault_id: "core",
  fee_bps: 10,
  max_leverage_cap: 20,
  hard_cap: "500000000000",
  exit_capacity: "100000000000",
  depth_measured_at_ms: 1793816871830,
  oi_long: "0",
  oi_short: "0",
  max_leverage: 5,
  price: "229259500000",
  price_timestamp_ms: 1793816880818,
  borrow_index_long: "423723",
  borrow_index_short: "423723",
  last_accrual_ms: 1793816873202,
  funding: { paid_index: ["0", "0"], received_index: ["0", "0"], last_accrual_ms: 1793816873202 },
  max_oi_per_side: "100000000000",
  is_open: true,
  funding_rate_per_hour: "-500000000",
};

const position = {
  id: 1,
  account_id: "trader.sandbox",
  market_id: "NEAR",
  side: "short",
  margin_mode: "cross",
  margin: "19940000",
  size: "60000000",
  entry_price: "400000000",
  leverage: 3,
  max_leverage: 5,
  opened_at_ms: 1793816882762,
  mark_price: "400000000",
  mark_price_timestamp_ms: 1793816880818,
  unrealized_pnl: "-17355916",
  borrow_fee: "1",
  close_fee: "60000",
  funding_paid: "0",
  funding_received: "5",
  funding_payment: "-5",
  equity: "19940004",
  maintenance_margin: "6000000",
  liquidation_price: "0",
  take_profit: 2,
  stop_loss: null,
};

const revenue = { fees: "260001", funding: "-16", trader_pnl: "0", liquidations: "0", listing: "5000000" };

describe("market and position schemas", () => {
  it("parses U128/I128 strings to bigint, signed funding rate included", () => {
    const parsed = marketSchema.parse(market);
    expect(parsed.price).toBe(229_259_500_000n);
    expect(parsed.funding_rate_per_hour).toBe(-500_000_000n);
    expect(parsed.funding.paid_index).toEqual([0n, 0n]);
    expect(parsed.vault_id).toBe("core");
  });

  it("accepts listed market ids and the worker price source", () => {
    const listed = marketSchema.parse({ ...market, id: "PEPE", vault_id: "long-tail", price_source: "outlayer_worker" });
    expect(listed.id).toBe("PEPE");
    expect(positionSchema.parse({ ...position, market_id: "PEPE" }).market_id).toBe("PEPE");
    expect(
      priceSchema.parse({ market_id: "PEPE", oracle_asset_id: "PEPE", price: "100", timestamp_ms: 1, is_fresh: true })
        .market_id,
    ).toBe("PEPE");
  });

  it("flags a market as measuring until its first depth sample", () => {
    expect(isMeasuring(marketSchema.parse({ ...market, depth_measured_at_ms: 0 }))).toBe(true);
    expect(isMeasuring(marketSchema.parse(market))).toBe(false);
  });

  it("parses a cross position with funding credit and brackets", () => {
    const parsed = positionSchema.parse(position);
    expect(parsed.margin_mode).toBe("cross");
    expect(parsed.unrealized_pnl).toBe(-17_355_916n);
    expect(parsed.funding_payment).toBe(-5n);
    expect(parsed.take_profit).toBe(2);
    expect(parsed.stop_loss).toBeNull();
    expect(isLiquidatable(parsed)).toBe(false);
    expect(isLiquidatable({ ...parsed, equity: parsed.maintenance_margin })).toBe(true);
  });

  it("rejects numbers where the contract sends U128 strings", () => {
    expect(marketSchema.safeParse({ ...market, price: 97123 }).success).toBe(false);
    expect(positionSchema.safeParse({ ...position, margin: "-1" }).success).toBe(false);
    expect(marketSchema.safeParse({ ...market, vault_id: "long_tail" }).success).toBe(false);
  });
});

describe("order schemas", () => {
  it("parses entry orders with brackets and exit orders by kind", () => {
    const orders = z.array(orderSchema).parse([
      {
        id: 3,
        account_id: "trader.sandbox",
        request: {
          kind: "limit",
          market_id: "NEAR",
          side: "long",
          margin: "10000000",
          leverage: 2,
          trigger_price: "133333333",
          brackets: { take_profit: null, stop_loss: "100000000" },
          margin_mode: "isolated",
        },
        created_at_ms: 1793816883516,
      },
      {
        id: 2,
        account_id: "trader.sandbox",
        request: { kind: "take_profit", position_id: 1, trigger_price: "200000000" },
        created_at_ms: 1793816883147,
      },
    ]);
    const [limit, takeProfit] = orders.map((order) => order.request);
    expect(limit.kind === "limit" && limit.brackets?.stop_loss).toBe(100_000_000n);
    expect(takeProfit.kind === "take_profit" && takeProfit.position_id).toBe(1);
  });

  it("rejects an unknown order kind", () => {
    const request = { kind: "trailing_stop", position_id: 1, trigger_price: "1" };
    expect(orderSchema.safeParse({ id: 1, account_id: "a", request, created_at_ms: 1 }).success).toBe(false);
  });
});

describe("vault schemas", () => {
  it("keeps U128 values beyond 2^53 exact and parses signed revenue", () => {
    const parsed = vaultSchema.parse({
      id: "long-tail",
      balance: "340282366920938463463374607431768211455",
      nav: "10055000000",
      total_shares: "10050000000",
      share_price: "1000497",
      reserved: "0",
      available: "10055000000",
      cross_receivable: "0",
      traders_unrealized_pnl: "-2500000",
      borrow_fees_due: "0",
      funding_net_due: "-16",
      fees_7d: "5000000",
      fee_apr_bps: 259,
      revenue,
    });
    expect(parsed.balance).toBe(2n ** 128n - 1n);
    expect(parsed.traders_unrealized_pnl).toBe(-2_500_000n);
    expect(parsed.revenue.funding).toBe(-16n);
  });

  it("parses snapshots and per-vault shares", () => {
    const snapshot = vaultSnapshotSchema.parse({
      timestamp_ms: 1793816889433,
      nav: "10000260041",
      share_price: "1000026",
      tvl: "10000260017",
      revenue,
    });
    expect(snapshot.revenue.listing).toBe(5_000_000n);
    const shares = vaultAccountSchema.parse({
      vault_id: "long-tail",
      account_id: "trader.sandbox",
      shares: "50000000",
      value: "50024875",
    });
    expect(shares.value).toBe(50_024_875n);
  });
});

describe("account views", () => {
  it("parses margin with reserved margin, and null before the first deposit", () => {
    expect(accountSchema.nullable().parse(null)).toBeNull();
    const account = accountSchema.parse({ account_id: "trader.sandbox", margin: "516000000", reserved_margin: "10000000" });
    expect(account.reserved_margin).toBe(10_000_000n);
  });

  it("parses cross health, null once no cross position remains", () => {
    const cross = {
      account_id: "trader.sandbox",
      cash: "-4000000",
      equity: "73839988",
      maintenance_margin: "16000000",
      health_bps: "46149",
      position_count: 2,
      prices_fresh: true,
      liquidatable: false,
      debt_by_vault: ["4000000", "0"],
    };
    const parsed = crossAccountSchema.parse(cross);
    expect(parsed.cash).toBe(-4_000_000n);
    expect(parsed.health_bps).toBe(46_149n);
    expect(parsed.debt_by_vault).toEqual([4_000_000n, 0n]);
    expect(crossAccountSchema.parse({ ...cross, health_bps: null, position_count: 0 }).health_bps).toBeNull();
  });

  it("parses history events, stats and leaderboard rows", () => {
    const rawEvent = {
      sequence: 3,
      kind: "close",
      position_id: 0,
      order_id: null,
      market_id: "NEAR",
      side: "long",
      price: "400000000",
      size: "100000000",
      pnl: "0",
      realized_pnl: "-100017",
      fees: "100001",
      funding_paid: "16",
      funding_received: "0",
      funding_payment: "16",
      timestamp_ms: 1793816885788,
    };
    const event = historyEventSchema.parse(rawEvent);
    expect(event.realized_pnl).toBe(-100_017n);
    expect(historyEventSchema.safeParse({ ...rawEvent, kind: "unknown" }).success).toBe(false);
    for (const kind of ["deposit", "withdrawal"]) {
      const transfer = historyEventSchema.parse({
        ...rawEvent,
        kind,
        market_id: "USDC",
        price: "0",
        size: "25000000",
        realized_pnl: "0",
        fees: "0",
        funding_paid: "0",
        funding_payment: "0",
      });
      expect(transfer.kind).toBe(kind);
      expect(transfer.size).toBe(25_000_000n);
      expect(transfer.realized_pnl).toBe(0n);
    }

    const stats = accountStatsSchema.nullable().parse({
      realized_pnl: "-260017",
      volume: "260000000",
      trades: 3,
      committed_margin: "70000000",
      event_count: 4,
    });
    expect(stats?.volume).toBe(260_000_000n);
    expect(accountStatsSchema.nullable().parse(null)).toBeNull();

    const row = leaderboardEntrySchema.parse({
      account_id: "trader.sandbox",
      realized_pnl: "-260017",
      volume: "260000000",
      trades: 3,
      committed_margin: "70000000",
      roi_bps: "-37",
    });
    expect(row.roi_bps).toBe(-37n);
  });
});

describe("depth and liquidation views", () => {
  it("keeps a null impact for sizes without liquidity", () => {
    const depth = depthViewSchema.parse({
      market,
      history: [
        {
          measured_at_ms: 1793721000000,
          exit_capacity_usd: 2500000,
          max_leverage: 20,
          samples: [
            { size_usd: 10000, impact_bps: 3 },
            { size_usd: 5000000, impact_bps: null },
          ],
        },
      ],
    });
    expect(depth.history[0].samples[1].impact_bps).toBeNull();
  });

  it("parses a liquidation with negative equity and funding", () => {
    const liquidation = liquidationSchema.parse({
      position_id: 3,
      account_id: "bob.testnet",
      market_id: "ZEC",
      side: "long",
      size: "500000000",
      entry_price: "5500000000",
      price: "5000000000",
      equity: "-1200000",
      funding_paid: "120",
      funding_received: "0",
      funding_payment: "120",
      penalty: "0",
      reward: "0",
      returned: "0",
      liquidator: "keeper.ketos.testnet",
      timestamp_ms: 1793721060000,
    });
    expect(liquidation.equity).toBe(-1_200_000n);
    expect(liquidation.funding_payment).toBe(120n);
  });
});
