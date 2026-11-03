"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader, Eyebrow } from "@/components/ui/page-shell";
import { EmptyState, ErrorState, Skeleton } from "@/components/app/states";
import { formatAge, formatUtc, STALE_AFTER_MS, useNow } from "@/components/landing/live-time";
import { useDepth } from "@/hooks/use-perps-queries";
import { useNear } from "@/hooks/near-provider";
import {
  MAX_EXIT_IMPACT_BPS,
  MIN_OPEN_CAPACITY_USD,
  SAMPLE_SIZES_USD,
  maxLeverage,
} from "@/lib/intents/depth";
import { ONECLICK_BASE, ORIGIN_ASSETS, PUBLIC_FEE_BPS, USDC_NEAR_ASSET_ID } from "@/lib/intents/oneclick";
import { formatUsd } from "@/lib/near/format";
import { MARKET_IDS, type DepthRecord, type DepthView, type MarketId } from "@/lib/near/types";
import { cn } from "@/lib/utils";
import { formatImpact, formatSizeUsd } from "./format";
import { ImpactChart } from "./impact-chart";

const RERUN_COMMAND = "pnpm depth:sample";
const TIER_THRESHOLDS = [1_000_000, 250_000, 50_000, MIN_OPEN_CAPACITY_USD] as const;

export function LiquidityView() {
  const router = useRouter();
  const pathname = usePathname();
  const param = useSearchParams().get("asset")?.toUpperCase();
  const asset: MarketId = MARKET_IDS.find((id) => id === param) ?? "BTC";
  const depth = useDepth(asset);
  const now = useNow();
  const latest = depth.data?.history.at(-1);

  const select = (id: MarketId) => router.replace(`${pathname}?asset=${id}`, { scroll: false });

  return (
    <>
      <PageHeader
        title="Measured exit liquidity"
        description="How much of each asset can be sold on NEAR Intents before the price moves 1%."
        actions={<MeasuredAt record={latest} loading={depth.isPending} now={now} />}
      />

      <div
        role="tablist"
        aria-label="Asset"
        className="flex gap-1 overflow-x-auto rounded-lg border border-border bg-card p-1"
      >
        {MARKET_IDS.map((id) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={id === asset}
            onClick={() => select(id)}
            className={cn(
              "h-8 shrink-0 rounded-md px-4 text-ui font-medium transition-colors",
              id === asset ? "bg-muted text-foreground" : "text-tertiary hover:text-foreground",
            )}
          >
            {id}
          </button>
        ))}
      </div>

      {depth.isError ? (
        <ErrorState error={depth.error} onRetry={() => depth.refetch()} />
      ) : depth.isPending ? (
        <LoadingBody />
      ) : (
        <DepthBody view={depth.data} now={now} />
      )}

      <RerunCallout asset={asset} oracleAssetId={depth.data?.market.oracle_asset_id} />
    </>
  );
}

function MeasuredAt({ record, loading, now }: { record?: DepthRecord; loading: boolean; now: number }) {
  if (loading) return <Skeleton className="h-10 w-48" />;
  if (!record) return <p className="text-ui text-tertiary">No measurement yet</p>;
  const stale = now > 0 && now - record.measured_at_ms > STALE_AFTER_MS;
  return (
    <div className="flex flex-col gap-0.5 text-ui md:items-end">
      <p className="text-label text-tertiary">Last measurement</p>
      <p className="tabular-nums text-foreground">
        {formatUtc(record.measured_at_ms, true)}
        <span className="text-muted-foreground"> · {formatAge(record.measured_at_ms, now)}</span>
      </p>
      {stale ? (
        <p className="flex items-center gap-1.5 text-warning">
          <AlertTriangle aria-hidden className="size-3.5" />
          Older than 30 min: market closed to new positions
        </p>
      ) : null}
    </div>
  );
}

function LoadingBody() {
  return (
    <>
      <div className="grid gap-1 lg:grid-cols-12">
        <Skeleton className="h-96 rounded-lg lg:col-span-8" />
        <Skeleton className="h-96 rounded-lg lg:col-span-4" />
      </div>
      <Skeleton className="h-80 rounded-lg" />
    </>
  );
}

