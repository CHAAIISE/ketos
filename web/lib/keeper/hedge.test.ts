import { expect, it, vi } from "vitest";
import type { Hedge } from "../near/types";
import { runHedge, type HedgePort } from "./hedge";

const NOW = 1_800_000;
const NEAR = 10n ** 24n;
function state(): Hedge {
  return {
    market_id: "NEAR", vault_id: "core", config: { custody_id: "custody.test", exchange_id: "ref.test", wrapped_near_id: "wrap.test", pool_id: 0 },
    next_nonce: 2, observed_at_ms: NOW, recognized_value: 1_000_000n, valuation_ready: true,
    capital_limit: 10_000_000n, per_trade_limit: 1_000_000n, shortfall_limit_bps: 200, cooldown_ms: 60_000,
    confirmed: { config: { controller: "ketos.test", usdc: "usdc.test", wrapped_near: "wrap.test", exchange: "ref.test", pool_id: 0 },
      nonce: 1, cash: 1_000_000n, inventory: 0n, cost_basis: 0n, total_funded: 1_000_000n, total_returned: 0n,
      realized_pnl: 0n, execution_cost: 0n, pending: null, last_fill: null },
    pending: null,
    plan: { trader_delta: NEAR, target_inventory: NEAR, confirmed_inventory: 0n, residual_delta: -NEAR,
      side: "Buy", amount_in: 1_000_000n, hold_reason: null },
  };
}
function port(snapshot: Hedge): HedgePort {
  return {
    state: async () => snapshot,
    market: async () => ({ price: 400_000_000n, price_timestamp_ms: NOW }),
    vault: async () => ({ available: 100_000_000n }),
    verify: async () => {},
    // A 20-USDC / 5-NEAR constant-product pool, including a 25bps fee.
    quote: async (_state, side, amount) => {
      if (side !== "Buy") throw new Error("unexpected side");
      const net = amount * 9975n;
      return net * 5n * NEAR / (20_000_000n * 10_000n + net);
    },
    send: vi.fn(async () => ({ tx: "confirmed-transaction", value: true })),
  };
}
it("shrinks a thin-pool trade without weakening the oracle minimum", async () => {
  const adapter = port(state());
  const result = await runHedge(adapter, () => NOW);
  expect(result.status).toBe("held");
  expect(result.reason).toContain("without the requested asset movement");
  const writes = vi.mocked(adapter.send).mock.calls;
  expect(writes.map(([method]) => method)).toEqual(["rebalance_hedge", "sync_hedge"]);
  const args = writes[0][1];
  expect(BigInt(args.amount_in as string)).toBe(250_000n);
  expect(BigInt(args.min_out as string)).toBeGreaterThanOrEqual(NEAR * 98n / 1600n);
  expect(BigInt(args.min_out as string)).toBeLessThanOrEqual(await adapter.quote(state(), "Buy", 250_000n));
});
it("does not submit again while the original receipt chain is unresolved", async () => {
  const snapshot = state();
  snapshot.pending = { nonce: 2, kind: "Trade", amount: 1_000_000n, command: null, call_complete: false,
    funding_transferred: null, return_received: 0n, started_at_ms: NOW - 600_000, observed: null };
  const adapter = port(snapshot);
  expect((await runHedge(adapter, () => NOW)).status).toBe("held");
  expect(adapter.send).not.toHaveBeenCalled();
});
it("quarantines an unconfirmed reconciliation instead of submitting a replacement", async () => {
  const snapshot = state();
  snapshot.pending = { nonce: 2, kind: "Trade", amount: 1_000_000n, command: null, call_complete: true,
    funding_transferred: null, return_received: 0n, started_at_ms: NOW - 600_000, observed: null };
  const adapter = port(snapshot);
  adapter.send = vi.fn(async () => ({ tx: "read-only-sync", value: false }));
  await expect(runHedge(adapter, () => NOW)).rejects.toThrow("not reconciled");
  expect(vi.mocked(adapter.send).mock.calls.map(([method]) => method)).toEqual(["sync_hedge"]);
});
it("does not authorize with a price that aged while acquiring venue quotes", async () => {
  let clock = NOW;
  const adapter = port(state());
  adapter.quote = async () => { clock += 21_000; return NEAR; };
  expect((await runHedge(adapter, () => clock)).status).toBe("held");
  expect(adapter.send).not.toHaveBeenCalled();
});
it("does not fund beyond unreserved vault cash", async () => {
  const snapshot = state();
  snapshot.plan.side = null;
  snapshot.plan.hold_reason = "NoCash";
  snapshot.confirmed!.cash = 0n;
  const adapter = port(snapshot);
  adapter.vault = async () => ({ available: 75_000n });
  await runHedge(adapter, () => NOW);
  expect(vi.mocked(adapter.send).mock.calls[0].slice(0, 2)).toEqual(["fund_hedge", { nonce: 2, amount: "75000" }]);
});

it("returns unused cash after the last exposure closes without purchasing another price", async () => {
  const snapshot = state();
  snapshot.plan.trader_delta = 0n;
  snapshot.plan.target_inventory = 0n;
  snapshot.plan.side = null;
  snapshot.plan.hold_reason = "StalePrice";
  const adapter = port(snapshot);
  adapter.market = async () => { throw new Error("unused price request"); };
  expect((await runHedge(adapter, () => NOW)).status).toBe("held");
  expect(vi.mocked(adapter.send).mock.calls[0].slice(0, 2)).toEqual([
    "return_hedge_cash", { nonce: 2, amount: "1000000" },
  ]);
});
