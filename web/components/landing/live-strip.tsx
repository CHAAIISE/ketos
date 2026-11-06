"use client";

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMarkets } from "@/hooks/use-ketos-queries";
import { formatUsd, usdcToNumber } from "@/lib/near/format";
import { marketDisplayStatus } from "@/lib/near/market-status";
import { fetchStats } from "@/lib/stats";
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

const LABELS = ["Markets open", "Open interest", "Vault TVL", "24h volume", "Latest measurement"];
const stripClass =
  "flex flex-col divide-y divide-border border-y border-border md:flex-row md:divide-x md:divide-y-0 md:py-8";

/** Activity totals come from the shared server snapshot, never browser history fanout. */
export function LiveStrip() {
  const markets = useMarkets();
  const stats = useQuery({
    queryKey: ["stats"],
    queryFn: ({ signal }) => fetchStats(signal),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  const nowMs = useNow();

  if (stats.isPending) {
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

  if (!stats.data) {
    return (
      <div role="status" className="flex flex-col items-start gap-3 rounded-lg border border-destructive/40 p-4 text-sm md:flex-row md:items-center md:justify-between">
        <span className="text-foreground">
          Statistics unavailable. <span className="text-muted-foreground">The shared onchain snapshot could not be loaded.</span>
        </span>
        <Button variant="outline" size="sm" onClick={() => void stats.refetch()}>
          <RotateCw />
          Retry
        </Button>
      </div>
    );
  }

  const snapshot = stats.data;
  const openInterest = BigInt(snapshot.totalOi);
  const tvl = BigInt(snapshot.vaultTvl);
  const volume = BigInt(snapshot.volume24h);
  const lowerBound = !snapshot.coverage.complete;
  const list = markets.data;
  const open = list?.filter((market) => marketDisplayStatus(market, nowMs).open).length;
  const measuredAt = list?.length ? Math.max(...list.map((market) => market.depth_measured_at_ms)) : 0;
  const stale = measuredAt > 0 && nowMs > 0 && nowMs - measuredAt > STALE_AFTER_MS;

  return (
    <div className="flex flex-col gap-6">
      <dl className={stripClass}>
        <Cell label={LABELS[0]} hint={list ? `${list.length} listed · current cached marks` : markets.isError ? "market registry unavailable" : "loading market registry"}>
          {open !== undefined && list ? <FlashValue text={`${open} / ${list.length}`} order={open} /> : "—"}
        </Cell>
        <Cell label={LABELS[1]} hint="total size of open positions, longs + shorts">
          <FlashValue text={formatUsd(openInterest, { maxFractionDigits: 0 })} order={usdcToNumber(openInterest)} />
        </Cell>
        <Cell label={LABELS[2]} hint="combined vault net asset value">
          <FlashValue text={formatUsd(tvl, { maxFractionDigits: 0 })} order={usdcToNumber(tvl)} />
        </Cell>
        <Cell
          label={LABELS[3]}
          testId="landing-volume-24h"
          hint={`${lowerBound ? "≥ " : ""}${snapshot.trades24h} ${snapshot.trades24h === 1 ? "trade" : "trades"} · ${lowerBound ? "≥ " : ""}${snapshot.traders24h} active traders${lowerBound ? " · lower bounds" : ""}`}
        >
          <FlashValue text={`${lowerBound ? "≥ " : ""}${formatUsd(volume, { maxFractionDigits: 0 })}`} order={usdcToNumber(volume)} />
        </Cell>
        <Cell
          label={LABELS[4]}
          hint={list ? `latest of ${list.length} markets${measuredAt ? ` · ${formatAge(measuredAt, nowMs)}` : ""}` : "measurement time unavailable"}
        >
          <span className={cn(stale && "text-warning")}>{measuredAt ? formatUtc(measuredAt) : "—"}</span>
        </Cell>
      </dl>
      <div className="flex flex-col gap-2 text-label text-tertiary">
        <p className="tabular-nums">
          Activity and vault snapshot fetched {formatUtc(snapshot.fetchedAtMs, true)}{formatAge(snapshot.fetchedAtMs, nowMs) ? ` · ${formatAge(snapshot.fetchedAtMs, nowMs)}` : ""}.
          {" "}Shared cache: up to 60 seconds; this page requests an update every minute. The 24h window ends at that snapshot.
          {list ? ` Market registry read ${formatUtc(markets.dataUpdatedAt, true)}; each market has its own measurement time.` : ""}
        </p>
        {stats.isError || markets.isError ? (
          <p role="status" className="text-warning">A refresh failed. Available cached values remain visible; unavailable values are shown as —.</p>
        ) : null}
        <details>
          <summary className="w-fit cursor-pointer rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">Details</summary>
          <p className="mt-2">
            Volume counts entry and exit notional, including liquidations. Coverage: {snapshot.coverage.accountsScanned} accounts,
            up to {snapshot.coverage.eventsPerAccountLimit} recent events per account.
            {lowerBound ? " The account or history limit was reached, so volume, trades and active traders are lower bounds." : " The scanned account histories cover the snapshot’s 24h window."}
            {" "}Open status describes cached prices; trading actions request a fresh price when needed and recheck limits at execution.
          </p>
        </details>
      </div>
    </div>
  );
}
