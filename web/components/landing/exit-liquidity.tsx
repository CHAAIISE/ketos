"use client";

import type { ReactNode } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDepth } from "@/hooks/use-perps-queries";
import { networkName } from "@/lib/near/config";
import { formatUsd } from "@/lib/near/format";
import type { DepthRecord, DepthView, MarketId } from "@/lib/near/types";
import { cn } from "@/lib/utils";
import {
  LABEL_WIDTH,
  buildAsciiDepth,
  compactUsd,
  firstDrySize,
  toneRuns,
  type AsciiAnnotation,
  type Row,
  type Tone,
} from "./ascii-depth";
import styles from "./landing.module.css";
import { STALE_AFTER_MS, formatAge, formatUtc, useIsDesktop, useNow } from "./live-time";

const ROWS_PER_BAND = 5;
/** Two annotation lines and their connector row are always reserved, so the grid never jumps. */
const ANNOTATION_ROWS = 3;

const toneClass: Record<Tone, string> = {
  blank: "",
  void: "text-border",
  deep: "text-foreground",
  thin: "text-accent",
  over: "text-accent/50",
  none: "text-destructive",
  label: "text-muted-foreground",
  note: "text-tertiary",
};

interface Asset {
  id: MarketId;
  view: DepthView | null | undefined;
  record: DepthRecord | undefined;
}

function AsciiGrid({ rows, cols, className }: { rows: Row[]; cols: number; className?: string }) {
  const charsPerRow = LABEL_WIDTH + cols;
  return (
    <div className="@container w-full">
      <pre
        aria-hidden
        className={cn("overflow-hidden font-mono leading-[1.3] whitespace-pre select-none", className)}
        style={{ fontSize: `calc(100cqi / ${(charsPerRow * 0.6).toFixed(2)})` }}
      >
        {rows.map((row, r) => (
          <div key={r}>
            {toneRuns(row).map((run, i) => (
              <span key={i} className={toneClass[run.tone]}>
                {run.text}
              </span>
            ))}
          </div>
        ))}
      </pre>
    </div>
  );
}

function padRows(rows: Row[], annotationCount: number, width: number): Row[] {
  const missing = ANNOTATION_ROWS - (annotationCount ? annotationCount + 1 : 0);
  const blank = (): Row => Array.from({ length: width }, () => ({ ch: " ", tone: "blank" as const }));
  return [...Array.from({ length: Math.max(0, missing) }, blank), ...rows];
}

function annotationsFor(assets: Asset[]): AsciiAnnotation[] {
  const lead = assets.find((a) => a.record);
  if (!lead?.record) return [];
  const notes: AsciiAnnotation[] = [];
  const capacity = lead.record.exit_capacity_usd;
  if (capacity > 0) {
    notes.push({ sizeUsd: capacity, text: `${lead.id} · ${compactUsd(capacity)} sells within 1%` });
  }
  const dry = firstDrySize(lead.record.samples);
  if (dry !== null) notes.push({ sizeUsd: dry, text: `${compactUsd(dry)} · no liquidity` });
  return notes.sort((a, b) => b.sizeUsd - a.sizeUsd);
}

function impactAtCapacity(record: DepthRecord): number | null {
  const sample = record.samples.find((s) => s.size_usd === record.exit_capacity_usd);
  return sample?.impact_bps ?? null;
}

function MeasuredAt({ records }: { records: DepthRecord[] }) {
  const nowMs = useNow();
  const times = records.map((r) => r.measured_at_ms);
  const oldest = Math.min(...times);
  const newest = Math.max(...times);
  const range =
    formatUtc(oldest) === formatUtc(newest)
      ? formatUtc(newest)
      : `${formatUtc(oldest).replace(" UTC", "")}–${formatUtc(newest)}`;
  const stale = nowMs > 0 && nowMs - oldest > STALE_AFTER_MS;
  const age = formatAge(oldest, nowMs);
  return (
    <span className={cn("tabular-nums", stale ? "text-warning" : "text-tertiary")}>
      measured {range}
      {age ? ` · ${age}` : null}
      {stale ? " · older than 30 min, new positions paused until the next sample" : null}
    </span>
  );
}

