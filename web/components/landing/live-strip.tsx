"use client";

import type { ReactNode } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNear } from "@/hooks/near-provider";
import { VAULT_LABEL } from "@/components/markets/markets-table";
import { useMarkets, useVaults, useVolume24h } from "@/hooks/use-ketos-queries";
import { networkName } from "@/lib/near/config";
import { formatUsd, usdcToNumber } from "@/lib/near/format";
import { isMeasuring } from "@/lib/near/types";
import { cn } from "@/lib/utils";
import { FlashValue } from "./flash-value";
import { STALE_AFTER_MS, formatAge, formatUtc, useNow } from "./live-time";

function Cell({ label, children, hint, testId }: { label: string; children: ReactNode; hint?: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className="flex min-w-0 flex-1 items-baseline justify-between gap-4 py-4 md:flex-col md:items-start md:justify-start md:gap-2 md:px-6 md:py-0 md:first:pl-0">
      <dt className="text-label text-tertiary">{label}</dt>
      <dd className="flex flex-col items-end gap-1 md:items-start">
        <span className="text-price tabular-nums text-foreground">{children}</span>
        {hint ? <span className="text-label tabular-nums text-tertiary">{hint}</span> : null}
      </dd>
    </div>
  );
}

const LABELS = ["Markets open", "Open interest", "Vault TVL", "24h volume", "Last measurement"];

const stripClass =
  "flex flex-col divide-y divide-border border-y border-border md:flex-row md:divide-x md:divide-y-0 md:py-8";

/** Protocol totals read from `get_markets`, `get_vaults` and account histories, refreshed while the page is open. */
export function LiveStrip() {
  const { config } = useNear();
  const markets = useMarkets();
  const vaults = useVaults();
  const volume = useVolume24h();
  const nowMs = useNow();

  if (markets.isPending || vaults.isPending) {
    return (
      <dl aria-busy className={stripClass}>
        {LABELS.map((label) => (
          <Cell key={label} label={label}>
            <span aria-hidden className="block h-7 w-24 rounded-sm bg-muted" />
          </Cell>
        ))}
      </dl>
    );
  }

  if (markets.isError || vaults.isError) {
    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-3 rounded-lg border border-destructive/40 p-4 text-sm md:flex-row md:items-center md:justify-between"
      >
        <span className="text-foreground">
          Live numbers unavailable.{" "}
          <span className="text-muted-foreground">
            The {networkName()} RPC did not answer get_markets or get_vaults.
          </span>
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void markets.refetch();
            void vaults.refetch();
          }}
        >
          <RotateCw />
          Retry
        </Button>
      </div>
    );
  }

  const list = markets.data;
  const open = list.filter((m) => m.is_open).length;
  const measuring = list.filter(isMeasuring).length;
  const openInterest = list.reduce((sum, m) => sum + m.oi_long + m.oi_short, 0n);
  const tvl = vaults.data.reduce((sum, v) => sum + v.nav, 0n);
  const measuredAt = list.length ? Math.max(...list.map((m) => m.depth_measured_at_ms)) : 0;
  const stale = measuredAt > 0 && nowMs > 0 && nowMs - measuredAt > STALE_AFTER_MS;
  const readAt = Math.max(markets.dataUpdatedAt, vaults.dataUpdatedAt);

  return (
    <div className="flex flex-col gap-6">
      <dl className={stripClass}>
        <Cell label={LABELS[0]} hint={`${list.length} listed${measuring ? ` · ${measuring} measuring` : ""}`}>
          <FlashValue text={`${open} / ${list.length}`} order={open} />
        </Cell>
        <Cell label={LABELS[1]} hint="longs + shorts, all markets">
          <FlashValue text={formatUsd(openInterest, { maxFractionDigits: 0 })} order={usdcToNumber(openInterest)} />
        </Cell>
        <Cell
          label={LABELS[2]}
          hint={vaults.data.map((v) => `${VAULT_LABEL[v.id]} ${formatUsd(v.nav, { maxFractionDigits: 0 })}`).join(" · ")}
        >
          <FlashValue text={formatUsd(tvl, { maxFractionDigits: 0 })} order={usdcToNumber(tvl)} />
        </Cell>
        <Cell
          label={LABELS[3]}
          testId="landing-volume-24h"
          hint={
            volume.data
              ? `${volume.data.trades} ${volume.data.trades === 1 ? "trade" : "trades"}${volume.data.complete ? "" : " · lower bound"}`
              : volume.isError
                ? "account histories unavailable"
                : undefined
          }
        >
          {volume.data ? (
            <FlashValue
              text={`${volume.data.complete ? "" : "≥ "}${formatUsd(volume.data.volume, { maxFractionDigits: 0 })}`}
              order={usdcToNumber(volume.data.volume)}
            />
          ) : volume.isError ? (
            <span className="text-muted-foreground">unavailable</span>
          ) : (
            <span aria-hidden className="block h-7 w-24 rounded-sm bg-muted" />
          )}
        </Cell>
        <Cell
          label={LABELS[4]}
          hint={
            measuredAt ? (
              <span className={cn(stale && "text-warning")}>{formatAge(measuredAt, nowMs) || "\u00a0"}</span>
            ) : undefined
          }
        >
          {measuredAt ? formatUtc(measuredAt) : <span className="text-muted-foreground">unavailable</span>}
        </Cell>
      </dl>
      <div className="flex flex-col gap-2 text-label text-tertiary">
        <p className="tabular-nums">
          Read on chain at {formatUtc(readAt, true)}, refreshed while this page is open. Volume sums entry and exit
          size from each ranked trader&apos;s onchain history over the last 24 hours.
        </p>
        <details>
          <summary className="w-fit cursor-pointer rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            Details
          </summary>
          <p className="mt-2 font-mono wrap-anywhere">
            Contract {config.ketosContract} · views get_markets, get_vaults, get_leaderboard, get_history
          </p>
        </details>
      </div>
    </div>
  );
}
