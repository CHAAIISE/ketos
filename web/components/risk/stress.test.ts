import { describe, expect, it } from "vitest";
import type { CrossAccount, Market, Position, Vault } from "@/lib/near/types";
import { calculateStress, type StressInput } from "./stress";

const USD = 1_000_000n;
const PRICE = 100_000_000n;
const NOW = Date.UTC(2026, 10, 4, 12);

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
    depth_measured_at_ms: NOW - 60_000,
    oi_long: 500n * USD,
    oi_short: 0n,
    max_leverage: 5,
    price: 4n * PRICE,
    price_timestamp_ms: NOW - 1_000,
    borrow_index_long: 0n,
    borrow_index_short: 0n,
    last_accrual_ms: NOW - 1_000,
    funding: { paid_index: [0n, 0n], received_index: [0n, 0n], last_accrual_ms: NOW - 1_000 },
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

/** Same 100 USDC / 5x opening fixture as the contract's cross.rs regression tests. */
function position(overrides: Partial<Position> = {}): Position {
  return {
    id: 1,
    account_id: "alice.test",
    market_id: "NEAR",
    side: "long",
    margin_mode: "isolated",
    margin: 99_500_000n,
    size: 500n * USD,
    entry_price: 4n * PRICE,
    leverage: 5,
    max_leverage: 5,
    opened_at_ms: NOW - 60_000,
    mark_price: 4n * PRICE,
    mark_price_timestamp_ms: NOW - 1_000,
    unrealized_pnl: 0n,
    borrow_fee: 0n,
    close_fee: 500_000n,
    funding_paid: 0n,
    funding_received: 0n,
    funding_payment: 0n,
    equity: 99_500_000n,
    maintenance_margin: 50n * USD,
    liquidation_price: 360_400_000n,
    take_profit: null,
    stop_loss: null,
    ...overrides,
  };
}

function vault(overrides: Partial<Vault> = {}): Vault {
  return {
    id: "core",
    market_id: null, created_at_ms: null, last_snapshot_at_ms: null,
    balance: 10_000n * USD,
    nav: 10_000n * USD,
    hedge_assets: 0n,
    hedge_valuation_ready: true,
    total_shares: 10_000n * USD,
    share_price: USD,
    reserved: 500n * USD,
    available: 9_500n * USD,
    cross_receivable: 0n,
    traders_unrealized_pnl: 0n,
    borrow_fees_due: 0n,
    funding_net_due: 0n,
    fees_7d: 0n,
    fee_apr_bps: 0,
    revenue: { fees: 0n, funding: 0n, trader_pnl: 0n, liquidations: 0n, listing: 0n },
    ...overrides,
  };
}

function crossAccount(legs: Position[], overrides: Partial<CrossAccount> = {}): CrossAccount {
  const cash = overrides.cash ?? 0n;
  const equity = legs.reduce((total, leg) => total + leg.equity, cash);
  const maintenance = legs.reduce((total, leg) => total + leg.maintenance_margin, 0n);
  return {
    account_id: "alice.test",
    cash,
    equity,
    maintenance_margin: maintenance,
    health_bps: equity * 10_000n / maintenance,
    position_count: legs.length,
    prices_fresh: true,
    liquidatable: equity <= maintenance,
    debt_by_vault: [0n, 0n],
    ...overrides,
  };
}

function snapshot(overrides: Partial<StressInput> = {}): StressInput {
  return {
    markets: [market()],
    positions: [position()],
    crossAccounts: [],
    vaults: [vault(), vault({ id: "long-tail" })],
    marketId: "NEAR",
    shockPercent: 10,
    nowMs: NOW,
    ...overrides,
  };
}

const tailMarket = market({ id: "ZEC", vault_id: "long-tail" });

function safeCrossLeg(overrides: Partial<Position> = {}): Position {
  return position({
    id: 2,
    market_id: "ZEC",
    margin_mode: "cross",
    margin: 99_900_000n,
    size: 100n * USD,
    leverage: 1,
    close_fee: 100_000n,
    equity: 99_900_000n,
    maintenance_margin: 10n * USD,
    liquidation_price: 0n,
    ...overrides,
  });
}