function LegendTable({ assets }: { assets: Asset[] }) {
  return (
    <table className="w-full text-ui tabular-nums">
      <caption className="sr-only">Exit liquidity per market, read from get_depth</caption>
      <thead>
        <tr className="border-b border-border text-label text-tertiary">
          <th scope="col" className="py-2 text-left font-medium">
            Market
          </th>
          <th scope="col" className="py-2 text-right font-medium">
            Exit capacity
          </th>
          <th scope="col" className="py-2 text-right font-medium">
            Max leverage
          </th>
          <th scope="col" className="py-2 text-right font-medium">
            Impact at capacity
          </th>
        </tr>
      </thead>
      <tbody>
        {assets.map(({ id, view, record }) => {
          const impact = record ? impactAtCapacity(record) : null;
          return (
            <tr key={id} className="border-b border-border last:border-b-0">
              <th scope="row" className="py-2 text-left font-medium text-foreground">
                {id}
                {view && !view.market.is_open ? (
                  <span className="ml-2 text-label font-normal text-warning">paused</span>
                ) : null}
              </th>
              {view && record ? (
                <>
                  <td className="py-2 text-right text-foreground">
                    {formatUsd(view.market.exit_capacity, { maxFractionDigits: 0 })}
                  </td>
                  <td className="py-2 text-right text-foreground">{view.market.max_leverage}×</td>
                  <td className="py-2 text-right text-muted-foreground">
                    {impact === null ? "no size within 1%" : `${impact} bps`}
                  </td>
                </>
              ) : (
                <td colSpan={3} className="py-2 text-right text-tertiary">
                  {view === undefined ? "Last measurement unavailable" : "No sample yet"}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Figure({ children, caption }: { children: ReactNode; caption?: ReactNode }) {
  return (
    <figure className="flex flex-col gap-4" aria-label="Measured exit liquidity on NEAR Intents">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-label text-tertiary">
        <span>Sell size into USDC on NEAR Intents → price impact</span>
        {caption}
      </figcaption>
      {children}
    </figure>
  );
}

/** Live exit liquidity of the four markets, drawn from `get_depth`. */
export function ExitLiquidity() {
  const btc = useDepth("BTC");
  const eth = useDepth("ETH");
  const near = useDepth("NEAR");
  const zec = useDepth("ZEC");
  const isDesktop = useIsDesktop();
  const cols = isDesktop ? 72 : 40;
  const queries = [
    { id: "BTC" as const, query: btc },
    { id: "ETH" as const, query: eth },
    { id: "NEAR" as const, query: near },
    { id: "ZEC" as const, query: zec },
  ];

  const assets: Asset[] = queries.map(({ id, query }) => ({
    id,
    view: query.data,
    record: query.data?.history.at(-1),
  }));
  const loading = queries.some((q) => q.query.isPending);
  const failed = queries.every((q) => q.query.isError);
  const records = assets.flatMap((a) => (a.record ? [a.record] : []));
  const width = LABEL_WIDTH + cols;

  if (loading || failed) {
    const rows = padRows(
      buildAsciiDepth(
        assets.map((a) => ({ label: a.id, samples: null })),
        { cols, rowsPerBand: ROWS_PER_BAND, annotations: [] },
      ),
      0,
      width,
    );
    return (
      <Figure>
        <div className="relative">
          <AsciiGrid rows={rows} cols={cols} className={loading ? "animate-pulse" : undefined} />
          {failed ? (
            <div
              role="alert"
              className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 flex-col items-start gap-3 rounded-lg border border-destructive/40 bg-background p-4 text-sm md:flex-row md:items-center md:justify-between"
            >
              <span className="text-foreground">
                Last measurement unavailable.{" "}
                <span className="text-muted-foreground">The {networkName()} RPC did not answer get_depth.</span>
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => queries.forEach((q) => void q.query.refetch())}
              >
                <RotateCw />
                Retry
              </Button>
            </div>
          ) : (
            <span className="sr-only" role="status">
              Reading get_depth from {networkName()}
            </span>
          )}
        </div>
        {failed ? null : (
          <div aria-hidden className="flex flex-col gap-2">
            {assets.map((a) => (
              <div key={a.id} className="h-6 rounded-sm bg-muted" />
            ))}
          </div>
        )}
      </Figure>
    );
  }

  const annotations = annotationsFor(assets);
  const rows = padRows(
    buildAsciiDepth(
      assets.map((a) => ({ label: a.id, samples: a.record?.samples ?? null })),
      { cols, rowsPerBand: ROWS_PER_BAND, annotations },
    ),
    annotations.length,
    width,
  );

  return (
    <Figure caption={records.length ? <MeasuredAt records={records} /> : null}>
      <AsciiGrid key={cols} rows={rows} cols={cols} className={styles.reveal} />
      {records.length ? (
        <>
          <LegendTable assets={assets} />
          <p className="text-label text-tertiary">
            Dry quotes from NEAR Intents 1Click (mainnet, read-only), platform fee excluded, written on chain
            by the keeper. Exit capacity is the largest quoted size that moves the price 1% or less.
          </p>
        </>
      ) : (
        <p className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
          <span className="text-foreground">Last measurement unavailable.</span> No sample yet. The keeper
          samples every minute while the app is open.
        </p>
      )}
    </Figure>
  );
}
