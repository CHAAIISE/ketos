"use client";

import { ExternalLink, ShieldCheck } from "lucide-react";
import { EmptyState, ErrorState, Skeleton } from "@/components/app/states";
import { formatUtc } from "@/components/landing/live-time";
import { PanelHeading } from "@/components/vault/panel-heading";
import { useHedge, useHedgeEvidence, useHedgeFills } from "@/hooks/use-ketos-queries";
import { useNear } from "@/hooks/near-provider";
import { formatUnits, formatUsd, formatVaultName } from "@/lib/near/format";
import type { Market } from "@/lib/near/types";

const cash = (value: bigint) => formatUsd(value, { maxFractionDigits: 6 });
const quantity = (value: bigint) => `${formatUnits(value, 24, { maxFractionDigits: 8, signed: true })} NEAR`;
export function HedgePanel({ markets, now }: { markets: readonly Market[]; now: number }) {
  const query = useHedge();
  const history = useHedgeFills();
  const state = query.data;
  const records = history.data ?? [];
  const evidence = useHedgeEvidence(records, state?.config.custody_id ?? null);
  const { config } = useNear();
  const market = markets.find((item) => item.id === state?.market_id);
  const fresh = market && now >= market.price_timestamp_ms && now - market.price_timestamp_ms <= 30_000;
  const book = state?.confirmed;
  const unrealized = book && market && fresh && !state?.pending
    ? book.inventory * market.price / (10n ** 26n) - book.cost_basis : null;
  return (
    <section aria-labelledby="hedge-title" className="min-w-0 rounded-md border border-border bg-card">
      <PanelHeading id="hedge-title" aside={<span className="text-label text-tertiary">Ref spot · testnet</span>}>
        Executed protection
      </PanelHeading>
      {!now || query.isPending ? <Skeleton className="m-3 h-36" /> : query.isError ? (
        <ErrorState title="Hedge state unavailable. No coverage assumed." error={query.error} onRetry={() => void query.refetch()} />
      ) : !state ? <EmptyState>External hedging is not enabled on this deployment.</EmptyState> : (
        <div className="space-y-4 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-label">
            <p className={state.pending || !state.valuation_ready ? "text-warning" : "text-muted-foreground"}>
              {state.pending ? `Reconciling ${state.pending.kind.toLowerCase()} #${state.pending.nonce} · external NAV excluded`
                : !book ? "Awaiting initial custody reconciliation"
                : !state.valuation_ready ? "Inventory mark stale · external inventory excluded"
                : `${formatVaultName(state.vault_id)} · confirmed custody ledger`}
            </p>
            <span className="text-tertiary">Read {formatUtc(query.dataUpdatedAt, true)}</span>
          </div>
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border lg:grid-cols-4">
            {[
              ["Target spot", fresh ? quantity(state.plan.target_inventory) : "Fresh price required"],
              ["Confirmed spot", book ? quantity(book.inventory) : "Not reconciled"],
              ["Residual vault delta", state.pending ? "Uncertain while in flight" : fresh ? quantity(state.plan.residual_delta) : "Stale mark"],
              ["Recognized hedge assets", cash(state.recognized_value)],
              ["Custody cash", book ? cash(book.cash) : "—"],
              ["Spot cost basis", book ? cash(book.cost_basis) : "—"],
              ["Realized hedge PnL", book ? cash(book.realized_pnl) : "—"],
              ["Unrealized at mark", unrealized === null ? "Unavailable" : cash(unrealized)],
            ].map(([label, value]) => <div key={label} className="min-w-0 bg-card p-3"><dt className="text-label text-tertiary">{label}</dt><dd className="mt-1 break-words font-mono text-ui tabular-nums">{value}</dd></div>)}
          </dl>
          <p className="text-label text-muted-foreground">
            {cash(state.capital_limit)} capital limit at cost · {cash(state.per_trade_limit)} per trade · {state.shortfall_limit_bps / 100}% reference shortfall cap · {state.cooldown_ms / 1000}s cooldown.
            {state.plan.hold_reason ? ` Policy: ${state.plan.hold_reason}.` : " Adjustment eligible, not yet a fill."}
          </p>
          <div className="min-w-0 overflow-x-auto">
            <table className="w-full whitespace-nowrap text-left text-label">
              <caption className="pb-2 text-left text-ui font-medium">Confirmed ledger fills · independently checked receipts</caption>
              <thead className="border-b border-border text-tertiary"><tr>{["Execution", "Actual received", "Shortfall vs mark", "Realized PnL", "Latency / gas", "Receipt evidence"].map((label) => <th key={label} className="px-2 py-2 font-normal">{label}</th>)}</tr></thead>
              <tbody>{records.map((record, index) => {
                const fill = record.fill;
                const proof = evidence[index];
                return <tr key={fill.nonce} className="border-b border-border/60">
                  <td className="px-2 py-3"><p>{fill.side} #{fill.nonce}{fill.recovered ? " · recovered" : ""}</p><p className="mt-1 text-tertiary">{formatUtc(fill.confirmed_at_ms, true)}</p></td>
                  <td className="px-2 py-3 font-mono">{fill.side === "Buy" ? quantity(fill.amount_out) : cash(fill.amount_out)}</td>
                  <td className="px-2 py-3 font-mono">{cash(fill.execution_cost)}</td>
                  <td className="px-2 py-3 font-mono">{cash(fill.realized_pnl)}</td>
                  <td className="px-2 py-3 font-mono">{proof?.data ? <>{(proof.data.latencyMs / 1000).toFixed(1)}s<p className="mt-1 text-tertiary">{formatUnits(proof.data.gasCostYocto, 24, { maxFractionDigits: 8 })} NEAR</p></> : "Not verified"}</td>
                  <td className="px-2 py-3">{proof?.data ? <a className="inline-flex items-center gap-1 underline underline-offset-4" href={config.network === "testnet" ? `https://testnet.nearblocks.io/txns/${proof.data.transactionHash}` : undefined} target="_blank" rel="noreferrer"><ShieldCheck size={14} aria-hidden />Verified fill<ExternalLink size={12} aria-hidden /></a>
                    : !record.reported_transaction_hash ? <span className="text-warning">No transaction locator</span>
                    : proof?.isError ? <button type="button" className="text-warning underline underline-offset-4" onClick={() => void proof.refetch()}>Receipt unverified · retry</button>
                    : <span className="text-tertiary">Checking receipts…</span>}</td>
                </tr>;
              })}</tbody>
            </table>
          </div>
          {history.isError ? <ErrorState title="Fill history unavailable." error={history.error} onRetry={() => void history.refetch()} />
            : records.length === 0 ? <p className="text-label text-muted-foreground">{history.isPending ? "Reading fills…" : "No executed hedge recorded. Quotes are not fills."}</p> : null}
          <details className="border-t border-border pt-3 text-label text-muted-foreground">
            <summary className="cursor-pointer">Custody, costs and limits</summary>
            <div className="mt-3 space-y-2">
              <p className="break-all">Custody: {state.config.custody_id} · venue: {state.config.exchange_id} · pool {state.config.pool_id}. Pool liquidity is separately funded project demo liquidity, not vault assets.</p>
              <p>Spot cannot short without inventory. Coverage is partial, capped and dependent on executable liquidity. Residual delta = confirmed spot minus trader payout delta; quantities display up to eight decimals. Price caps and trader liquidation change this delta.</p>
              <p>Shortfall includes Ref fees, slippage and basis against the authorization mark; it is not an extra deduction from realized PnL. Spot has no perpetual funding payment. Verified gas is shown separately in native NEAR, not converted using an invented exchange rate.</p>
              <p>Cash and inventory shown during an operation are the last confirmed ledger, not available balances. Uncertain external assets are excluded from NAV and affected LP share operations pause. External capital never raises trader admission limits.</p>
              <p>Orders enforce minimum output. Expiry is checked before dispatch; Ref cannot cancel an already queued atomic swap. Contract accounts retain deployment keys; this testnet is not immutable or guaranteed market-neutral.</p>
            </div>
          </details>
        </div>
      )}
    </section>
  );
}
