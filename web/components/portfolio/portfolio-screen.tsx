"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { ConnectButton } from "@/components/app/connect-button";
import { useFundingDialog } from "@/components/app/funding";
import { EmptyState, ErrorState, Skeleton } from "@/components/app/states";
import { formatUtc, useNow } from "@/components/landing/live-time";
import { FundingHistoryTable, OpenOrdersTable, TradeHistoryTable } from "@/components/trade/account-history";
import { PositionsTable } from "@/components/trade/positions-table";
import { Button } from "@/components/ui/button";
import { PanelTabs } from "@/components/ui/panel-tabs";
import { Term } from "@/components/vault/term";
import { useAccountId } from "@/hooks/near-provider";
import { useAccount, useAccountStats, useCrossAccount, useHistory, useOrders, usePositions, useVaultAccount } from "@/hooks/use-ketos-queries";
import { formatUsd } from "@/lib/near/format";
import type { HistoryEvent } from "@/lib/near/types";
import { cn } from "@/lib/utils";
import { PnlChart } from "./pnl-chart";
import { portfolioTotals } from "./portfolio-math";

const panel = "min-w-0 rounded-md border border-border bg-card";

type Tab = "positions" | "orders" | "trades" | "funding" | "transfers";

export function PortfolioScreen() {
  const accountId = useAccountId();
  return accountId ? <AccountPortfolio key={accountId} /> : (
    <section className={cn(panel, "p-4")}>
      <h1 className="text-heading">Portfolio</h1>
      <EmptyState className="px-0" action={<ConnectButton />}>
        Connect your wallet to see your equity, positions and account history. Use Fund to get USDC, then trade directly from your wallet.
      </EmptyState>
      <Link href="/markets" className="text-ui text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">Browse markets without connecting →</Link>
    </section>
  );
}

function Stat({ label, value, testId, signed = false }: { label: ReactNode; value: bigint | undefined; testId: string; signed?: boolean }) {
  return <div className="flex min-w-0 flex-col gap-1">
    <dt className="text-label text-tertiary">{label}</dt>
    <dd data-testid={testId} className={cn("text-price tabular-nums", signed && value !== undefined && (value > 0n ? "text-success" : value < 0n ? "text-destructive" : "text-foreground"))}>
      {value === undefined ? <Skeleton className="h-7 w-24" /> : formatUsd(value, { signed })}
    </dd>
  </div>;
}

function Balance({ label, value, testId }: { label: ReactNode; value: bigint | undefined; testId?: string }) {
  return <div className="flex items-baseline justify-between gap-4 text-ui">
    <dt className="text-tertiary">{label}</dt>
    <dd className="text-right tabular-nums" data-testid={testId}>{value === undefined ? "—" : formatUsd(value)}</dd>
  </div>;
}

