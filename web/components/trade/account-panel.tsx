"use client";

import { useState } from "react";
import { formatUtc } from "@/components/landing/live-time";
import { EmptyState, ErrorState, Skeleton } from "@/components/app/states";
import type { KeeperStatus } from "@/hooks/use-keeper-tick";
import { useAccountId } from "@/hooks/near-provider";
import { useAccount, useConfig, useLiquidations, usePositions } from "@/hooks/use-perps-queries";
import { formatUsd } from "@/lib/near/format";
import { DepositMarginForm, WithdrawMarginForm } from "./funding";
import { LiquidationsTable } from "./liquidations-table";
import { PositionsTable } from "./positions-table";

const TABS = [
  { id: "positions", label: "Positions" },
  { id: "liquidations", label: "Liquidations" },
  { id: "margin", label: "Margin" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const SIGNED_OUT = "Connect your wallet to see your positions and margin.";

function KeeperLine({ status }: { status: KeeperStatus }) {
  const text =
    status.state === "ran"
      ? `Keeper ran at ${formatUtc(status.atMs, true)}${status.liquidated > 0 ? ` and liquidated ${status.liquidated} position${status.liquidated === 1 ? "" : "s"}` : ", nothing to liquidate"}.`
      : status.state === "running"
        ? "Keeper is checking every open position…"
        : status.state === "unavailable"
          ? `Keeper unavailable: ${status.reason}`
          : "Keeper checks every open position once a minute while this page is open.";
  return (
    <p data-testid="keeper-status" className={status.state === "unavailable" ? "text-label text-warning" : "text-label text-tertiary"}>
      {text}
    </p>
  );
}

/** Positions, liquidation history and margin moves, under the chart area like most perps screens. */
export function AccountPanel({ keeper }: { keeper: KeeperStatus }) {
  const accountId = useAccountId();
  const positions = usePositions();
  const account = useAccount();
  const liquidations = useLiquidations();
  const config = useConfig();
  const [tab, setTab] = useState<Tab>("positions");
  const count = positions.data?.length ?? 0;

  return (
    <section aria-label="Your account" className="flex flex-col rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2 md:px-4">
        <div role="tablist" aria-label="Account" className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`account-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="account-tabpanel"
              data-testid={`account-tab-${t.id}`}
              onClick={() => setTab(t.id)}
              className="shrink-0 rounded-md px-2.5 py-1.5 text-ui font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring aria-selected:bg-muted aria-selected:text-foreground"
            >
              {t.label}
              {t.id === "positions" && count > 0 ? <span className="ml-1.5 tabular-nums text-tertiary">{count}</span> : null}
            </button>
          ))}
        </div>
        {tab === "liquidations" ? <KeeperLine status={keeper} /> : null}
      </div>

      <div id="account-tabpanel" role="tabpanel" aria-labelledby={`account-tab-${tab}`}>
        {tab === "positions" ? (
          !accountId ? (
            <EmptyState>{SIGNED_OUT}</EmptyState>
          ) : positions.isPending ? (
            <Skeleton className="mx-4 mb-4 h-20" />
          ) : positions.isError ? (
            <ErrorState className="m-4" title="Positions are unavailable right now." error={positions.error} onRetry={() => void positions.refetch()} />
          ) : count === 0 ? (
            <EmptyState>No positions yet. Pick a side, a margin and a leverage in the order ticket.</EmptyState>
          ) : (
            <PositionsTable positions={positions.data} />
          )
        ) : tab === "liquidations" ? (
          liquidations.isPending ? (
            <Skeleton className="mx-4 mb-4 h-20" />
          ) : liquidations.isError ? (
            <ErrorState className="m-4" title="Liquidation history is unavailable right now." error={liquidations.error} onRetry={() => void liquidations.refetch()} />
          ) : liquidations.data.length === 0 ? (
            <EmptyState>No liquidations yet. A position is liquidated when its equity falls to its maintenance margin.</EmptyState>
          ) : (
            <LiquidationsTable liquidations={liquidations.data} keeperId={config.data?.keeper_id ?? null} accountId={accountId} />
          )
        ) : !accountId ? (
          <EmptyState>{SIGNED_OUT}</EmptyState>
        ) : account.isPending ? (
          <Skeleton className="mx-4 mb-4 h-40" />
        ) : account.isError ? (
          <ErrorState className="m-4" title="Your margin is unavailable right now." error={account.error} onRetry={() => void account.refetch()} />
        ) : (
          <div className="grid gap-6 px-4 pt-2 pb-4 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_minmax(0,1fr)] md:gap-8">
            <dl className="flex gap-8 md:flex-col md:gap-3">
              <div className="flex flex-col gap-0.5">
                <dt className="text-label text-tertiary">Free margin</dt>
                <dd className="text-heading tabular-nums text-foreground" data-testid="margin-free">
                  {formatUsd(account.data.margin)}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-label text-tertiary">Wallet</dt>
                <dd className="text-ui tabular-nums text-muted-foreground">{formatUsd(account.data.usdcBalance)} tUSDC</dd>
              </div>
            </dl>
            <div className="flex flex-col gap-2">
              <h3 className="text-ui font-medium text-foreground">Deposit</h3>
              <DepositMarginForm account={account.data} primary={false} />
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="text-ui font-medium text-foreground">Withdraw</h3>
              <WithdrawMarginForm account={account.data} />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
