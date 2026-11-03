"use client";

import { useEffect } from "react";
import { ExternalLink } from "lucide-react";
import { formatAge, formatUtc, useNow } from "@/components/landing/live-time";
import { PageHeader } from "@/components/ui/page-shell";
import { useNear } from "@/hooks/near-provider";
import { useMarkets, useVault } from "@/hooks/use-perps-queries";
import type { NearNetwork } from "@/lib/near/config";
import { accountExplorerUrl } from "@/lib/near/explorer";
import { cn } from "@/lib/utils";
import { ExposureTable } from "./exposure-table";
import { NavChart } from "./nav-chart";
import { recordNavPoint, useNavHistory } from "./nav-history";
import { VaultSummary } from "./vault-summary";
import { VaultTicket } from "./vault-ticket";

function ReadAt({ at, failing }: { at: number; failing: boolean }) {
  const nowMs = useNow();
  const { config } = useNear();
  if (!at) return null;
  const age = formatAge(at, nowMs);
  const source = config.network === "testnet" ? "NEAR testnet" : "the local sandbox";
  return (
    <span className={cn("flex items-center gap-2 text-label tabular-nums", failing ? "text-warning" : "text-tertiary")}>
      <span aria-hidden className={cn("size-1.5 rounded-pill", failing ? "bg-warning" : "bg-success")} />
      {failing ? "Last read" : `Live from ${source} · read`} {formatUtc(at, true)}
      {age ? ` · ${age}` : null}
      {failing ? " · retrying" : null}
    </span>
  );
}

function VaultDetails({ contractId, network }: { contractId: string; network: NearNetwork }) {
  const explorer = accountExplorerUrl(network, contractId);
  return (
    <details className="rounded-lg border border-border bg-card px-4 py-3 text-ui">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Details</summary>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-muted-foreground sm:grid-cols-[auto_1fr]">
        <dt className="text-tertiary">Contract</dt>
        <dd className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-label text-foreground">{contractId}</span>
          {explorer ? (
            <a href={explorer} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-label text-tertiary hover:text-foreground">
              Explorer <ExternalLink strokeWidth={1.5} className="size-3" />
            </a>
          ) : null}
        </dd>
        <dt className="text-tertiary">Views</dt>
        <dd className="font-mono text-label">get_vault · get_vault_account · get_markets</dd>
        <dt className="text-tertiary">NAV</dt>
        <dd>balance − traders&apos; unrealized PnL + borrow fees due</dd>
        <dt className="text-tertiary">Share price</dt>
        <dd>NAV × 1 share ÷ total shares, rounded down</dd>
        <dt className="text-tertiary">Fee APR</dt>
        <dd>fees of the trailing 7 UTC days × 365 ÷ 7 ÷ NAV</dd>
        <dt className="text-tertiary">Reserved</dt>
        <dd>sum of the size of every open position (its maximum gain), capped at the balance</dd>
        <dt className="text-tertiary">Withdrawal</dt>
        <dd>shares × NAV ÷ total shares, rounded down; refused above balance − reserved</dd>
        <dt className="text-tertiary">Max OI per side</dt>
        <dd>min(hard cap, exit capacity within 100 bps of impact on NEAR Intents 1Click)</dd>
      </dl>
    </details>
  );
}

export function VaultView() {
  const { config } = useNear();
  const vault = useVault();
  const markets = useMarkets();
  const history = useNavHistory(config.perpsContract);

  useEffect(() => {
    if (!vault.data) return;
    recordNavPoint(config.perpsContract, {
      t: vault.dataUpdatedAt,
      nav: vault.data.nav,
      sharePrice: vault.data.share_price,
    });
  }, [config.perpsContract, vault.data, vault.dataUpdatedAt]);

  return (
    <>
      <PageHeader
        title="Vault"
        description="Provide USDC and earn trading fees. You take the other side of traders."
        actions={<ReadAt at={vault.dataUpdatedAt} failing={vault.isError} />}
      />
      <div className="grid flex-1 gap-1 lg:grid-cols-12 lg:grid-rows-[auto_auto_1fr]">
        <VaultSummary query={vault} className="lg:col-span-8 lg:col-start-1 lg:row-start-1" />
        <VaultTicket
          vault={vault.data}
          loading={vault.isPending}
          className="lg:col-span-4 lg:col-start-9 lg:row-span-3 lg:row-start-1"
        />
        <NavChart
          points={history}
          loading={vault.isPending}
          className="lg:col-span-8 lg:col-start-1 lg:row-start-2"
        />
        <div className="flex min-w-0 flex-col gap-1 lg:col-span-8 lg:col-start-1 lg:row-start-3">
          <ExposureTable query={markets} />
          <VaultDetails contractId={config.perpsContract} network={config.network} />
        </div>
      </div>
    </>
  );
}
