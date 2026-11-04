"use client";

import { useEffect } from "react";
import { ExternalLink } from "lucide-react";
import { useNear } from "@/hooks/near-provider";
import { useMarkets, useVault } from "@/hooks/use-ketos-queries";
import type { NearNetwork } from "@/lib/near/config";
import { accountExplorerUrl } from "@/lib/near/explorer";
import { ExposureTable } from "./exposure-table";
import { NavChart } from "./nav-chart";
import { recordNavPoint, useNavHistory } from "./nav-history";
import { PanelHeading } from "./panel-heading";
import { PerformanceStats, VaultHeader } from "./vault-summary";
import { VaultTicket } from "./vault-ticket";

function VaultDetails({ contractId, network }: { contractId: string; network: NearNetwork }) {
  const explorer = accountExplorerUrl(network, contractId);
  return (
    <details className="rounded-md border border-border bg-card px-3 py-2 text-ui">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Details</summary>
      <dl className="mt-3 mb-1 grid gap-x-6 gap-y-2 text-muted-foreground sm:grid-cols-[auto_1fr]">
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
        <dt className="text-tertiary">TVL (NAV)</dt>
        <dd>balance − traders&apos; unrealized PnL + borrow fees due</dd>
        <dt className="text-tertiary">Share price</dt>
        <dd>NAV × 1 share ÷ total shares, rounded down</dd>
        <dt className="text-tertiary">APR</dt>
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
  const history = useNavHistory(config.ketosContract);

  useEffect(() => {
    if (!vault.data) return;
    recordNavPoint(config.ketosContract, {
      t: vault.dataUpdatedAt,
      nav: vault.data.nav,
      sharePrice: vault.data.share_price,
    });
  }, [config.ketosContract, vault.data, vault.dataUpdatedAt]);

  return (
    <>
      <VaultHeader query={vault} />
      <div className="grid flex-1 gap-1 lg:grid-cols-12 lg:grid-rows-[auto_1fr]">
        <VaultTicket
          vault={vault.data}
          loading={vault.isPending}
          className="lg:col-span-4 lg:col-start-9 lg:row-span-2 lg:row-start-1"
        />
        <section
          aria-labelledby="vault-performance-title"
          className="flex min-w-0 flex-col rounded-md border border-border bg-card lg:col-span-8 lg:col-start-1 lg:row-start-1"
        >
          <PanelHeading id="vault-performance-title">Vault Performance</PanelHeading>
          <NavChart points={history} loading={vault.isPending} className="p-3" />
          <PerformanceStats query={vault} className="border-t border-border p-3" />
        </section>
        <div className="flex min-w-0 flex-col gap-1 lg:col-span-8 lg:col-start-1 lg:row-start-2">
          <ExposureTable query={markets} />
          <VaultDetails contractId={config.ketosContract} network={config.network} />
        </div>
      </div>
    </>
  );
}
