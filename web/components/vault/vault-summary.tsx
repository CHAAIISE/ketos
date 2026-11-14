"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import type { UseQueryResult } from "@tanstack/react-query";
import { ErrorState, Skeleton } from "@/components/app/states";
import { formatAge, formatUtc, useNow } from "@/components/landing/live-time";
import { useWallet } from "@/hooks/near-provider";
import { useVaultAccount } from "@/hooks/use-ketos-queries";
import { networkName } from "@/lib/near/config";
import { formatBps, formatUsd, formatVaultName } from "@/lib/near/format";
import type { Vault, VaultId } from "@/lib/near/types";
import { cn } from "@/lib/utils";
import { Term } from "./term";
import { formatShares } from "./vault-math";

export function ReadAt({ at, failing }: { at: number; failing: boolean }) {
  const nowMs = useNow();
  if (!nowMs || !at) return null;
  const age = formatAge(at, nowMs);
  return (
    <span className={cn("flex items-center gap-2 text-label tabular-nums", failing ? "text-warning" : "text-tertiary")}>
      <span aria-hidden className={cn("size-1.5 rounded-pill", failing ? "bg-warning" : "bg-success")} />
      {failing ? "Last read" : "Live · read"} {formatUtc(at, true)}
      {age ? ` · ${age}` : null}
      {failing ? " · retrying" : null}
    </span>
  );
}

/** Small grey label above a white value, as in the header stats row. */
export function HeaderStat({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-label text-tertiary">{label}</dt>
      <dd className="text-subtitle leading-tight text-foreground tabular-nums">{children}</dd>
    </div>
  );
}

/** Value of the signed-in account's vault shares; a dash while signed out. */
function YourDeposit({ vaultId }: { vaultId: VaultId }) {
  const wallet = useWallet();
  const position = useVaultAccount(vaultId);
  if (wallet.accountId === null) return <>—</>;
  if (position.isPending) return <Skeleton className="h-6 w-20" />;
  if (position.isError) return <span className="text-tertiary">—</span>;
  return <>{formatUsd(position.data.value)}</>;
}

const panel = "flex min-w-0 flex-col gap-4 rounded-md border border-border bg-card p-4";

export function VaultHeader({ query, vaultId }: { query: UseQueryResult<Vault>; vaultId: VaultId }) {
  const vault = query.data;
  return (
    <section aria-label="Vault overview" className={panel}>
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between md:gap-6">
        <div className="flex min-w-0 flex-col gap-1">
          <Link href="/vaults" className="mb-1 text-label text-muted-foreground hover:text-foreground">← All vaults</Link>
          <h1 className="text-heading text-foreground">{formatVaultName(vaultId, vault?.market_id)} Vault</h1>
          <p className="text-ui text-muted-foreground">
            Provide USDC and earn trading fees. You take the other side of traders.
          </p>
        </div>
        <ReadAt at={query.dataUpdatedAt} failing={query.isError} />
      </div>
      {vault ? (
        <dl className="flex flex-wrap gap-x-10 gap-y-4">
          <HeaderStat
            label={
              <Term hint="Total value locked (TVL), shown as net asset value (NAV): the vault's accounting assets minus traders' unrealized profit or loss, plus fees and funding owed. Includes money owed by cross-margin accounts, which is not withdrawable cash.">
                TVL
              </Term>
            }
          >
            <span data-testid="vault-nav">{formatUsd(vault.nav)}</span>
          </HeaderStat>
          <HeaderStat
            label={
              <Term hint="Fees over the trailing 7 UTC days (trading, borrow, liquidation and listing), annualized over current NAV. Excludes funding and trader PnL. Not a promised return.">
                Fee APR · 7D
              </Term>
            }
          >
            {formatBps(vault.fee_apr_bps)}
          </HeaderStat>
          <HeaderStat label="Your Deposit">
            <YourDeposit vaultId={vaultId} />
          </HeaderStat>
          <HeaderStat
            label={<Term hint="Net asset value (NAV) divided by the number of vault shares. It rises with fees and trader losses.">Share Price</Term>}
          >
            {formatUsd(vault.share_price, { maxFractionDigits: 4 })}
          </HeaderStat>
          <HeaderStat
            label={
              <Term hint="Vault USDC not reserved for open positions. Withdrawals above it are refused.">
                Available to withdraw
              </Term>
            }
          >
            {formatUsd(vault.available)}
          </HeaderStat>
        </dl>
      ) : query.isError ? (
        <ErrorState title={`Could not read the vault from ${networkName()}.`} error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <div className="flex flex-wrap gap-x-10 gap-y-4" aria-busy>
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex flex-col gap-1">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-6 w-24" />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-label text-tertiary">{label}</dt>
      <dd className="text-ui text-foreground tabular-nums">
        {value}
        {hint ? <span className="ml-1.5 text-label text-tertiary">{hint}</span> : null}
      </dd>
    </div>
  );
}

/** Share of the vault balance backing open positions vs free to withdraw. */
function ReserveBar({ vault }: { vault: Vault }) {
  const reservedPct = vault.balance === 0n ? 0 : Number((vault.reserved * 10_000n) / vault.balance) / 100;
  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="img"
        aria-label={`${reservedPct.toFixed(1)}% of the vault balance is reserved for open positions`}
        className="flex h-1 w-full overflow-hidden rounded-pill bg-muted"
      >
        <div className="h-full bg-warning" style={{ width: `${reservedPct}%` }} />
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-label tabular-nums">
        <span className="text-tertiary">
          <span className="text-foreground">{formatUsd(vault.reserved)}</span> reserved for open positions
        </span>
        <span className="text-tertiary">
          <span className="text-foreground">{formatUsd(vault.balance)}</span> USDC held by the vault
        </span>
      </div>
    </div>
  );
}

/** Reserve split and the NAV components below the performance chart. */
export function PerformanceStats({ query, className }: { query: UseQueryResult<Vault>; className?: string }) {
  const vault = query.data;
  if (!vault) {
    if (query.isError) return null;
    return (
      <div className={cn("flex flex-col gap-3", className)} aria-busy>
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <ReserveBar vault={vault} />
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
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
        <Stat label="Fees, last 7 days" value={formatUsd(vault.fees_7d)} />
        <Stat label={<Term hint="Unsettled funding attributable to the vault. Positive means the vault is owed money; negative means it owes traders. Funding is the periodic payment between long and short positions.">Net funding due</Term>} value={formatUsd(vault.funding_net_due, { signed: true })} />
        <Stat label={<Term hint="Money owed to this vault by cross-margin accounts whose cash balance is negative. Included in accounting assets, but fully reserved and unavailable for withdrawals until repaid.">Cross receivables</Term>} value={formatUsd(vault.cross_receivable)} />
        <Stat label="Total shares" value={formatShares(vault.total_shares)} />
      </dl>
    </div>
  );
}