function DepthBody({ view, now }: { view: DepthView | null; now: number }) {
  const latest = view?.history.at(-1);
  if (!view || !latest) {
    return (
      <div className="rounded-lg border border-border bg-card">
        <EmptyState>No sample yet. The keeper samples every minute while the app is open.</EmptyState>
      </div>
    );
  }
  return (
    <>
      <div className="grid gap-1 lg:grid-cols-12">
        <section className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4 lg:col-span-8">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-subtitle text-foreground">Impact curve</h2>
            <p className="text-label text-tertiary">Sell size (log) → net price impact</p>
          </div>
          <ImpactChart record={latest} />
        </section>
        <Parameters view={view} record={latest} now={now} />
      </div>
      <History history={view.history} />
    </>
  );
}

function Parameters({ view, record, now }: { view: DepthView; record: DepthRecord; now: number }) {
  const { market } = view;
  const capacity = record.exit_capacity_usd;
  const stale = now > 0 && now - record.measured_at_ms > STALE_AFTER_MS;
  const tier = maxLeverage(capacity);
  const reason = !market.is_open
    ? stale
      ? "Measurement older than 30 min"
      : capacity < MIN_OPEN_CAPACITY_USD
        ? `Exit capacity under ${formatSizeUsd(MIN_OPEN_CAPACITY_USD)}`
        : "Closed by the contract"
    : `Capacity ≥ ${formatSizeUsd(MIN_OPEN_CAPACITY_USD)}, measured < 30 min ago`;

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 lg:col-span-4">
      <h2 className="text-subtitle text-foreground">Derived parameters</h2>
      <dl className="flex flex-col text-ui">
        <Row label="Exit capacity" value={formatSizeUsd(capacity)} hint={`Largest size within ${MAX_EXIT_IMPACT_BPS} bps`} />
        <Row
          label="Max open interest per side"
          value={formatUsd(market.max_oi_per_side, { maxFractionDigits: 0 })}
          hint={`min(hard cap ${formatUsd(market.hard_cap, { maxFractionDigits: 0 })}, capacity)`}
        />
        <Row label="Max leverage" value={`${market.max_leverage}×`} />
        <Row
          label="New positions"
          value={market.is_open ? "Open" : "Closed"}
          valueClass={market.is_open ? "text-success" : "text-destructive"}
          hint={reason}
        />
      </dl>
      <div className="flex flex-col gap-2">
        <Eyebrow>Leverage tiers</Eyebrow>
        <table className="w-full text-ui">
          <thead>
            <tr className="bg-muted text-label text-tertiary">
              <th className="h-8 rounded-l-md px-2 text-left font-normal">Exit capacity</th>
              <th className="h-8 rounded-r-md px-2 text-right font-normal">Max leverage</th>
            </tr>
          </thead>
          <tbody>
            {TIER_THRESHOLDS.map((threshold, i) => {
              const lev = maxLeverage(threshold);
              const next = TIER_THRESHOLDS[i - 1];
              const active = market.is_open && capacity >= threshold && (next === undefined || capacity < next) && lev === tier;
              return (
                <tr key={threshold} className={cn("border-b border-border", active ? "text-foreground" : "text-muted-foreground")}>
                  <td className="h-row px-2 tabular-nums">≥ {formatSizeUsd(threshold)}</td>
                  <td className="h-row px-2 text-right tabular-nums">
                    {active ? <span className="mr-2 text-label text-tertiary">current</span> : null}
                    {lev}×
                  </td>
                </tr>
              );
            })}
            <tr className={cn(capacity < MIN_OPEN_CAPACITY_USD ? "text-foreground" : "text-muted-foreground")}>
              <td className="h-row px-2 tabular-nums">&lt; {formatSizeUsd(MIN_OPEN_CAPACITY_USD)}</td>
              <td className="h-row px-2 text-right text-destructive">Closed</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Row({ label, value, hint, valueClass }: { label: string; value: string; hint?: string; valueClass?: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border py-2.5 last:border-b-0">
      <dt className="flex flex-col gap-0.5">
        <span className="text-muted-foreground">{label}</span>
        {hint ? <span className="text-label text-tertiary">{hint}</span> : null}
      </dt>
      <dd className={cn("text-right tabular-nums text-foreground", valueClass)}>{value}</dd>
    </div>
  );
}

function History({ history }: { history: DepthRecord[] }) {
  const rows = [...history].reverse();
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-subtitle text-foreground">Sample history</h2>
        <p className="text-label text-tertiary">Last {rows.length} of up to 48, newest first</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-3xl text-ui">
          <thead>
            <tr className="bg-muted text-label text-tertiary">
              <th className="h-8 px-2 text-left font-normal whitespace-nowrap">Time</th>
              <th className="h-8 px-2 text-right font-normal">Capacity</th>
              <th className="h-8 px-2 text-right font-normal">Max lev.</th>
              {SAMPLE_SIZES_USD.map((size) => (
                <th key={size} className="h-8 px-2 text-right font-normal">
                  {formatSizeUsd(size)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((record) => (
              <tr key={record.measured_at_ms} className="border-b border-border last:border-b-0">
                <td className="h-row px-2 whitespace-nowrap text-muted-foreground tabular-nums">
                  {new Date(record.measured_at_ms).toISOString().slice(5, 10)} {formatUtc(record.measured_at_ms)}
                </td>
                <td className="h-row px-2 text-right tabular-nums text-foreground">{formatSizeUsd(record.exit_capacity_usd)}</td>
                <td className="h-row px-2 text-right tabular-nums text-foreground">{record.max_leverage}×</td>
                {SAMPLE_SIZES_USD.map((size) => {
                  const impact = record.samples.find((s) => s.size_usd === size);
                  const bps = impact?.impact_bps;
                  return (
                    <td
                      key={size}
                      className={cn(
                        "h-row px-2 text-right whitespace-nowrap tabular-nums",
                        impact === undefined
                          ? "text-tertiary"
                          : bps === null
                            ? "text-destructive"
                            : bps !== undefined && bps > MAX_EXIT_IMPACT_BPS
                              ? "text-warning"
                              : "text-muted-foreground",
                      )}
                    >
                      {impact === undefined ? "—" : formatImpact(impact.impact_bps)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RerunCallout({ asset, oracleAssetId }: { asset: MarketId; oracleAssetId?: string }) {
  const { views } = useNear();
  const perpsConfig = useQuery({ queryKey: ["perps", "config"], queryFn: () => views.config(), staleTime: Infinity });
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(RERUN_COMMAND);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-1">
          <h2 className="text-subtitle text-foreground">Re-run it yourself</h2>
          <p className="text-ui text-muted-foreground">
            Quotes every size on 1Click from your machine and prints the same impact numbers. No key needed.
          </p>
        </div>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <code className="flex h-control min-w-0 items-center truncate rounded-md bg-muted px-3 font-mono text-ui text-foreground">
            {RERUN_COMMAND}
          </code>
          <Button data-primary onClick={copy} aria-label="Copy re-run command">
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            {copied ? "Copied" : "Copy re-run command"}
          </Button>
        </div>
      </div>

      <details className="group text-ui">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Details</summary>
        <dl className="mt-3 grid gap-x-6 gap-y-3 md:grid-cols-[max-content_1fr]">
          <dt className="text-tertiary">1Click asset ids</dt>
          <dd className="flex flex-col gap-1 font-mono text-label break-all text-muted-foreground">
            {MARKET_IDS.map((id) => (
              <span key={id} className={id === asset ? "text-foreground" : undefined}>
                {id}: {ORIGIN_ASSETS[id]}
              </span>
            ))}
          </dd>
          <dt className="text-tertiary">Quote endpoint</dt>
          <dd className="text-muted-foreground">
            <span className="font-mono text-label break-all text-foreground">POST {ONECLICK_BASE}/quote</span>
            <br />
            Dry EXACT_INPUT quotes from each asset into USDC on NEAR (
            <span className="font-mono text-label break-all">{USDC_NEAR_ASSET_ID}</span>), one size at a time.
          </dd>
          <dt className="text-tertiary">Formula</dt>
          <dd className="text-muted-foreground">
            <span className="font-mono text-label text-foreground">
              impact_bps = max(0, ⌈(1 − amountOutUsd / amountInUsd) × 10000⌉ − {PUBLIC_FEE_BPS})
            </span>
            <br />
            Gross impact is rounded up against the trader, then the 1Click platform fee ({PUBLIC_FEE_BPS} bps without a
            partner key) is removed. A “no liquidity” quote error is recorded as null. Exit capacity is the largest size
            whose impact, and that of every smaller size, stays within {MAX_EXIT_IMPACT_BPS} bps.
          </dd>
          <dt className="text-tertiary">Oracle</dt>
          <dd className="font-mono text-label break-all text-muted-foreground">
            {perpsConfig.data?.oracle_id ?? "—"} · {oracleAssetId ?? "—"}
          </dd>
        </dl>
      </details>
    </section>
  );
}
