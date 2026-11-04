"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { ErrorState } from "@/components/app/states";
import { PanelTabs } from "@/components/ui/panel-tabs";
import { useNear } from "@/hooks/near-provider";
import {
  useMarkets,
  useVault,
  useVaultHistory,
} from "@/hooks/use-ketos-queries";
import type { NearNetwork } from "@/lib/near/config";
import { accountExplorerUrl } from "@/lib/near/explorer";
import type { VaultId } from "@/lib/near/types";
import { ExposureTable } from "./exposure-table";
import { NavChart } from "./nav-chart";
import { RevenueChart } from "./revenue-chart";
import { PerformanceStats, VaultHeader } from "./vault-summary";
import { VaultTicket } from "./vault-ticket";
import {
  historyPoints,
  pointsInRange,
  RANGES,
  revenueBuckets,
  type HistoryRange,
} from "./vault-history";

function VaultDetails({
  contractId,
  network,
}: {
  contractId: string;
  network: NearNetwork;
}) {
  const explorer = accountExplorerUrl(network, contractId);
  return (
    <details className="rounded-md border border-border bg-card px-3 py-2 text-ui">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
        Details
      </summary>
      <dl className="mt-3 mb-1 grid gap-x-6 gap-y-2 text-muted-foreground sm:grid-cols-[auto_1fr]">
        <dt className="text-tertiary">Contract</dt>
        <dd className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-label text-foreground">
            {contractId}
          </span>
          {explorer ? (
            <a
              href={explorer}
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-1 text-label text-tertiary hover:text-foreground"
            >
              Explorer <ExternalLink className="size-3" />
            </a>
          ) : null}
        </dd>
        <dt className="text-tertiary">Views</dt>
        <dd className="break-words font-mono text-label">
          get_vault · get_vault_account · get_vault_history · get_markets
        </dd>
        <dt className="text-tertiary">NAV</dt>
        <dd>
          Accounting assets − traders&apos; unrealized PnL + borrow fees + net
          funding due. Cross receivables are included in assets but reserved in
          full.
        </dd>
        <dt className="text-tertiary">Share price</dt>
        <dd>
          NAV × 1 share ÷ total shares, rounded down. Deposits and withdrawals
          mint/burn shares at current NAV.
        </dd>
        <dt className="text-tertiary">Fee APR</dt>
        <dd>
          Fees of the trailing 7 UTC days × 365 ÷ 7 ÷ current NAV. Not an
          annualized share-price return.
        </dd>
        <dt className="text-tertiary">Withdrawal</dt>
        <dd>
          Shares × NAV ÷ total shares, rounded down; refused above unreserved
          assets. Reserves cover maximum position payouts, funding credits and
          cross receivables.
        </dd>
        <dt className="text-tertiary">History</dt>
        <dd>
          Up to 168 hourly onchain snapshots. Missed hours are not backfilled.
          The latest read is appended and explicitly labelled live.
        </dd>
      </dl>
    </details>
  );
}

export function VaultView({ vaultId }: { vaultId: VaultId }) {
  const { config } = useNear();
  const vault = useVault(vaultId);
  const markets = useMarkets();
  const history = useVaultHistory(vaultId);
  const [range, setRange] = useState<HistoryRange>("24h");
  const [metric, setMetric] = useState<"nav" | "sharePrice">("nav");
  const at = vault.dataUpdatedAt;
  const points = historyPoints(
    history.data ?? [],
    vault.data ? { vault: vault.data, at } : null,
  );
  const shown = pointsInRange(points, range, at);
  const buckets = revenueBuckets(points, range, at);
  return (
    <>
      <VaultHeader query={vault} vaultId={vaultId} />
      <div className="grid gap-1 lg:grid-cols-12">
        <VaultTicket
          vaultId={vaultId}
          vault={vault.data}
          loading={vault.isPending}
          className="lg:col-span-4 lg:col-start-9 lg:row-start-1"
        />
        <section
          aria-label="Vault performance"
          className="flex min-w-0 flex-col rounded-md border border-border bg-card lg:col-span-8 lg:col-start-1 lg:row-start-1"
        >
          <div className="flex flex-wrap items-center justify-between gap-x-4 border-b border-border px-3">
            <PanelTabs
              idPrefix="vault-metric"
              label="Performance metric"
              value={metric}
              onChange={setMetric}
              tabs={[
                { id: "nav", label: "NAV" },
                { id: "sharePrice", label: "Share Price" },
              ]}
            />
            <div role="group" aria-label="History range" className="flex gap-1">
              {RANGES.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  aria-pressed={range === r.id}
                  onClick={() => setRange(r.id)}
                  className="rounded-sm px-3 py-1 text-label text-tertiary hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring aria-pressed:bg-muted aria-pressed:text-foreground"
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          {history.isError ? (
            <ErrorState
              className="m-3"
              title="Onchain snapshots could not be refreshed."
              error={history.error}
              onRetry={() => void history.refetch()}
            />
          ) : null}
          <div
            id="vault-metric-panel"
            role="tabpanel"
            aria-labelledby={`vault-metric-tab-${metric}`}
          >
            <NavChart
              key={`${vaultId}-${range}-${metric}`}
              points={shown}
              metric={metric}
              loading={history.isPending || vault.isPending}
            />
          </div>
          <PerformanceStats
            query={vault}
            className="border-t border-border p-3"
          />
        </section>
      </div>
      <div className="grid items-start gap-1 xl:grid-cols-12">
        <div className="min-w-0 xl:col-span-7">
          <ExposureTable query={markets} vaultId={vaultId} />
        </div>
        <div className="min-w-0 xl:col-span-5">
          {vault.data ? (
            <RevenueChart
              buckets={buckets}
              range={range}
              allTime={vault.data.revenue}
            />
          ) : null}
        </div>
      </div>
      <VaultDetails
        contractId={config.ketosContract}
        network={config.network}
      />
    </>
  );
}
