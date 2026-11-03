"use client";

import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { ErrorState, Skeleton } from "@/components/app/states";
import { formatBps, formatUsd } from "@/lib/near/format";
import type { Vault } from "@/lib/near/types";
import { cn } from "@/lib/utils";
import { Term } from "./term";
import { formatShares } from "./vault-math";

function Stat({ label, value, hint, className }: { label: ReactNode; value: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-label text-tertiary">{label}</span>
      <span className="text-sm font-medium text-foreground tabular-nums">{value}</span>
      {hint ? <span className="text-label text-tertiary">{hint}</span> : null}
    </div>
  );
}

/** Share of the vault balance backing open positions vs free to withdraw. */
function ReserveBar({ vault }: { vault: Vault }) {
  const reservedPct = vault.balance === 0n ? 0 : Number((vault.reserved * 10_000n) / vault.balance) / 100;
  return (
    <div className="flex flex-col gap-2">
      <div
        role="img"
        aria-label={`${reservedPct.toFixed(1)}% of the vault balance is reserved for open positions`}
        className="flex h-1.5 w-full overflow-hidden rounded-pill bg-muted"
      >
        <div className="h-full bg-warning" style={{ width: `${reservedPct}%` }} />
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-ui tabular-nums">
        <span className="text-muted-foreground">
          <span className="text-foreground">{formatUsd(vault.reserved)}</span> reserved for open positions
        </span>
        <span className="text-muted-foreground">
          <span className="text-foreground">{formatUsd(vault.available)}</span> available to withdraw
        </span>
      </div>
    </div>
  );
}

export function VaultSummary({ query, className }: { query: UseQueryResult<Vault>; className?: string }) {
  const panel = cn("flex min-w-0 flex-col gap-5 rounded-lg border border-border bg-card p-4", className);

  if (query.isPending) {
    return (
      <section className={panel} aria-busy>
        <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-10" />
            <Skeleton className="h-11 w-56" />
            <Skeleton className="h-4 w-36" />
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-28" />
            ))}
          </div>
        </div>
        <Skeleton className="h-8 w-full" />
      </section>
    );
  }

  if (query.isError) {
    return (
      <section className={className}>
        <ErrorState title="Could not read the vault from NEAR testnet." error={query.error} onRetry={() => void query.refetch()} />
      </section>
    );
  }

  const vault = query.data;
  return (
    <section aria-label="Vault value" className={panel}>
      <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between md:gap-8">
        <div className="flex flex-col gap-1">
          <span className="text-label text-tertiary">
            <Term hint="Net asset value: the vault's USDC balance, minus what traders are winning, plus borrow fees they owe.">
              NAV
            </Term>
          </span>
          <span data-testid="vault-nav" className="text-title font-medium text-foreground tabular-nums">
            {formatUsd(vault.nav)}
          </span>
          <span className="text-ui text-muted-foreground tabular-nums">
            {formatUsd(vault.balance)} USDC held by the vault
          </span>
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3">
          <Stat
            label={<Term hint="NAV divided by the number of vault shares. It rises with fees and trader losses.">Share price</Term>}
            value={formatUsd(vault.share_price, { maxFractionDigits: 4 })}
          />
          <Stat
            label={
              <Term hint="Fees earned over the trailing 7 days (trading, borrow and liquidation fees), annualized over NAV. Past fees, not a promise.">
                Fee APR
              </Term>
            }
            value={formatBps(vault.fee_apr_bps)}
            hint="from 7-day trailing fees"
          />
          <Stat label="Fees, last 7 days" value={formatUsd(vault.fees_7d)} />
          <Stat
            label={
              <Term hint="What traders would make if they all closed now. When positive, it is owed by the vault and lowers NAV.">
                Traders&apos; unrealized PnL
              </Term>
            }
            value={formatUsd(vault.traders_unrealized_pnl, { signed: true })}
          />
          <Stat
            label={<Term hint="Borrow fees accrued on open positions, paid to the vault when they close.">Borrow fees due</Term>}
            value={formatUsd(vault.borrow_fees_due)}
          />
          <Stat label="Total shares" value={formatShares(vault.total_shares)} />
        </div>
      </div>
      <ReserveBar vault={vault} />
    </section>
  );
}
