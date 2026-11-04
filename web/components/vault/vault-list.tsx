"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { ErrorState, Skeleton } from "@/components/app/states";
import { useWallet } from "@/hooks/near-provider";
import {
  useMarkets,
  useVaultAccount,
  useVaults,
} from "@/hooks/use-ketos-queries";
import { formatBps, formatUsd } from "@/lib/near/format";
import type { Market, Vault } from "@/lib/near/types";
import { cn } from "@/lib/utils";
import { HeaderStat, ReadAt } from "./vault-summary";
import { Term } from "./term";
import { totalRevenue } from "./vault-history";
import { formatShares } from "./vault-math";

const cell = "px-4 py-4 text-right whitespace-nowrap";

function VaultRow({
  vault,
  markets,
}: {
  vault: Vault;
  markets: Market[] | undefined;
}) {
  const wallet = useWallet();
  const account = useVaultAccount(vault.id);
  const pnl = totalRevenue(vault.revenue);
  const core = vault.id === "core";
  return (
    <tr
      className="border-t border-border text-ui tabular-nums hover:bg-muted/40"
      data-testid={`vault-row-${vault.id}`}
    >
      <th scope="row" className="px-4 py-4 text-left font-normal">
        <Link
          href={`/vaults/${vault.id}`}
          className="inline-flex items-center gap-2 font-medium text-foreground hover:underline"
        >
          {core ? "Core" : "Long-tail"}{" "}
          <ArrowUpRight className="size-3.5 text-tertiary" />
        </Link>
        <p className="mt-1 text-label text-tertiary">
          {core
            ? "BTC, ETH, NEAR and SOL"
            : "Extended and newly listed markets"}
        </p>
      </th>
      <td className={cell}>{formatUsd(vault.nav)}</td>
      <td className={cell}>{formatBps(vault.fee_apr_bps)}</td>
      <td
        className={cn(
          cell,
          pnl > 0n
            ? "text-success"
            : pnl < 0n
              ? "text-destructive"
              : "text-muted-foreground",
        )}
      >
        {formatUsd(pnl, { signed: true })}
      </td>
      <td className={cell}>
        {!wallet.accountId ? (
          "—"
        ) : account.data ? (
          <>
            <span>{formatShares(account.data.shares)}</span>
            <span className="mt-1 block text-label text-tertiary">
              {formatUsd(account.data.value)}
            </span>
          </>
        ) : account.isError ? (
          "Unavailable"
        ) : (
          <Skeleton className="ml-auto h-4 w-16" />
        )}
      </td>
      <td className="max-w-64 px-4 py-4 text-left text-label text-muted-foreground">
        {markets
          ? markets
              .filter((m) => m.vault_id === vault.id)
              .map((m) => m.id)
              .join(" · ")
          : "Markets unavailable"}
      </td>
    </tr>
  );
}

export function VaultList() {
  const vaults = useVaults();
  const markets = useMarkets();
  const totalNav = vaults.data?.reduce((sum, vault) => sum + vault.nav, 0n);
  const pnl = vaults.data?.reduce(
    (sum, vault) => sum + totalRevenue(vault.revenue),
    0n,
  );
  return (
    <>
      <section className="flex flex-col gap-4 rounded-md border border-border bg-card p-4">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div className="flex flex-col gap-2">
            <h1 className="text-heading">Vaults</h1>
            <p className="text-ui text-muted-foreground">
              Provide USDC and earn trading fees. Each vault takes the other
              side of its markets.
            </p>
          </div>
          <ReadAt at={vaults.dataUpdatedAt} failing={vaults.isError} />
        </div>
        <dl className="flex flex-wrap gap-x-10 gap-y-4">
          <HeaderStat label="Total value locked">
            {totalNav === undefined ? "—" : formatUsd(totalNav)}
          </HeaderStat>
          <HeaderStat
            label={
              <Term hint="Sum of booked trading and borrow fees, funding, counterparty PnL, liquidation penalties and listing fees. Excludes deposits, withdrawals and unrealized PnL.">
                All-time PnL
              </Term>
            }
          >
            {pnl === undefined ? "—" : formatUsd(pnl, { signed: true })}
          </HeaderStat>
          <HeaderStat label="Vaults">{vaults.data?.length ?? "—"}</HeaderStat>
        </dl>
      </section>
      <section
        aria-label="Choose a vault"
        className="rounded-md border border-border bg-card"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
          <div>
            <h2 className="text-ui font-medium">Protocol vaults</h2>
            <p className="mt-1 text-label text-tertiary">
              Separate capital, shares and market exposure. No fixed yield.
            </p>
          </div>
          <Link
            data-primary
            href="/vaults/core"
            className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-ui font-medium text-primary-foreground hover:bg-primary/85 focus-visible:outline-2 focus-visible:outline-ring"
          >
            Deposit to Core <ArrowUpRight className="size-3.5" />
          </Link>
        </div>
        {vaults.isError && !vaults.data ? (
          <ErrorState
            className="m-4"
            title="Vaults are unavailable right now."
            error={vaults.error}
            onRetry={() => void vaults.refetch()}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-224 text-foreground">
              <thead className="bg-muted text-label text-tertiary">
                <tr>
                  {[
                    "Vault",
                    "TVL",
                    "Fee APR · 7D",
                    "All-time PnL",
                    "Your shares / value",
                    "Markets",
                  ].map((label, i) => (
                    <th
                      scope="col"
                      key={label}
                      className={cn(
                        "px-4 py-3 font-normal",
                        i === 0 || i === 5 ? "text-left" : "text-right",
                      )}
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {vaults.data
                  ? vaults.data.map((vault) => (
                      <VaultRow
                        key={vault.id}
                        vault={vault}
                        markets={markets.data}
                      />
                    ))
                  : [0, 1].map((i) => (
                      <tr key={i}>
                        <td colSpan={6} className="p-4">
                          <Skeleton className="h-12 w-full" />
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
        )}
        {markets.isError ? (
          <p role="alert" className="p-4 text-label text-warning">
            Market coverage could not be refreshed.{" "}
            <button
              className="underline"
              onClick={() => void markets.refetch()}
            >
              Retry markets
            </button>
          </p>
        ) : null}
      </section>
      <p className="px-4 py-3 text-label text-tertiary">
        LPs receive fees and traders&apos; net losses, and pay traders&apos;
        gains. Fee APR annualizes the last 7 UTC days over current NAV; it is
        not a promised return. Withdrawals depend on unreserved USDC.
      </p>
    </>
  );
}
