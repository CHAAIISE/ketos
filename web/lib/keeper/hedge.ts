import type { Hedge, Market, Vault } from "../near/types";

const VALUE_SCALE = 10n ** 26n;
const MIN_TRADE = 10_000n;
const BPS = 10_000n;
export type HedgeStep = { status: "disabled" | "held" | "reconciled" | "funded" | "traded" | "returned" | "recovered"; reason?: string; tx?: string };
export interface HedgePort {
  state(): Promise<Hedge | null>;
  market(id: string): Promise<Pick<Market, "price" | "price_timestamp_ms">>;
  vault(id: Hedge["vault_id"]): Promise<Pick<Vault, "available">>;
  verify(state: Hedge): Promise<void>;
  quote(state: Hedge, side: "Buy" | "Sell", amount: bigint): Promise<bigint>;
  send(method: string, args: Record<string, unknown>, gas: number): Promise<{ tx: string; value: unknown }>;
}
const min = (...values: bigint[]) => values.reduce((a, b) => a < b ? a : b);
const ceil = (value: bigint, divisor: bigint) => (value + divisor - 1n) / divisor;

/** One operation plus reconciliation. Unknown execution never becomes a replacement swap. */
export async function runHedge(port: HedgePort, now: () => number = Date.now): Promise<HedgeStep> {
  const state = await port.state();
  if (!state) return { status: "disabled" };
  await port.verify(state);
  const reconcile = async (hash: string | null, status: HedgeStep["status"]): Promise<HedgeStep> => {
    const result = await port.send("sync_hedge", { reported_transaction_hash: hash }, 100);
    if (result.value !== true) throw new Error("Hedge not reconciled; external assets remain quarantined");
    return { status, tx: hash ?? result.tx };
  };
  if (state.pending) {
    if (!state.pending.call_complete) return { status: "held", reason: "Receipt chain still in flight" };
    const observed = state.pending.observed;
    const recoverable = observed && (observed.pending?.nonce === state.pending.nonce ||
      (state.pending.kind === "Fund" && state.pending.funding_transferred === true && observed.nonce < state.pending.nonce));
    if (recoverable) {
      const result = await port.send("recover_hedge", { nonce: state.pending.nonce }, 250);
      return reconcile(result.tx, "recovered");
    }
    return reconcile(null, "reconciled");
  }
  if (!state.confirmed) return reconcile(null, "reconciled");
  const book = state.confirmed;
  const dispatch = async (method: string, args: Record<string, unknown>, status: HedgeStep["status"]) => {
    const result = await port.send(method, { nonce: state.next_nonce, ...args }, 300);
    const reconciled = await reconcile(result.tx, status);
    const after = await port.state();
    const confirmed = after?.confirmed;
    if (!confirmed || after.pending) throw new Error("Post-operation custody ledger is not settled");
    const moved = status === "traded"
      ? confirmed.last_fill?.nonce === state.next_nonce && confirmed.last_fill.side === args.side &&
        confirmed.last_fill.amount_in === BigInt(String(args.amount_in)) && confirmed.last_fill.amount_out > 0n
      : status === "funded" ? confirmed.total_funded === book.total_funded + BigInt(String(args.amount))
      : status === "returned" ? confirmed.total_returned === book.total_returned + BigInt(String(args.amount))
      : false;
    return moved ? reconciled : { status: "held" as const, reason: "Operation reconciled without the requested asset movement", tx: result.tx };
  };
  if (book.cash > 0n && book.inventory === 0n && state.plan.trader_delta <= 0n) {
    return dispatch("return_hedge_cash", { amount: book.cash.toString() }, "returned");
  }
  const market = await port.market(state.market_id);
  const age = now() - market.price_timestamp_ms;
  if (market.price <= 0n || age < 0 || age > 20_000 || state.plan.hold_reason === "StalePrice") {
    return { status: "held", reason: "Fresh authorization price required" };
  }
  if (state.plan.side) {
    const side = state.plan.side;
    let amount = state.plan.amount_in;
    // Reduce to an executable size, never relax the oracle shortfall bound to manufacture a fill.
    while (amount > 0n) {
      const reference = side === "Buy" ? amount * VALUE_SCALE / market.price : amount * market.price / VALUE_SCALE;
      const notional = side === "Buy" ? amount : reference;
      if (notional < MIN_TRADE) break;
      const output = await port.quote(state, side, amount);
      const oracleMinimum = ceil(reference * (BPS - BigInt(state.shortfall_limit_bps)), BPS);
      if (output >= oracleMinimum) {
        // Half a percent quote tolerance, constrained again by the on-chain reference bound.
        const quoteMinimum = ceil(output * 9950n, BPS);
        const minOut = quoteMinimum > oracleMinimum ? quoteMinimum : oracleMinimum;
        if (now() - market.price_timestamp_ms > 20_000) return { status: "held", reason: "Price aged during venue quote" };
        return dispatch("rebalance_hedge", { side, amount_in: amount.toString(), min_out: minOut.toString(),
          expires_at_ms: now() + 25_000 }, "traded");
      }
      amount /= 2n;
    }
    return { status: "held", reason: "No executable Ref quote inside the oracle bound" };
  }
  if (state.plan.hold_reason === "NoCash") {
    const targetCapital = min(state.capital_limit, state.plan.target_inventory * market.price / VALUE_SCALE);
    const budget = targetCapital - book.cash - book.cost_basis;
    const vault = await port.vault(state.vault_id);
    const amount = min(budget, state.per_trade_limit, vault.available);
    if (amount >= MIN_TRADE) return dispatch("fund_hedge", { amount: amount.toString() }, "funded");
    return { status: "held", reason: "No unreserved hedge capital" };
  }
  if (book.cash > 0n && state.plan.target_inventory <= book.inventory) {
    return dispatch("return_hedge_cash", { amount: book.cash.toString() }, "returned");
  }
  return { status: "held", reason: state.plan.hold_reason ?? "No adjustment required" };
}
