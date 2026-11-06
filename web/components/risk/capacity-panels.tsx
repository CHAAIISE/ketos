"use client";

import { formatAge, formatUtc, STALE_AFTER_MS } from "@/components/landing/live-time";
import { ImpactChart } from "@/components/liquidity/impact-chart";
import { formatSizeUsd } from "@/components/liquidity/format";
import { PanelHeading } from "@/components/vault/panel-heading";
import { formatUsd, USDC_UNIT } from "@/lib/near/format";
import { formatExitCapacity, marketLimitLabel } from "@/lib/near/market-status";
import { exitCapacityUsd, MIN_OPEN_CAPACITY_USD } from "@/lib/intents/depth";
import type { DepthRecord, DepthView, Market } from "@/lib/near/types";
import { cn } from "@/lib/utils";

const DAY_MS = 24 * 60 * 60_000;
const WIDTH = 1000;
const HEIGHT = 200;

function timestamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 10)} ${formatUtc(ms, true)}`;
}

export function CapacityHeatmap({ markets, selected, onSelect, now }: {
  markets: Market[];
  selected: string;
  onSelect: (id: string) => void;
  now: number;
}) {
  return (
    <section aria-labelledby="capacity-heatmap-title" className="order-1 min-w-0 rounded-md border border-border bg-card">
      <PanelHeading id="capacity-heatmap-title">Capacity heatmap</PanelHeading>
      <p className="px-3 pt-2 text-label text-muted-foreground">Utilization = larger of long or short open interest (total size of open positions) / admitted exit depth. Admission depth can rise more slowly than measured liquidity. For ≥ depth, utilization is an upper bound (≤). Effective caps additionally account for protocol limits and vault backing. Select a market to inspect its risk.</p>
      <div className="grid min-w-0 grid-cols-2 gap-1 p-3 md:grid-cols-4 xl:grid-cols-8">
        {markets.map((market) => {
          const exposure = market.oi_long > market.oi_short ? market.oi_long : market.oi_short;
          const unmeasured = market.depth_measured_at_ms === 0;
          const stale = !unmeasured && now > 0 && now - market.depth_measured_at_ms > STALE_AFTER_MS;
          const clockUnknown = now === 0 || market.depth_measured_at_ms > now;
          const zeroWithOi = market.exit_capacity === 0n && exposure > 0n;
          const thin = market.exit_capacity < BigInt(MIN_OPEN_CAPACITY_USD) * USDC_UNIT;
          const bps = market.exit_capacity > 0n ? exposure * 10_000n / market.exit_capacity : null;
          const status = zeroWithOi ? "OI without capacity" : unmeasured ? "Unmeasured" : stale ? "Stale measurement" : clockUnknown ? "Freshness unconfirmed" : thin ? "Thin liquidity · new entries unavailable" : bps !== null && bps >= 10_000n ? "At / above capacity" : bps !== null && bps >= 5_000n ? "Elevated utilization" : "Below 50% utilization";
          const tone = zeroWithOi ? "border-destructive/50 bg-destructive/10 text-destructive" : unmeasured || clockUnknown ? "border-border bg-muted text-muted-foreground" : stale || thin ? "border-warning/50 bg-warning/10 text-warning" : bps !== null && bps >= 10_000n ? "border-destructive/50 bg-destructive/10 text-destructive" : bps !== null && bps >= 5_000n ? "border-warning/50 bg-warning/10 text-warning" : "border-success/50 bg-success/10 text-success";
          return (
            <button key={market.id} data-testid={`risk-market-${market.id}`} title={`Long OI ${formatUsd(market.oi_long)} · Short OI ${formatUsd(market.oi_short)} · ${status}`} type="button" aria-pressed={selected === market.id} onClick={() => onSelect(market.id)} className={cn("min-w-0 rounded-sm border p-2 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring", tone, selected === market.id && "ring-1 ring-inset ring-foreground")}>
              <span className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="break-all text-ui font-medium text-foreground">{market.id}</span>
                <span className="text-ui tabular-nums">{zeroWithOi ? "Uncovered" : bps === null ? "N/A" : `${market.measured_cap_is_grid_max ? "≤ " : ""}${bps / 100n}.${(bps % 100n).toString().padStart(2, "0")}%`}</span>
              </span>
              <span className="mt-1 block truncate text-label">{unmeasured ? "Measuring" : stale ? "Stale" : clockUnknown ? "Checking time" : zeroWithOi ? "Uncovered OI" : thin ? "Thin liquidity" : market.vault_id === "core" ? "Core" : "Long-tail"}</span>
              <span className="mt-2 flex justify-between gap-1 text-label text-muted-foreground"><span>OI</span><span className="truncate tabular-nums text-foreground">{formatUsd(exposure, { maxFractionDigits: 0 })}</span></span>
              <span className="flex flex-wrap justify-between gap-1 text-label text-muted-foreground"><span>Effective cap</span><span className="tabular-nums text-foreground">{formatUsd(market.effective_max_oi_per_side, { maxFractionDigits: 0 })}</span></span>
              <span className="block text-label text-muted-foreground">{marketLimitLabel(market)}</span>
              <span className="mt-1 flex flex-wrap justify-between gap-1 text-label text-muted-foreground"><span>Exit depth</span><span className="tabular-nums text-foreground">{unmeasured ? "—" : formatExitCapacity(market)}</span></span>
              {market.measured_cap_is_grid_max ? <span title="Probe grid passed; admission depth may be ramp-limited. See the curve for the largest size probed." className="block text-label text-muted-foreground">Probe grid passed</span> : null}
              <span className="mt-1 block text-label text-muted-foreground">{unmeasured ? "No sample yet" : `Depth ${formatUtc(market.depth_measured_at_ms, true)} · ${formatAge(market.depth_measured_at_ms, now)}`}</span>
            </button>
          );
        })}
      </div>
      {!markets.length ? <p className="px-3 pb-3 text-ui text-muted-foreground">No registry markets available.</p> : null}
      <p className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border p-3 text-label text-muted-foreground">
        <span className="text-success">Below 50%</span><span className="text-warning">50–&lt;100%</span><span className="text-destructive">≥100% / OI with zero capacity</span><span>Unmeasured / unknown: neutral</span><span className="text-warning">Stale / exit depth under $10k: warning</span>
      </p>
    </section>
  );
}

function recordCapacity(record: DepthRecord): string {
  const raw = exitCapacityUsd(record.samples);
  const gridMax = raw > 0 && record.samples.every((sample) => sample.size_usd <= raw);
  return `${gridMax ? "≥ " : ""}${formatSizeUsd(raw)}${gridMax ? " (largest size probed)" : ""}`;
}

function CapacityPlot({ records }: { records: DepthRecord[] }) {
  const first = records[0];
  const last = records[records.length - 1];
  const maximum = Math.max(1, ...records.map((record) => record.exit_capacity_usd));
  const x = (record: DepthRecord) => last.measured_at_ms === first.measured_at_ms ? WIDTH / 2 : (record.measured_at_ms - first.measured_at_ms) / (last.measured_at_ms - first.measured_at_ms) * WIDTH;
  const y = (record: DepthRecord) => HEIGHT - record.exit_capacity_usd / maximum * HEIGHT;
  const path = records.map((record, index) => `${index ? "L" : "M"}${x(record).toFixed(1)},${y(record).toFixed(1)}`).join("");
  return (
    <div className="min-w-0 p-3">
      <div className="mb-2 flex flex-wrap justify-between gap-2 text-label text-muted-foreground"><span>Admission depth (USD)</span><span className="tabular-nums">Scale: $0–{formatSizeUsd(maximum)}</span></div>
      <svg role="img" aria-label={`Admission depth at ${records.length} real onchain observations, from ${timestamp(first.measured_at_ms)} to ${timestamp(last.measured_at_ms)}. Admission depth and raw measured exit values follow in the table.`} viewBox={`-8 -8 ${WIDTH + 16} ${HEIGHT + 16}`} preserveAspectRatio="none" className="h-56 w-full">
        {[0, HEIGHT / 2, HEIGHT].map((line) => <line key={line} x1={0} x2={WIDTH} y1={line} y2={line} stroke="currentColor" vectorEffect="non-scaling-stroke" className="text-border" />)}
        <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" className="text-foreground" />
        {records.map((record) => <circle key={record.measured_at_ms} cx={x(record)} cy={y(record)} r={3} fill="currentColor" className="text-foreground"><title>{timestamp(record.measured_at_ms)} · Admission depth {formatSizeUsd(record.exit_capacity_usd)} · Measured exit {recordCapacity(record)} · {record.max_leverage}×</title></circle>)}
      </svg>
      <div className="mt-2 flex flex-wrap justify-between gap-2 text-label text-tertiary tabular-nums"><span>{timestamp(first.measured_at_ms)}</span><span>{timestamp(last.measured_at_ms)}</span></div>
      <p className="mt-2 text-label text-tertiary">Actual observation timestamps; connecting lines are not additional measurements. The retained ring may cover only minutes, not a full day.</p>
    </div>
  );
}

export function CapacityHistory({ view, now }: { view: DepthView | null; now: number }) {
  const records = now > 0 ? (view?.history ?? []).filter((record) => record.measured_at_ms >= now - DAY_MS && record.measured_at_ms <= now).sort((a, b) => a.measured_at_ms - b.measured_at_ms).slice(-48) : [];
  const latest = records.at(-1);
  const previous = records.at(-2);
  const recent = latest !== undefined && now - latest.measured_at_ms <= STALE_AFTER_MS;
  const capacityDrop = latest && previous && latest.exit_capacity_usd < previous.exit_capacity_usd;
  const leverageDrop = latest && previous && latest.max_leverage < previous.max_leverage;
  const tightened = recent && (capacityDrop || leverageDrop);
  return (
    <section aria-labelledby="capacity-history-title" className="min-w-0 rounded-md border border-border bg-card">
      <PanelHeading id="capacity-history-title" aside={<span className="text-label text-tertiary">{records.length} / 48 retained observations</span>}>{view ? `${view.market.id} · Capacity history` : "Capacity history"}</PanelHeading>
      <p className="px-3 pt-3 text-label text-muted-foreground">Last 24 hours only · onchain depth records · no backfilled observations. Admission depth may be ramp-limited. Measured exit is derived from each observation&apos;s quotes; ≥ marks the largest size probed, not an exact ceiling.</p>
      {!latest ? <p className="p-3 text-ui text-muted-foreground">{now === 0 ? "Waiting for the current time to filter the last 24 hours." : "No measurements retained in the last 24 hours. Check again after a new measurement is recorded."}</p> : (
        <>
          <div role="status" className={cn("m-3 border p-3 text-ui", tightened ? "border-warning/50 bg-warning/10 text-warning" : "border-border text-muted-foreground")}>
            {tightened && previous ? <><p className="font-medium">Market tightened</p><p className="mt-1 text-label">Latest recent measurement {timestamp(latest.measured_at_ms)} vs preceding record {timestamp(previous.measured_at_ms)}. {capacityDrop ? `Admission depth: ${formatSizeUsd(previous.exit_capacity_usd)} → ${formatSizeUsd(latest.exit_capacity_usd)}. ` : ""}{leverageDrop ? `Max leverage: ${previous.max_leverage}× → ${latest.max_leverage}×.` : ""}</p></> : <p>No recent tightening observed (limited retained history). Alerts compare the latest measurement, if within 30 min, with its preceding retained record.</p>}
            <p className="mt-1 text-label"><span>Last measurement</span>: {timestamp(latest.measured_at_ms)} · {formatAge(latest.measured_at_ms, now)}{!recent ? " · stale measurement" : ""}. {previous ? `Baseline: ${timestamp(previous.measured_at_ms)}.` : "No preceding retained record for comparison."}</p>
          </div>
          {records.length >= 2 ? (
            <CapacityPlot records={records} />
          ) : (
            <p className="px-3 pb-3 text-label text-tertiary">One observation in the window: the curve appears from the second measurement. Its value is in the table below.</p>
          )}
          <div className="min-w-0 overflow-x-auto border-t border-border">
            <table className="w-full text-label">
              <caption className="sr-only">Real onchain depth observations, newest first</caption>
              <thead className="bg-muted text-tertiary"><tr><th scope="col" className="px-3 py-2 text-left font-normal">Timestamp (UTC)</th><th scope="col" className="px-3 py-2 text-right font-normal">Admission depth</th><th scope="col" className="px-3 py-2 text-right font-normal">Measured exit</th><th scope="col" className="px-3 py-2 text-right font-normal">Max lev.</th></tr></thead>
              <tbody>{records.toReversed().map((record) => <tr key={record.measured_at_ms} className="border-t border-border tabular-nums"><td className="px-3 py-2 text-muted-foreground"><time dateTime={new Date(record.measured_at_ms).toISOString()}>{timestamp(record.measured_at_ms)}</time></td><td className="px-3 py-2 text-right text-foreground">{formatSizeUsd(record.exit_capacity_usd)}</td><td className="px-3 py-2 text-right text-foreground">{recordCapacity(record)}</td><td className="px-3 py-2 text-right text-foreground">{record.max_leverage}×</td></tr>)}</tbody>
            </table>
          </div>
          <details className="border-t border-border p-3"><summary className="cursor-pointer text-ui text-muted-foreground outline-none focus-visible:outline-2 focus-visible:outline-ring">Latest measured impact curve · {formatUtc(latest.measured_at_ms, true)}{!recent ? " · stale" : ""}</summary><div className="mt-3 min-w-0"><ImpactChart record={latest} /></div></details>
        </>
      )}
    </section>
  );
}