function AccountPortfolio() {
  const account = useAccount();
  const positions = usePositions();
  const orders = useOrders();
  const cross = useCrossAccount();
  const stats = useAccountStats();
  const history = useHistory();
  const core = useVaultAccount("core");
  const longTail = useVaultAccount("long-tail");
  const funding = useFundingDialog();
  const now = useNow();
  const [tab, setTab] = useState<Tab>("positions");
  const equityQueries = [account, positions, cross, core, longTail];
  const equityReady = equityQueries.every((query) => query.isSuccess && !query.isError);
  const equityError = equityQueries.find((query) => query.isError);
  const totals = equityReady && account.data && positions.data && cross.data && core.data && longTail.data ? portfolioTotals({
    freeMargin: account.data.margin,
    reservedMargin: account.data.reservedMargin,
    positions: positions.data,
    cross: cross.data,
    vaultValues: [core.data.value, longTail.data.value],
  }) : undefined;
  const realized = stats.isSuccess ? stats.data?.realized_pnl ?? 0n : undefined;
  const events = history.data ?? [];
  const openPositions = positions.data ?? [];
  const openOrders = orders.data ?? [];
  const stalePrices = now > 0 && openPositions.some((p) => now < p.mark_price_timestamp_ms || now - p.mark_price_timestamp_ms > 120_000);
  const readAt = equityReady ? Math.min(...equityQueries.map((query) => query.dataUpdatedAt)) : 0;
  const tabs = [
    { id: "positions", label: `Positions${openPositions.length ? ` (${openPositions.length})` : ""}` },
    { id: "orders", label: `Open Orders${openOrders.length ? ` (${openOrders.length})` : ""}` },
    { id: "trades", label: "Trade History" },
    { id: "funding", label: "Funding History" },
    { id: "transfers", label: "Deposits & Withdrawals" },
  ] as const;

  const selectedQuery = tab === "positions" ? positions : tab === "orders" ? orders : history;
  let content: ReactNode;
  if (selectedQuery.isError) {
    content = <ErrorState className="m-3" title="Could not refresh your account history." error={selectedQuery.error} onRetry={() => void selectedQuery.refetch()} />;
  } else if (selectedQuery.isPending || ((tab === "positions" || tab === "orders") && (orders.isPending || positions.isPending))) {
    content = <Skeleton className="m-3 h-32" />;
  } else if ((tab === "positions" || tab === "orders") && (orders.isError || positions.isError)) {
    content = <ErrorState className="m-3" title="Positions or linked orders could not be refreshed." onRetry={() => { void positions.refetch(); void orders.refetch(); }} />;
  } else if (tab === "positions") {
    content = openPositions.length ? <PositionsTable positions={openPositions} orders={openOrders} allowSwitchToCross /> :
      <EmptyState action={<Link href="/trade" className="text-foreground underline underline-offset-4">Choose a market →</Link>}>No open positions. {account.data?.usdcBalance || account.data?.margin ? "Your USDC is ready; choose a market to open a position." : "Use Fund to get USDC, then choose a market to trade directly from your wallet."}</EmptyState>;
  } else if (tab === "orders") {
    content = openOrders.length ? <OpenOrdersTable orders={openOrders} positions={openPositions} /> :
      <EmptyState action={<Link href="/trade" className="text-foreground underline underline-offset-4">Place an order →</Link>}>No open orders. Place a Limit or Stop order, or attach take profit / stop loss when opening a position.</EmptyState>;
  } else if (tab === "trades") {
    content = events.some((e) => e.kind === "open" || e.kind === "close" || e.kind === "liquidation") ? <TradeHistoryTable events={events} /> :
      <EmptyState action={<Link href="/trade" className="text-foreground underline underline-offset-4">Start trading →</Link>}>No trades yet. Your opens, closes and liquidations will appear here.</EmptyState>;
  } else if (tab === "funding") {
    content = events.some((e) => e.kind === "funding") ? <FundingHistoryTable events={events} /> :
      <EmptyState>No funding settled yet. Funding is recorded when a position closes; running funding is shown under Positions.</EmptyState>;
  } else {
    content = <Transfers events={events} onDeposit={() => funding.open("deposit")} />;
  }

  return <>
    <section className={cn(panel, "flex flex-wrap items-center justify-between gap-3 p-4")}>
      <div><h1 className="text-heading">Portfolio</h1><p className="mt-1 text-ui text-muted-foreground">Your trading equity, vault holdings and onchain account activity.</p></div>
      <div className="flex items-center gap-2">
        <Button variant="secondary" disabled={!account.isSuccess || account.data.margin === 0n} onClick={() => funding.open("withdraw")}>Withdraw</Button>
        <Button data-primary disabled={!account.isSuccess} onClick={() => funding.open("deposit")}>Deposit</Button>
      </div>
    </section>
    {equityError ? <ErrorState title="Could not refresh portfolio balances." error={equityError.error} onRetry={() => { for (const query of equityQueries) void query.refetch(); }} /> : null}
    {stalePrices ? <p role="status" className="rounded-md border border-warning/40 bg-card p-3 text-ui text-warning">Oracle prices are older than 2 minutes. Equity and unrealized PnL use the last available marks, not current executable prices.</p> : null}
    <div className="grid min-w-0 gap-1 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <section aria-label="Portfolio performance" className={panel}>
        <dl className="grid grid-cols-2 gap-4 border-b border-border p-4 md:grid-cols-4">
          <Stat label={<Term hint="Trading equity plus the current value of your Core and Long-tail vault shares. Wallet USDC is excluded. Equity is marked before closing fees and may be negative.">Total Equity</Term>} value={totals?.totalEquity} testId="portfolio-equity" />
          <Stat label={<Term hint="All-time trading PnL booked by the contract, including opening and closing fees, borrow and settled funding. Transfers are not PnL.">Realized PnL</Term>} value={realized} signed testId="portfolio-realized" />
          <Stat label={<Term hint="Price-only profit or loss on open positions, before borrow, funding and closing fees. Trading equity already includes accrued borrow and funding.">Unrealized PnL</Term>} value={totals?.unrealizedPnl} signed testId="portfolio-unrealized" />
          <Stat label="Volume · all-time" value={stats.isSuccess ? stats.data?.volume ?? 0n : undefined} testId="portfolio-volume" />
        </dl>
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 text-ui"><h2 className="font-medium">Cumulative Realized PnL</h2><span className="text-label text-tertiary">Retained history</span></div>
        {history.isError || stats.isError ? <ErrorState className="m-3" title="Could not refresh performance history." onRetry={() => { void history.refetch(); void stats.refetch(); }} /> : <PnlChart key={account.data?.accountId} events={events} total={realized ?? 0n} loading={history.isPending || stats.isPending} />}
      </section>
      <aside aria-label="Account equity breakdown" className={cn(panel, "flex flex-col p-4")}>
        <h2 className="text-ui font-medium">Account Overview</h2>
        <dl className="mt-4 flex flex-col gap-3">
          <Balance label="Trading equity" value={totals?.tradingEquity} />
          <Balance label="Available to withdraw" value={account.isSuccess ? account.data.margin : undefined} testId="portfolio-available" />
          <Balance label="Reserved for orders" value={account.isSuccess ? account.data.reservedMargin : undefined} />
          <Balance label={<Link href="/vaults/core" className="hover:text-foreground">Core vault ↗</Link>} value={core.isSuccess ? core.data.value : undefined} />
          <Balance label={<Link href="/vaults/long-tail" className="hover:text-foreground">Long-tail vault ↗</Link>} value={longTail.isSuccess ? longTail.data.value : undefined} />
          <div className="border-t border-border pt-3"><Balance label="Wallet USDC · excluded" value={account.isSuccess ? account.data.usdcBalance : undefined} /></div>
        </dl>
        <div className="mt-4 border-t border-border pt-3">
          <h3 className="text-ui font-medium">Cross Margin</h3>
          <dl className="mt-3 flex flex-col gap-3">
            <Balance label="Pool equity" value={cross.isSuccess ? cross.data.equity : undefined} />
            <Balance label="Maintenance" value={cross.isSuccess ? cross.data.maintenance_margin : undefined} />
          </dl>
          <p data-testid="portfolio-cross-health" className={cn("mt-3 text-label", cross.data?.liquidatable ? "text-destructive" : "text-muted-foreground")}>
            {!cross.isSuccess ? "Reading shared pool…" : cross.data.position_count === 0 ? "No cross positions. Switch an isolated position to Cross under Positions." : !cross.data.prices_fresh ? "Pool health unavailable: oracle prices are stale." : cross.data.liquidatable ? "Below maintenance. The shared pool can be liquidated." : "Above maintenance. Cross positions share this pool."}
          </p>
        </div>
        <p className="mt-auto pt-4 text-label text-tertiary">{readAt ? `Balances read ${formatUtc(readAt, true)} · separate onchain views` : "Reading onchain balances…"}</p>
      </aside>
    </div>
    <section aria-label="Portfolio activity" className={panel}>
      <PanelTabs tabs={tabs} value={tab} onChange={setTab} label="Portfolio activity" idPrefix="portfolio" />
      <div id="portfolio-panel" role="tabpanel" aria-labelledby={`portfolio-tab-${tab}`} className="min-h-48">{content}</div>
      <p className="border-t border-border px-3 py-2 text-label text-tertiary">Last 200 onchain events retained per account. Margin transfers are recorded from the transfer-history upgrade onward; older transfers are not backfilled.</p>
    </section>
  </>;
}

