import { describe, expect, it } from "vitest";
import type { CrossAccount, HistoryEvent, Position } from "@/lib/near/types";
import { cumulativePnl, portfolioTotals } from "./portfolio-math";

const USD = 1_000_000n;

function position(overrides: Partial<Position> = {}): Position {
  return {
    id: 1,
    account_id: "trader.near",
    market_id: "NEAR",
    side: "long",
    margin_mode: "isolated",
    margin: 100n * USD,
    size: 500n * USD,
    entry_price: 400_000_000n,
    leverage: 5,
    max_leverage: 10,
    opened_at_ms: 1000,
    mark_price: 400_000_000n,
    mark_price_timestamp_ms: 1000,
    unrealized_pnl: 0n,
    borrow_fee: 0n,
    close_fee: 0n,
    funding_paid: 0n,
    funding_received: 0n,
    funding_payment: 0n,
    equity: 100n * USD,
    maintenance_margin: 50n * USD,
    liquidation_price: 360_000_000n,
    take_profit: null,
    stop_loss: null,
    ...overrides,
  };
}

function cross(overrides: Partial<CrossAccount> = {}): CrossAccount {
  return {
    account_id: "trader.near",
    cash: 0n,
    equity: 0n,
    maintenance_margin: 0n,
    health_bps: null,
    position_count: 0,
    prices_fresh: true,
    liquidatable: false,
    debt_by_vault: [0n, 0n],
    ...overrides,
  };
}

function event(overrides: Partial<HistoryEvent> = {}): HistoryEvent {
  return {
    sequence: 1,
    kind: "open",
    position_id: 1,
    order_id: null,
    market_id: "NEAR",
    side: "long",
    price: 400_000_000n,
    size: 500n * USD,
    pnl: 0n,
    realized_pnl: 0n,
    fees: 0n,
    funding_paid: 0n,
    funding_received: 0n,
    funding_payment: 0n,
    timestamp_ms: 1000,
    ...overrides,
  };
}

describe("portfolioTotals", () => {
  it("counts cross account equity once and keeps unrealized price PnL gross of funding", () => {
    const totals = portfolioTotals({
      freeMargin: 20n * USD,
      reservedMargin: 10n * USD,
      positions: [
        position({
          equity: 110n * USD,
          unrealized_pnl: 20n * USD,
          borrow_fee: 3n * USD,
          close_fee: 2n * USD,
          funding_paid: 5n * USD,
          funding_payment: 5n * USD,
        }),
        position({ id: 2, margin_mode: "cross", margin: 0n, equity: 40n * USD, unrealized_pnl: 40n * USD }),
        position({ id: 3, margin_mode: "cross", margin: 0n, equity: -10n * USD, unrealized_pnl: -10n * USD }),
      ],
      cross: cross({ cash: -12n * USD, equity: 18n * USD, position_count: 2 }),
      vaultValues: [7n * USD, 8n * USD],
    });
    expect(totals).toEqual({
      tradingEquity: 158n * USD,
      totalEquity: 173n * USD,
      unrealizedPnl: 50n * USD,
    });
  });

  it("preserves negative isolated equity and negative cross cash even without cross legs", () => {
    expect(portfolioTotals({
      freeMargin: 10n * USD,
      reservedMargin: 0n,
      positions: [position({ margin: 10n * USD, equity: -7n * USD, unrealized_pnl: -17n * USD })],
      cross: cross({ cash: -25n * USD, equity: -25n * USD }),
      vaultValues: [40n * USD],
    })).toEqual({
      tradingEquity: -22n * USD,
      totalEquity: 18n * USD,
      unrealizedPnl: -17n * USD,
    });
  });

  it("includes reserved entry margin and all vault values without open positions", () => {
    expect(portfolioTotals({
      freeMargin: 7n * USD,
      reservedMargin: 23n * USD,
      positions: [],
      cross: cross(),
      vaultValues: [31n * USD, 0n, 41n * USD],
    })).toEqual({ tradingEquity: 30n * USD, totalEquity: 102n * USD, unrealizedPnl: 0n });
  });

  it("returns exact zeros for an empty account", () => {
    expect(portfolioTotals({
      freeMargin: 0n,
      reservedMargin: 0n,
      positions: [],
      cross: cross(),
      vaultValues: [],
    })).toEqual({ tradingEquity: 0n, totalEquity: 0n, unrealizedPnl: 0n });
  });
});

