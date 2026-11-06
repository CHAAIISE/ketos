"use client";

import type { ReactNode } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDepths, useMarkets } from "@/hooks/use-ketos-queries";
import { networkName } from "@/lib/near/config";
import { formatExitCapacity, marketDisplayStatus } from "@/lib/near/market-status";
import type { DepthRecord, DepthView, Market, MarketId } from "@/lib/near/types";
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
    notes.push({ sizeUsd: capacity, text: `${lead.id} · limit ${compactUsd(capacity)}` });
  }
  const dry = firstDrySize(lead.record.samples);
  if (dry !== null) notes.push({ sizeUsd: dry, text: `${compactUsd(dry)} · no liquidity` });
  return notes.sort((a, b) => b.sizeUsd - a.sizeUsd);
}

function impactAtCapacity(record: DepthRecord): number | null {
  let impact: number | null = null;
  for (const sample of record.samples) {
    if (sample.impact_bps === null || sample.impact_bps > 100) break;
    impact = sample.impact_bps;
  }
  return impact;
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
      {records.length} shown markets measured {range}
      {age ? ` · oldest ${age}` : null}
      {stale ? " · some depth older than 30 min" : null}
    </span>
  );
}

function LegendTable({ assets }: { assets: Asset[] }) {
  const nowMs = useNow();
  return (
    <table className="w-full text-ui tabular-nums">
      <caption className="sr-only">Reported exit liquidity and cached-price status per market</caption>
      <thead>
        <tr className="border-b border-border text-label text-tertiary">
          <th scope="col" className="py-2 text-left font-medium">
            Market
          </th>
          <th scope="col" className="py-2 text-right font-medium">
            Measured exit capacity
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
          const gridPassed = record && record.samples.length > 0
            && record.samples.every((sample) => sample.impact_bps !== null && sample.impact_bps <= 100);
          const status = view ? marketDisplayStatus(view.market, nowMs) : null;
          return (
            <tr key={id} className="border-b border-border last:border-b-0">
              <th scope="row" className="py-2 text-left font-medium text-foreground">
                {id}
                {status && !status.open ? (
                  <span className="block text-label font-normal text-warning">{status.label}</span>
                ) : null}
              </th>
              {view && record ? (
                <>
                  <td className="py-2 text-right text-foreground">
                    {formatExitCapacity(view.market, record)}
                    {gridPassed ? <span className="block text-label text-tertiary">(largest size probed)</span> : null}
                    <span className="block text-label text-tertiary">{formatUtc(record.measured_at_ms)}</span>
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

const SHOWN = 4;
const PLACEHOLDER_IDS = ["", "", "", ""];

/** The deepest markets first; ties keep registry order (majors were listed first). */
function deepest(markets: Market[]): MarketId[] {
  return [...markets]
    .sort((a, b) => (a.exit_capacity === b.exit_capacity ? 0 : a.exit_capacity > b.exit_capacity ? -1 : 1))
    .slice(0, SHOWN)
    .map((m) => m.id);
}

/** Live exit liquidity of the registry's deepest markets, drawn from `get_depth`. */
export function ExitLiquidity() {
  const markets = useMarkets();
  const ids = markets.data ? deepest(markets.data) : [];
  const depths = useDepths(ids);
  const isDesktop = useIsDesktop();
  const cols = isDesktop ? 72 : 40;
  const queries = ids.map((id, i) => ({ id, query: depths[i] }));

  const assets: Asset[] = markets.data
    ? queries.map(({ id, query }) => ({ id, view: query.data, record: query.data?.history.at(-1) }))
    : PLACEHOLDER_IDS.map((id) => ({ id, view: undefined, record: undefined }));
  const loading = markets.isPending || queries.some((q) => q.query.isPending);
  const failed = markets.isError || (queries.length > 0 && queries.every((q) => q.query.isError));
  const records = assets.flatMap((a) => (a.record ? [a.record] : []));
  const width = LABEL_WIDTH + cols;
  const retry = () => {
    void markets.refetch();
    queries.forEach((q) => void q.query.refetch());
  };

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
                <span className="text-muted-foreground">The {networkName()} liquidity measurements could not be loaded.</span>
              </span>
              <Button variant="outline" size="sm" onClick={retry}>
                <RotateCw />
                Retry
              </Button>
            </div>
          ) : (
            <span className="sr-only" role="status">
              Loading liquidity measurements from {networkName()}
            </span>
          )}
        </div>
        {failed ? null : (
          <div aria-hidden className="flex flex-col gap-2">
            {assets.map((a, i) => (
              <div key={i} className="h-6 rounded-sm bg-muted" />
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
      <p className="text-label text-tertiary">
        Grid: $1k–$5M sell size, logarithmic. Denser / taller characters mean lower impact;
        amber approaches or exceeds 1%, red marks a missing quote. A full row is not unlimited liquidity.
      </p>
      {records.length ? (
        <>
          <LegendTable assets={assets} />
          <p className="text-label text-tertiary">
            The {assets.length} deepest of {markets.data?.length ?? assets.length} markets. Dry quotes from NEAR
            Intents 1Click (read-only), platform fee excluded, reported on chain by the keeper.
            The first missing quote or impact above 1% ends the measured range. Admission limits may be lower
            while increases ramp up; effective trading caps also depend on vault capital.
          </p>
        </>
      ) : (
        <p className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
          <span className="text-foreground">Last measurement unavailable.</span> No sample yet. Measurements
          require a running keeper; this read-only page does not start it.
        </p>
      )}
    </Figure>
  );
}