describe("isolated stress uses contract integer marks", () => {
  it("liquidates at exact locked maintenance and not one micro-USDC above it, without a close fee", () => {
    const result = calculateStress(snapshot({
      markets: [market({ max_leverage: 20 })],
      positions: [
        position({ margin: 100n * USD, equity: 100n * USD, close_fee: 100n * USD }),
        position({ id: 2, margin: 100n * USD + 1n, equity: 100n * USD + 1n }),
      ],
    }));
    expect(result.rows.map((row) => [row.price, row.equity, row.liquidatable])).toEqual([
      [360_000_000n, 50n * USD, true],
      [360_000_000n, 50n * USD + 1n, false],
    ]);
    expect(result.liquidatableNotional).toBe(500n * USD);
    expect(result.capacity).toBe(100_000n * USD);
    expect(result.warnings).toEqual([]);
  });

  it("freezes view borrow and gross funding accruals while recomputing PnL from entry", () => {
    const result = calculateStress(snapshot({ positions: [position({
      margin: 100n * USD,
      borrow_fee: 2n * USD,
      funding_paid: 3n * USD,
      funding_received: USD,
      funding_payment: 2n * USD,
      equity: 96n * USD,
      close_fee: 100n * USD,
    })] }));
    expect(result.rows[0].equity).toBe(46n * USD);
    expect(result.rows[0].badDebt).toBe(0n);
    expect(result.rows[0].liquidatable).toBe(true);
  });

  it("floors the shocked price and gains, but ceils losses on an indivisible entry price", () => {
    const base = position({ margin: USD, size: USD, entry_price: 3n, mark_price: 3n, equity: USD, maintenance_margin: 100_000n });
    const result = calculateStress(snapshot({
      markets: [market({ price: 3n })],
      positions: [base, { ...base, id: 2, side: "short" }],
    }));
    expect(result.rows.map((row) => [row.price, row.equity])).toEqual([
      [2n, 666_666n],
      [2n, 1_333_333n],
    ]);
  });

  it("caps gains at notional even after a downward shock of an already-risen market", () => {
    const result = calculateStress(snapshot({
      markets: [market({ price: 30n })],
      positions: [position({ margin: USD, size: USD, entry_price: 3n, mark_price: 30n, unrealized_pnl: USD, equity: 2n * USD, maintenance_margin: 100_000n })],
    }));
    expect(result.rows[0].price).toBe(27n);
    expect(result.rows[0].equity).toBe(2n * USD);
  });

  it("attributes an isolated negative-equity shortfall only to its assigned vault", () => {
    const result = calculateStress(snapshot({ markets: [market({ vault_id: "long-tail" })], shockPercent: 50 }));
    expect(result.rows[0]).toMatchObject({ equity: -150_500_000n, badDebt: 150_500_000n, liquidatable: true });
    expect(result.badDebtByVault).toEqual({ core: 0n, "long-tail": 150_500_000n });
  });
});

