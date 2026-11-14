import { describe, expect, it } from "vitest";
import type { Market } from "@/lib/near/types";
import {
  borrowRatePerHour,
  bracketError,
  bracketPriceFromMove,
  capRoom,
  entryTriggered,
  previewOrder,
  tradeFee,
  measuredImpactFee,
} from "./order-math";

const USD = 1_000_000n;
const PRICE = 100_000_000n;

function market(overrides: Partial<Market> = {}): Market {
  return {
    id: "NEAR",
    oracle_asset_id: "wrap.near",
    intents_asset_id: "nep141:wrap.near",
    price_source: "tee",
    vault_id: "core",
    fee_bps: 10,
    max_leverage_cap: 20,
    hard_cap: 500_000n * USD,
    exit_capacity: 100_000n * USD,
    depth_measured_at_ms: 0,
    oi_long: 0n,
    oi_short: 0n,
    max_leverage: 5,
    price: 4n * PRICE,
    price_timestamp_ms: 0,
    borrow_index_long: 0n,
    borrow_index_short: 0n,
    last_accrual_ms: 0,
    funding: { paid_index: [0n, 0n], received_index: [0n, 0n], last_accrual_ms: 0 },
    max_oi_per_side: 100_000n * USD,
    vault_backed_cap_usd: 100_000n * USD,
    effective_max_oi_per_side: 100_000n * USD,
    measured_cap_is_grid_max: false,
    close_only: false,
    is_open: true,
    isolated_only: false, launch_state: null,
    funding_rate_per_hour: 0n,
    ...overrides,
  };
}

describe("previewOrder", () => {
  it("prices a 5x long net of the opening fee, like get_position right after open", () => {
    const preview = previewOrder(market(), "long", 100n * USD, 5);
    expect(preview.size).toBe(500n * USD);
    expect(preview.openFee).toBe(500_000n);
    expect(preview.maintenance).toBe(50n * USD);
    // buffer 99.5 - 50 = 49.5 USDC over a 500 USDC notional: 9.9% below 4.00.
    expect(preview.liquidationPrice).toBe(360_400_000n);
  });

  it("puts a short's liquidation above entry", () => {
    expect(previewOrder(market(), "short", 100n * USD, 5).liquidationPrice).toBe(439_600_000n);
  });

  it("flags orders over the remaining cap of their side only", () => {
    const m = market({ oi_short: 95_000n * USD });
    const short = previewOrder(m, "short", 2_000n * USD, 5);
    expect(short.capRoom).toBe(5_000n * USD);
    expect(short.exceedsCap).toBe(true);
    expect(previewOrder(m, "long", 2_000n * USD, 5).exceedsCap).toBe(false);
  });

  it("limits new exposure by vault capital even when measured exit liquidity is deeper", () => {
    const m = { ...market({ oi_long: 19_000n * USD }), effective_max_oi_per_side: 20_000n * USD };
    const preview = previewOrder(m, "long", 300n * USD, 5);
    expect(preview.capRoom).toBe(1_000n * USD);
    expect(preview.exceedsCap).toBe(true);
    expect(capRoom({ ...m, oi_long: 21_000n * USD }, "long")).toBe(0n);
  });
});

describe("measured execution estimates", () => {
  it("interpolates impact at micro-USDC precision and includes it in liquidation", () => {
    const fee = measuredImpactFee(150n * USD, [{ size_usd: 100, impact_bps: 20 }, { size_usd: 200, impact_bps: 60 }]);
    expect(fee).toBe(600_000n);
    const preview = previewOrder(market({ fee_bps: 20 }), "long", 30n * USD, 5, 4n * PRICE, fee);
    expect(preview.openFee).toBe(900_000n);
    expect(preview.positionMargin).toBe(29_100_000n);
    expect(preview.liquidationPrice).toBe(362_400_000n);
  });

  it("never interpolates across a missing quote or understates a descending legacy curve", () => {
    expect(measuredImpactFee(150n * USD, [{ size_usd: 100, impact_bps: 20 }, { size_usd: 200, impact_bps: null }, { size_usd: 300, impact_bps: 30 }])).toBe(1_500_000n);
    expect(measuredImpactFee(150n * USD, [{ size_usd: 100, impact_bps: 200 }, { size_usd: 200, impact_bps: 10 }])).toBe(3_000_000n);
    expect(measuredImpactFee(1n, [])).toBe(1n);
  });
});

describe("contract formulas", () => {
  it("rounds the trade fee up", () => {
    expect(tradeFee(1n)).toBe(1n);
    expect(tradeFee(1_000n * USD)).toBe(1n * USD);
  });

  it("saturates the borrow slope at full utilization", () => {
    expect(borrowRatePerHour(0n, 100n)).toBe(10_000_000n);
    expect(borrowRatePerHour(50n, 100n)).toBe(55_000_000n);
    expect(borrowRatePerHour(150n, 100n)).toBe(100_000_000n);
  });

  it("never reports negative room", () => {
    expect(capRoom(market({ oi_long: 200_000n * USD }), "long")).toBe(0n);
  });
});

describe("entry and bracket triggers match the contract", () => {
  const p = 4n * PRICE;

  it("fills a long Limit at or below its price and a long Stop Market at or above", () => {
    expect(entryTriggered("limit", "long", p, p)).toBe(true);
    expect(entryTriggered("limit", "long", p, p + 1n)).toBe(false);
    expect(entryTriggered("stop_market", "long", p, p)).toBe(true);
    expect(entryTriggered("stop_market", "long", p, p - 1n)).toBe(false);
  });

  it("mirrors both entry kinds for shorts", () => {
    expect(entryTriggered("limit", "short", p, p + 1n)).toBe(true);
    expect(entryTriggered("limit", "short", p, p - 1n)).toBe(false);
    expect(entryTriggered("stop_market", "short", p, p - 1n)).toBe(true);
    expect(entryTriggered("stop_market", "short", p, p + 1n)).toBe(false);
  });

  it("refuses a take profit or stop loss at the entry price itself", () => {
    expect(bracketError("long", "take_profit", p, p)).not.toBeNull();
    expect(bracketError("long", "take_profit", p, p + 1n)).toBeNull();
    expect(bracketError("long", "stop_loss", p, p)).not.toBeNull();
    expect(bracketError("long", "stop_loss", p, p - 1n)).toBeNull();
    expect(bracketError("short", "take_profit", p, p - 1n)).toBeNull();
    expect(bracketError("short", "stop_loss", p, p + 1n)).toBeNull();
    expect(bracketError("short", "stop_loss", p, p - 1n)).not.toBeNull();
  });

  it("turns a percent move into a price on the right side", () => {
    expect(bracketPriceFromMove("long", "take_profit", p, 1_000n)).toBe(440_000_000n);
    expect(bracketPriceFromMove("long", "stop_loss", p, 500n)).toBe(380_000_000n);
    expect(bracketPriceFromMove("short", "take_profit", p, 1_000n)).toBe(360_000_000n);
    expect(bracketPriceFromMove("short", "stop_loss", p, 2_500n)).toBe(500_000_000n);
    expect(bracketPriceFromMove("long", "stop_loss", p, 10_000n)).toBeNull();
  });
});
