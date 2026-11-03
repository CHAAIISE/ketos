import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  accountSchema,
  depthViewSchema,
  isLiquidatable,
  liquidationSchema,
  marketSchema,
  positionSchema,
  priceSchema,
  vaultAccountSchema,
  vaultSchema,
} from "./types";

const market = {
  id: "BTC",
  oracle_asset_id: "wrap.testnet",
  hard_cap: "5000000000000",
  exit_capacity: "2500000000000",
  depth_measured_at_ms: 1793721000000,
  oi_long: "120000000000",
  oi_short: "45000000000",
  max_leverage: 20,
  price: "9712345678901",
  price_timestamp_ms: 1793721060000,
  borrow_index_long: "1000123456789",
  borrow_index_short: "1000000000000",
  last_accrual_ms: 1793721060000,
  max_oi_per_side: "1250000000000",
  is_open: true,
};

const position = {
  id: 7,
  account_id: "alice.testnet",
  market_id: "ETH",
  side: "short",
  margin: "99900000",
  size: "1000000000",
  entry_price: "345012000000",
  leverage: 10,
  max_leverage: 25,
  opened_at_ms: 1793720000000,
  mark_price: "351000000000",
  mark_price_timestamp_ms: 1793721060000,
  unrealized_pnl: "-17355916",
  borrow_fee: "4210",
  close_fee: "1000000",
  equity: "81539874",
  maintenance_margin: "20000000",
  liquidation_price: "406123456789",
};

describe("perps view schemas", () => {
  it("parses a market with U128 strings to bigint", () => {
    const parsed = marketSchema.parse(market);
    expect(parsed.price).toBe(9712345678901n);
    expect(parsed.max_oi_per_side).toBe(1_250_000_000_000n);
    expect(parsed.is_open).toBe(true);
  });

  it("parses a position with a negative I128 pnl", () => {
    const parsed = positionSchema.parse(position);
    expect(parsed.side).toBe("short");
    expect(parsed.unrealized_pnl).toBe(-17_355_916n);
    expect(parsed.equity).toBe(81_539_874n);
    expect(isLiquidatable(parsed)).toBe(false);
    expect(isLiquidatable({ ...parsed, equity: parsed.maintenance_margin })).toBe(true);
  });

  it("keeps U128 values beyond 2^53 exact", () => {
    const parsed = vaultSchema.parse({
      balance: "340282366920938463463374607431768211455",
      nav: "1000000000000",
      total_shares: "999000000000",
      share_price: "1001001",
      reserved: "165000000000",
      available: "835000000000",
      traders_unrealized_pnl: "-2500000",
      borrow_fees_due: "120000",
      fees_7d: "42000000",
      fee_apr_bps: 1234,
    });
    expect(parsed.balance).toBe(2n ** 128n - 1n);
    expect(parsed.traders_unrealized_pnl).toBe(-2_500_000n);
  });

  it("rejects numbers where the contract sends U128 strings", () => {
    expect(marketSchema.safeParse({ ...market, price: 97123 }).success).toBe(false);
    expect(positionSchema.safeParse({ ...position, margin: "-1" }).success).toBe(false);
    expect(positionSchema.safeParse({ ...position, market_id: "DOGE" }).success).toBe(false);
  });

  it("parses the remaining views", () => {
    expect(accountSchema.nullable().parse(null)).toBeNull();
    expect(accountSchema.parse({ account_id: "alice.testnet", margin: "5000000" }).margin).toBe(5_000_000n);
    expect(
      vaultAccountSchema.parse({ account_id: "alice.testnet", shares: "0", value: "0" }).shares,
    ).toBe(0n);

    const depth = depthViewSchema.parse({
      market,
      history: [
        {
          measured_at_ms: 1793721000000,
          exit_capacity_usd: 2500000,
          max_leverage: 20,
          samples: [
            { size_usd: 10000, impact_bps: 3.2 },
            { size_usd: 5000000, impact_bps: null },
          ],
        },
      ],
    });
    expect(depth.history[0].samples[1].impact_bps).toBeNull();

    const prices = z.array(priceSchema).parse([
      { market_id: "NEAR", oracle_asset_id: "wrap.testnet", price: "312000000", timestamp_ms: 1, is_fresh: false },
    ]);
    expect(prices[0].price).toBe(312_000_000n);

    const liquidation = liquidationSchema.parse({
      position_id: 3,
      account_id: "bob.testnet",
      market_id: "ZEC",
      side: "long",
      size: "500000000",
      entry_price: "5500000000",
      price: "5000000000",
      equity: "-1200000",
      penalty: "0",
      reward: "0",
      returned: "0",
      liquidator: "keeper.ketos-dev.testnet",
      timestamp_ms: 1793721060000,
    });
    expect(liquidation.equity).toBe(-1_200_000n);
  });
});