describe("cross account contagion and partial liquidation", () => {
  it("keeps a hedged account healthy even when one leg has negative equity", () => {
    const legs = [position({ margin_mode: "cross" }), position({ id: 2, margin_mode: "cross", side: "short" })];
    const result = calculateStress(snapshot({ positions: legs, crossAccounts: [crossAccount(legs)], shockPercent: 50 }));
    expect(result.rows.map((row) => row.equity)).toEqual([-150_500_000n, 349_500_000n]);
    expect(result.rows.every((row) => !row.liquidatable && row.badDebt === 0n)).toBe(true);
    expect(result.liquidatableNotional).toBe(0n);
    expect(result.badDebtByVault).toEqual({ core: 0n, "long-tail": 0n });
  });

  it("includes every peer market of affected cross accounts, but no unrelated account or isolated peer", () => {
    const legs = [position({ margin_mode: "cross" }), safeCrossLeg()];
    const unrelated = safeCrossLeg({ id: 3, account_id: "bob.test" });
    const isolatedPeer = safeCrossLeg({ id: 4, margin_mode: "isolated" });
    const result = calculateStress(snapshot({
      markets: [market(), tailMarket],
      positions: [...legs, unrelated, isolatedPeer],
      crossAccounts: [crossAccount(legs)],
      shockPercent: 30,
    }));
    expect(result.rows.map((row) => row.position.id)).toEqual([1, 2]);
    expect(result.rows.map((row) => row.price)).toEqual([280_000_000n, 4n * PRICE]);
  });

  it("matches the contract recovery fixture: pays reward/penalty, closes the worst leg and retains the safe leg", () => {
    const legs = [position({ margin_mode: "cross" }), safeCrossLeg()];
    const input = snapshot({ markets: [market(), tailMarket], positions: legs, crossAccounts: [crossAccount(legs)], shockPercent: 30 });
    const before = structuredClone(input);
    const result = calculateStress(input);
    // Pool 49.4, then reward 1 + penalty 5: remaining equity 43.4 > maintenance 10.
    expect(result.rows.map((row) => row.liquidatable)).toEqual([true, false]);
    expect(result.rows.map((row) => row.badDebt)).toEqual([0n, 0n]);
    expect(result.liquidatableNotional).toBe(500n * USD);
    expect(result.badDebtByVault).toEqual({ core: 0n, "long-tail": 0n });
    expect(input).toEqual(before);
  });

  it.each([
    [40_001n, true],
    [40_002n, false],
  ] as const)("floors the 0.2%% reward and ceils the 1%% penalty at a one-micro recovery boundary (%s)", (fundingCredit, secondCloses) => {
    const legs = [
      position({
        margin_mode: "cross",
        size: 500_000_005n,
        margin: 99_500_000n,
        funding_received: 500_001n,
        funding_payment: -500_001n,
        equity: 100_000_001n,
        maintenance_margin: 50_000_001n,
      }),
      safeCrossLeg({
        size: 40n * USD,
        margin: 9_960_000n,
        leverage: 4,
        close_fee: 40_000n,
        funding_received: fundingCredit,
        funding_payment: -fundingCredit,
        equity: 9_960_000n + fundingCredit,
        maintenance_margin: 4n * USD,
      }),
    ];
    const result = calculateStress(snapshot({
      markets: [market(), tailMarket],
      positions: legs,
      crossAccounts: [crossAccount(legs)],
      shockPercent: 20,
    }));
    // First leg equity is 0. Reward floors to 1,000,000 and penalty ceils to 5,000,001.
    // The peer is left exactly at maintenance, or one micro above it.
    expect(result.rows.map((row) => row.liquidatable)).toEqual([true, secondCloses]);
    expect(result.badDebtByVault).toEqual({ core: 0n, "long-tail": 0n });
  });

  it.each([1n, 3n * USD])("clamps reward first and then penalty to the shared pool's positive equity (%s)", (poolEquity) => {
    const safeEquity = 50_500_000n + poolEquity;
    const legs = [
      position({ margin_mode: "cross" }),
      safeCrossLeg({ margin: safeEquity, equity: safeEquity }),
    ];
    const result = calculateStress(snapshot({
      markets: [market(), tailMarket],
      positions: legs,
      crossAccounts: [crossAccount(legs)],
      shockPercent: 30,
    }));
    // The risky leg has -50.5 equity, but cannot charge more than the account's tiny pool.
    expect(result.rows.map((row) => row.liquidatable)).toEqual([true, true]);
    expect(result.badDebtByVault).toEqual({ core: 0n, "long-tail": 0n });
  });

  it("uses signed truncated health ratios and id tie-breaking, not an unrounded ratio", () => {
    const legs = [
      position({ id: 2, margin_mode: "cross", size: 10n * USD, margin: 2n * USD - 2n, equity: 2n * USD - 2n, maintenance_margin: USD }),
      position({ id: 1, margin_mode: "cross", size: 10n * USD, margin: 2n * USD - 1n, equity: 2n * USD - 1n, maintenance_margin: USD }),
    ];
    const result = calculateStress(snapshot({ positions: legs, crossAccounts: [crossAccount(legs, { cash: 1_500_000n })], shockPercent: 20 }));
    // Both tiny negative leg equities round to ratio_bps 0; the lower id closes first.
    expect(result.rows.map((row) => [row.position.id, row.equity, row.liquidatable])).toEqual([
      [1, -1n, true],
      [2, -2n, false],
    ]);
    expect(result.liquidatableNotional).toBe(10n * USD);
  });

  it("liquidates at exact aggregate maintenance, including cash rather than the account view's old equity", () => {
    const legs = [position({ margin_mode: "cross", margin: 100n * USD, equity: 100n * USD })];
    const result = calculateStress(snapshot({ positions: legs, crossAccounts: [crossAccount(legs)] }));
    expect(result.rows[0].equity).toBe(50n * USD);
    expect(result.rows[0].liquidatable).toBe(true);
  });

  it("carries existing negative cash provenance and charges final writeoff to both creditor vaults", () => {
    const legs = [position({ margin_mode: "cross" })];
    const result = calculateStress(snapshot({
      positions: legs,
      crossAccounts: [crossAccount(legs, { cash: -100n * USD, debt_by_vault: [70n * USD, 30n * USD] })],
      vaults: [vault({ cross_receivable: 70n * USD }), vault({ id: "long-tail", cross_receivable: 30n * USD })],
      shockPercent: 50,
    }));
    expect(result.badDebtByVault).toEqual({ core: 220_500_000n, "long-tail": 30n * USD });
    expect(result.rows[0].badDebt).toBe(250_500_000n);
  });

  it("repays the paying vault first before the other creditor's claim", () => {
    const legs = [position({ margin_mode: "cross", side: "short" })];
    const result = calculateStress(snapshot({
      markets: [market({ vault_id: "long-tail" })],
      positions: legs,
      crossAccounts: [crossAccount(legs, { cash: -400n * USD, debt_by_vault: [250n * USD, 150n * USD] })],
      vaults: [vault({ cross_receivable: 250n * USD }), vault({ id: "long-tail", cross_receivable: 150n * USD })],
      shockPercent: 50,
    }));
    // 349.5 payout repays tail 150 first and core 199.5; only core's 50.5 is forgiven.
    expect(result.badDebtByVault).toEqual({ core: 50_500_000n, "long-tail": 0n });
    expect(result.rows[0].badDebt).toBe(50_500_000n);
  });

  it("caps cross payouts by liquid vault funds plus that account's own claim", () => {
    const legs = [position({ margin_mode: "cross", side: "short" })];
    const result = calculateStress(snapshot({
      markets: [market({ vault_id: "long-tail" })],
      positions: legs,
      crossAccounts: [crossAccount(legs, { cash: -400n * USD, debt_by_vault: [250n * USD, 150n * USD] })],
      vaults: [vault({ cross_receivable: 250n * USD }), vault({ id: "long-tail", balance: 150n * USD, cross_receivable: 150n * USD })],
      shockPercent: 50,
    }));
    // Tail has no liquid balance: 99.5 collateral + own claim 150 caps the 349.5 gain at 249.5.
    expect(result.badDebtByVault).toEqual({ core: 150_500_000n, "long-tail": 0n });
    expect(result.rows[0].badDebt).toBe(150_500_000n);
  });

  it("nets a same-vault claim without rejecting a transient receivable above balance", () => {
    const legs = [position({ margin_mode: "cross", side: "short" })];
    const result = calculateStress(snapshot({
      positions: legs,
      crossAccounts: [crossAccount(legs, { cash: -400n * USD, debt_by_vault: [400n * USD, 0n] })],
      vaults: [vault({ balance: 400n * USD, cross_receivable: 400n * USD })],
      shockPercent: 50,
    }));
    expect(result.badDebtByVault).toEqual({ core: 50_500_000n, "long-tail": 0n });
  });

  it("updates vault funds after each leg before capping the next payout", () => {
    const legs = [
      position({ margin_mode: "cross" }),
      position({ id: 2, margin_mode: "cross", side: "short", margin: 99_500_000n, equity: 99_500_000n }),
    ];
    const result = calculateStress(snapshot({
      positions: legs,
      crossAccounts: [crossAccount(legs, { cash: -300n * USD, debt_by_vault: [300n * USD, 0n] })],
      vaults: [vault({ balance: 300n * USD, cross_receivable: 300n * USD })],
      shockPercent: 50,
    }));
    // First loss creates a 450.5 claim and 550 balance; the next 349.5 payout nets that claim.
    expect(result.rows.map((row) => row.liquidatable)).toEqual([true, true]);
    expect(result.rows.map((row) => row.badDebt)).toEqual([0n, 101n * USD]);
    expect(result.badDebtByVault).toEqual({ core: 101n * USD, "long-tail": 0n });
  });
});