describe("cumulativePnl", () => {
  it("books execution rewards separately from trading fees and counts settled funding once", () => {
    const events = [
      event({ realized_pnl: -2n * USD, fees: 2n * USD }),
      event({ sequence: 2, kind: "order_fill", order_id: 1, realized_pnl: -2n * USD }),
      event({ sequence: 3, kind: "funding", realized_pnl: -9n * USD, funding_paid: 9n * USD }),
      event({
        sequence: 4,
        kind: "reduce",
        timestamp_ms: 2000,
        pnl: 20n * USD,
        realized_pnl: 7n * USD,
        fees: 4n * USD,
        funding_paid: 9n * USD,
        funding_payment: 9n * USD,
      }),
      event({
        sequence: 5,
        kind: "liquidation",
        timestamp_ms: 3000,
        pnl: -5n * USD,
        realized_pnl: -8n * USD,
        fees: 1n * USD,
        funding_paid: 2n * USD,
        funding_payment: 2n * USD,
      }),
    ];
    expect(cumulativePnl(events, -5n * USD)).toEqual([
      { timestampMs: 1000, value: -4n * USD, sequence: 2 },
      { timestampMs: 2000, value: 3n * USD, sequence: 4 },
      { timestampMs: 3000, value: -5n * USD, sequence: 5 },
    ]);
  });

  it("anchors a truncated ring to the all-time aggregate without a fabricated baseline timestamp", () => {
    expect(cumulativePnl([
      event({ sequence: 151, timestamp_ms: 5000, realized_pnl: -1n * USD }),
      event({ sequence: 160, kind: "close", timestamp_ms: 9000, realized_pnl: 4n * USD }),
    ], 103n * USD)).toEqual([
      { timestampMs: 5000, value: 99n * USD, sequence: 151 },
      { timestampMs: 9000, value: 103n * USD, sequence: 160 },
    ]);
  });

  it("sorts unordered input by sequence without mutating its source", () => {
    const events = Object.freeze([
      event({ sequence: 3, kind: "close", timestamp_ms: 3000, realized_pnl: 4n * USD }),
      event({ sequence: 1, timestamp_ms: 1000, realized_pnl: -2n * USD }),
      event({ sequence: 2, kind: "close", timestamp_ms: 2000, realized_pnl: 1n * USD }),
    ]);
    expect(cumulativePnl(events, 3n * USD)).toEqual([
      { timestampMs: 1000, value: -2n * USD, sequence: 1 },
      { timestampMs: 2000, value: -1n * USD, sequence: 2 },
      { timestampMs: 3000, value: 3n * USD, sequence: 3 },
    ]);
    expect(events.map((entry) => entry.sequence)).toEqual([3, 1, 2]);
  });

  it("groups one chain timestamp at the final cumulative result and last sequence", () => {
    expect(cumulativePnl([
      event({ sequence: 4, kind: "liquidation", timestamp_ms: 2000, realized_pnl: -1n * USD }),
      event({ sequence: 2, kind: "close", timestamp_ms: 1000, realized_pnl: 3n * USD }),
      event({ sequence: 1, timestamp_ms: 1000, realized_pnl: -1n * USD }),
      event({ sequence: 3, kind: "order_fill", timestamp_ms: 1000, realized_pnl: -1n * USD }),
    ], 0n)).toEqual([
      { timestampMs: 1000, value: 1n * USD, sequence: 3 },
      { timestampMs: 2000, value: 0n, sequence: 4 },
    ]);
  });

  it("counts a repeated sequence only once", () => {
    const open = event({ realized_pnl: -1n * USD });
    const close = event({ sequence: 2, kind: "close", timestamp_ms: 2000, realized_pnl: 4n * USD });
    expect(cumulativePnl([close, open, { ...open }, { ...close }], 3n * USD)).toEqual([
      { timestampMs: 1000, value: -1n * USD, sequence: 1 },
      { timestampMs: 2000, value: 3n * USD, sequence: 2 },
    ]);
  });

  it("excludes transfers and funding annotations even when they carry nonzero deltas", () => {
    expect(cumulativePnl([
      event({ kind: "deposit", size: 100n * USD, realized_pnl: 100n * USD }),
      event({ sequence: 2, kind: "withdrawal", size: 50n * USD, realized_pnl: -50n * USD }),
      event({ sequence: 3, kind: "funding", realized_pnl: 9n * USD }),
    ], 25n * USD)).toEqual([]);
  });

  it("does not invent observations for an empty ring or a single trading event", () => {
    expect(cumulativePnl([], 0n)).toEqual([]);
    expect(cumulativePnl([], 123n * USD)).toEqual([]);
    expect(cumulativePnl([event({ realized_pnl: -1n * USD })], 123n * USD)).toEqual([
      { timestampMs: 1000, value: 123n * USD, sequence: 1 },
    ]);
  });

  it("keeps exact bigint deltas and finishes at a negative all-time total", () => {
    const total = -9_007_199_254_740_993_123n;
    expect(cumulativePnl([
      event({ realized_pnl: -1n }),
      event({ sequence: 2, kind: "close", timestamp_ms: 2000, realized_pnl: 3n }),
    ], total)).toEqual([
      { timestampMs: 1000, value: total - 3n, sequence: 1 },
      { timestampMs: 2000, value: total, sequence: 2 },
    ]);
  });
});