function Transfers({ events, onDeposit }: { events: readonly HistoryEvent[]; onDeposit: () => void }) {
  const transfers = events.filter((event) => event.kind === "deposit" || event.kind === "withdrawal");
  if (!transfers.length) return <EmptyState action={<Button variant="outline" size="sm" onClick={onDeposit}>Deposit margin</Button>}>No recorded collateral transfers. Direct wallet trades and advanced Deposit/Withdraw appear here. Vault deposits and withdrawals are managed under Earn.</EmptyState>;
  return <div className="overflow-x-auto">
    <table className="w-full min-w-128 text-label tabular-nums">
      <thead className="bg-muted text-tertiary"><tr className="h-8"><th className="px-3 text-left font-normal" scope="col">Time · UTC</th><th className="px-3 text-left font-normal" scope="col">Type</th><th className="px-3 text-right font-normal" scope="col">Amount</th><th className="px-3 text-left font-normal" scope="col">Route</th></tr></thead>
      <tbody>{transfers.map((event) => <tr key={event.sequence} data-testid={`transfer-${event.sequence}`} className="h-9 border-t border-border">
        <td className="px-3 text-muted-foreground" title={new Date(event.timestamp_ms).toISOString()}>{formatUtc(event.timestamp_ms, true)}</td>
        <th className="px-3 text-left font-normal" scope="row">{event.kind === "deposit" ? "Deposit" : "Withdrawal"}</th>
        <td className={cn("px-3 text-right", event.kind === "deposit" ? "text-success" : "text-foreground")}>{formatUsd(event.size)}</td>
        <td className="px-3 text-muted-foreground">{event.kind === "deposit" ? "Wallet → Margin" : "Margin → Wallet"}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}
