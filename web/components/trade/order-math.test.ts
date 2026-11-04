import { describe, expect, it } from "vitest";
import type { Market } from "@/lib/near/types";
import { borrowRatePerHour, capRoom, previewOrder, tradeFee } from "./order-math";

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
    is_open: true,
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
