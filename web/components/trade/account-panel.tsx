"use client";

import { useState } from "react";
import Link from "next/link";
import { useFundingDialog } from "@/components/app/funding";
import { EmptyState, ErrorState, Skeleton } from "@/components/app/states";
import { Button } from "@/components/ui/button";
import { PanelTabs } from "@/components/ui/panel-tabs";
import { useAccountId } from "@/hooks/near-provider";
import { useAccount, useConfig, useLiquidations, usePositions, useVaultAccount } from "@/hooks/use-ketos-queries";
import { formatUsd } from "@/lib/near/format";
import { formatShares } from "@/components/vault/vault-math";
import { cn } from "@/lib/utils";
import { LiquidationsTable } from "./liquidations-table";
import { PositionsTable } from "./positions-table";

type Tab = "balances" | "positions" | "liquidations";

const SIGNED_OUT = "Connect a wallet to see your balances and positions.";

const th = "px-3 font-normal whitespace-nowrap";

function Balances() {
  const account = useAccount();
  const positions = usePositions();
  const vault = useVaultAccount("core");
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
          <tr className="h-9 border-t border-border">
            <th scope="row" className="px-3 text-left font-normal">Vault shares</th>
            <td className="px-3 text-right">{vault.data ? formatShares(vault.data.shares) : "—"}</td>
            <td className="px-3 text-right">{vault.data ? formatShares(vault.data.shares) : "—"}</td>
            <td className="px-3 text-right">{vault.data ? formatUsd(vault.data.value) : "—"}</td>
            <td className="px-3 text-right">
              <Link href="/vault" className="text-foreground underline-offset-4 hover:underline">
                Manage on Vaults
              </Link>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** Balances, positions and liquidations under the chart, like most perps screens. */
export function AccountPanel({ className }: { className?: string }) {
  const accountId = useAccountId();
  const positions = usePositions();
  const liquidations = useLiquidations();
  const config = useConfig();
  const [tab, setTab] = useState<Tab>("positions");
  const count = positions.data?.length ?? 0;

  const tabs = [
    { id: "balances", label: "Balances", testId: "account-tab-balances" },
    { id: "positions", label: count > 0 ? `Positions (${count})` : "Positions", testId: "account-tab-positions" },
    { id: "liquidations", label: "Liquidations", testId: "account-tab-liquidations" },
  ] as const;

  return (
    <section aria-label="Your account" className={cn("flex min-h-0 min-w-0 flex-col rounded-md border border-border bg-card", className)}>
      <PanelTabs tabs={tabs} value={tab} onChange={setTab} label="Account" idPrefix="account" />
      <div id="account-panel" role="tabpanel" aria-labelledby={`account-tab-${tab}`} className="min-h-0 flex-1 overflow-y-auto">
        {tab === "balances" ? (
          !accountId ? <EmptyState>{SIGNED_OUT}</EmptyState> : <Balances />
        ) : tab === "positions" ? (
          !accountId ? (
            <EmptyState>{SIGNED_OUT}</EmptyState>
          ) : positions.isPending ? (
            <Skeleton className="m-3 h-20" />
          ) : positions.isError ? (
            <ErrorState className="m-3" title="Positions are unavailable right now." error={positions.error} onRetry={() => void positions.refetch()} />
          ) : count === 0 ? (
            <EmptyState>No open positions yet.</EmptyState>
          ) : (
            <PositionsTable positions={positions.data} />
          )
        ) : liquidations.isPending ? (
          <Skeleton className="m-3 h-20" />
        ) : liquidations.isError ? (
          <ErrorState className="m-3" title="Liquidation history is unavailable right now." error={liquidations.error} onRetry={() => void liquidations.refetch()} />
        ) : liquidations.data.length === 0 ? (
          <EmptyState>No liquidations yet. A position is liquidated when its equity falls to its maintenance margin.</EmptyState>
        ) : (
          <LiquidationsTable liquidations={liquidations.data} keeperId={config.data?.keeper_id ?? null} accountId={accountId} />
        )}
      </div>
    </section>
  );
}
