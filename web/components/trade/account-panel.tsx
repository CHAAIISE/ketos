"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useFundingDialog } from "@/components/app/funding";
import { useNow } from "@/components/landing/live-time";
import { EmptyState, ErrorState, Skeleton } from "@/components/app/states";
import { Button } from "@/components/ui/button";
import { PanelTabs } from "@/components/ui/panel-tabs";
import { useAccountId } from "@/hooks/near-provider";
import { useAccount, useConfig, useHistory, useLiquidations, useOrders, usePositions, useVaultAccount } from "@/hooks/use-ketos-queries";
import { formatUsd } from "@/lib/near/format";
import { formatShares } from "@/components/vault/vault-math";
import { cn } from "@/lib/utils";
import { FundingHistoryTable, OpenOrdersTable, OrderHistoryTable, orderHistoryRows, TradeHistoryTable } from "./account-history";
import { LiquidationsTable } from "./liquidations-table";
import { PositionsTable } from "./positions-table";

type Tab = "balances" | "positions" | "orders" | "trades" | "funding" | "order-history" | "liquidations";

const SIGNED_OUT = "Connect a wallet to see your balances and positions.";

const th = "px-3 font-normal whitespace-nowrap";

function Balances() {
  const account = useAccount();
  const positions = usePositions();
  const vault = useVaultAccount("core");
  const longTail = useVaultAccount("long-tail");
  const funding = useFundingDialog();

  if (account.isPending) return <Skeleton className="m-3 h-24" />;
  if (account.isError) {
    return <ErrorState className="m-3" title="Your balances are unavailable right now." error={account.error} onRetry={() => void account.refetch()} />;
  }
  const locked = positions.data?.reduce((sum, p) => sum + p.margin, 0n) ?? 0n;
  const { usdcBalance, margin } = account.data;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-label tabular-nums">
        <thead className="text-tertiary">
          <tr className="h-8">
            <th scope="col" className={cn(th, "text-left")}>Coin</th>
            <th scope="col" className={cn(th, "text-right")}>Total Balance</th>
            <th scope="col" className={cn(th, "text-right")}>Available Balance</th>
            <th scope="col" className={cn(th, "text-right")}>USDC Value</th>
            <th scope="col" className={cn(th, "text-right")}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="text-foreground">
          <tr className="h-9 border-t border-border">
            <th scope="row" className="px-3 text-left font-normal">USDC <span className="text-tertiary">(wallet)</span></th>
            <td className="px-3 text-right">{formatUsd(usdcBalance)}</td>
            <td className="px-3 text-right">{formatUsd(usdcBalance)}</td>
            <td className="px-3 text-right">{formatUsd(usdcBalance)}</td>
            <td className="px-3 text-right">
              <Button variant="link" size="xs" className="text-label" onClick={() => funding.open("deposit")}>
                Deposit to margin
              </Button>
            </td>
          </tr>
          <tr className="h-9 border-t border-border">
            <th scope="row" className="px-3 text-left font-normal">USDC <span className="text-tertiary">(margin)</span></th>
            <td className="px-3 text-right">{formatUsd(margin + locked)}</td>
            <td className="px-3 text-right" data-testid="margin-free">{formatUsd(margin)}</td>
            <td className="px-3 text-right">{formatUsd(margin + locked)}</td>
            <td className="px-3 text-right">
              <Button variant="link" size="xs" className="text-label" onClick={() => funding.open("withdraw")}>
                Withdraw to wallet
              </Button>
            </td>
          </tr>
          {[
            { id: "core", label: "Core", query: vault },
            { id: "long-tail", label: "Long-tail", query: longTail },
          ].map(({ id, label, query }) => (
            <tr key={id} className="h-9 border-t border-border">
              <th scope="row" className="px-3 text-left font-normal">{label} vault shares</th>
              <td className="px-3 text-right">{query.data ? formatShares(query.data.shares) : "—"}</td>
              <td className="px-3 text-right text-tertiary" title="Withdrawals depend on the vault's unreserved liquidity">Subject to reserves</td>
              <td className="px-3 text-right">{query.data ? formatUsd(query.data.value) : "—"}</td>
              <td className="px-3 text-right">
                <Link href={`/vaults/${id}`} className="text-foreground underline-offset-4 hover:underline">
                  Manage on Vaults
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Loading, error and empty states shared by the account tabs; `children` renders the data. */
function QueryState({
  query,
  what,
  empty,
  isEmpty,
  children,
}: {
  query: { isPending: boolean; isError: boolean; error: Error | null; refetch: () => unknown };
  what: string;
  empty: string;
  isEmpty: boolean;
  children: () => ReactNode;
}) {
  if (query.isPending) return <Skeleton className="m-3 h-20" />;
  if (query.isError) {
    return <ErrorState className="m-3" title={`${what} unavailable right now.`} error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (isEmpty) return <EmptyState>{empty}</EmptyState>;
  return <>{children()}</>;
}

/** Balances, positions, orders and history under the chart, like most perps screens. */
export function AccountPanel({ className }: { className?: string }) {
  const nowMs = useNow();
  const accountId = useAccountId();
  const positions = usePositions();
  const orders = useOrders();
  const history = useHistory();
  const liquidations = useLiquidations();
  const config = useConfig();
  const [tab, setTab] = useState<Tab>("positions");
  const count = positions.data?.length ?? 0;
  const orderCount = orders.data?.length ?? 0;
  const events = history.data ?? [];

  const tabs = [
    { id: "balances", label: "Balances", testId: "account-tab-balances" },
    { id: "positions", label: count > 0 ? `Positions (${count})` : "Positions", testId: "account-tab-positions" },
    { id: "orders", label: orderCount > 0 ? `Open Orders (${orderCount})` : "Open Orders", testId: "account-tab-orders" },
    { id: "trades", label: "Trade History", testId: "account-tab-trades" },
    { id: "funding", label: "Funding History", testId: "account-tab-funding" },
    { id: "order-history", label: "Order History", testId: "account-tab-order-history" },
    { id: "liquidations", label: "Liquidations", testId: "account-tab-liquidations" },
  ] as const;

  let panel: ReactNode;
  if (tab === "liquidations") {
    panel = (
      <QueryState
        query={liquidations}
        what="Liquidation history is"
        empty="No liquidations yet. A position is liquidated when its equity falls to its maintenance margin."
        isEmpty={liquidations.data?.length === 0}
      >
        {() => <LiquidationsTable liquidations={liquidations.data ?? []} keeperId={config.data?.keeper_id ?? null} accountId={accountId} />}
      </QueryState>
    );
  } else if (!accountId) {
    panel = <EmptyState>{SIGNED_OUT}</EmptyState>;
  } else if (tab === "balances") {
    panel = <Balances />;
  } else if (tab === "positions") {
    panel = (
      <QueryState query={positions} what="Positions are" empty="No open positions yet." isEmpty={count === 0}>
        {() => <PositionsTable positions={positions.data ?? []} orders={orders.data ?? []} />}
      </QueryState>
    );
  } else if (tab === "orders") {
    panel = (
      <QueryState
        query={orders}
        what="Open orders are"
        empty="No open orders. Place a Limit or Stop order, or attach a take profit / stop loss, from the order panel."
        isEmpty={orderCount === 0}
      >
        {() => <OpenOrdersTable orders={orders.data ?? []} positions={positions.data ?? []} />}
      </QueryState>
    );
  } else if (tab === "trades") {
    panel = (
      <QueryState
        query={history}
        what="Trade history is"
        empty="No trades yet. Entries, reductions and exits show here."
        isEmpty={!events.some((e) => e.kind === "open" || e.kind === "close" || e.kind === "reduce" || e.kind === "liquidation")}
      >
        {() => <TradeHistoryTable events={events} />}
      </QueryState>
    );
  } else if (tab === "funding") {
    panel = (
      <QueryState
        query={history}
        what="Funding history is"
        empty="No funding settled yet. Funding is booked here when a position closes; open positions show their running funding under Positions."
        isEmpty={!events.some((e) => e.kind === "funding")}
      >
        {() => <FundingHistoryTable events={events} />}
      </QueryState>
    );
  } else {
    const rows = orderHistoryRows(events, orders.data ?? [], positions.data ?? [], nowMs);
    panel = (
      <QueryState
        query={history}
        what="Order history is"
        empty="No orders yet. Limit, Stop, take profit and stop loss orders show here, open or filled."
        isEmpty={rows.length === 0}
      >
        {() => <OrderHistoryTable rows={rows} />}
      </QueryState>
    );
  }

  return (
    <section aria-label="Your account" className={cn("flex min-h-0 min-w-0 flex-col rounded-md border border-border bg-card", className)}>
      <PanelTabs tabs={tabs} value={tab} onChange={setTab} label="Account" idPrefix="account" />
      <div id="account-panel" role="tabpanel" aria-labelledby={`account-tab-${tab}`} className="min-h-0 flex-1 overflow-y-auto">
        {panel}
      </div>
    </section>
  );
}