describe("missing state and snapshot freshness", () => {
  it("warns for stale prices without pretending the hypothetical liquidation can execute", () => {
    const result = calculateStress(snapshot({ markets: [market({ price_timestamp_ms: NOW - 120_001 })] }));
    expect(result.warnings.some((warning) => warning.includes("oracle price is stale"))).toBe(true);
    expect(result.rows[0].price).toBe(360_000_000n);
  });

  it("checks stale prices on non-selected cross legs and discloses independent account freshness", () => {
    const legs = [position({ margin_mode: "cross" }), safeCrossLeg()];
    const result = calculateStress(snapshot({
      markets: [market(), { ...tailMarket, price_timestamp_ms: NOW - 120_001 }],
      positions: legs,
      crossAccounts: [crossAccount(legs, { prices_fresh: false })],
    }));
    expect(result.warnings.some((warning) => warning.includes("ZEC oracle price is stale"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("reported stale prices"))).toBe(true);
  });

  it.each([0, NOW - 30 * 60_000 - 1, NOW + 1])("returns unknown capacity for unmeasured, stale or future depth at %s", (measuredAt) => {
    const result = calculateStress(snapshot({ markets: [market({ depth_measured_at_ms: measuredAt })] }));
    expect(result.capacity).toBeNull();
    expect(result.warnings.some((warning) => warning.includes("depth"))).toBe(true);
  });

  it("keeps inclusive freshness boundaries and distinguishes measured zero capacity from no measurement", () => {
    const result = calculateStress(snapshot({ markets: [market({ price_timestamp_ms: NOW - 120_000, depth_measured_at_ms: NOW - 30 * 60_000, exit_capacity: 0n })] }));
    expect(result.capacity).toBe(0n);
    expect(result.warnings.some((warning) => warning.includes("is stale"))).toBe(false);
  });

  it("refuses missing markets, prices, timestamps and vaults rather than manufacturing a numeric estimate", () => {
    expect(() => calculateStress(snapshot({ markets: [] }))).toThrow("Missing market NEAR");
    expect(() => calculateStress(snapshot({ markets: [market({ price: 0n })] }))).toThrow("Missing oracle price");
    expect(() => calculateStress(snapshot({ markets: [market({ price_timestamp_ms: 0 })] }))).toThrow("Missing oracle timestamp");
    expect(() => calculateStress(snapshot({ vaults: [] }))).toThrow("Missing core vault state");
  });

  it("refuses missing cross cash, incomplete peer positions and inconsistent debt provenance", () => {
    const legs = [position({ margin_mode: "cross" }), safeCrossLeg()];
    const input = snapshot({ markets: [market(), tailMarket], positions: legs, crossAccounts: [crossAccount(legs)] });
    expect(() => calculateStress({ ...input, crossAccounts: [] })).toThrow("Missing cross account");
    expect(() => calculateStress({ ...input, positions: [legs[0]] })).toThrow("Incomplete cross account");
    expect(() => calculateStress({ ...input, markets: [market()] })).toThrow("Missing market ZEC");
    expect(() => calculateStress({ ...input, crossAccounts: [crossAccount(legs, { cash: -USD })] })).toThrow("cash/debt provenance");
    expect(() => calculateStress({ ...input, crossAccounts: [crossAccount(legs, { cash: -USD, debt_by_vault: [USD, 0n] })] })).toThrow("exceeds core vault receivables");
  });

  it("rejects duplicate positions and impossible vault receivables", () => {
    expect(() => calculateStress(snapshot({ positions: [position(), position()] }))).toThrow("Duplicate position");
    expect(() => calculateStress(snapshot({ vaults: [vault({ balance: 0n, cross_receivable: USD })] }))).toThrow("balance/receivables");
  });

  it.each([9, 51, 10.5, Number.NaN])("rejects a shock outside the integer 10–50 percent contract: %s", (shockPercent) => {
    expect(() => calculateStress(snapshot({ shockPercent }))).toThrow("integer downward shock");
  });
});
