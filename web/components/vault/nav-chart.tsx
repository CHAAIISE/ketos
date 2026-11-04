"use client";

import { useState, type PointerEvent } from "react";
import { EmptyState, Skeleton } from "@/components/app/states";
import { formatUsd, usdcToNumber, USDC_UNIT } from "@/lib/near/format";
import { formatHistoryTime, type HistoryPoint } from "./vault-history";

const VIEW_W = 1000;
const VIEW_H = 200;

const toUnits = (dollars: number) => BigInt(Math.round(dollars * Number(USDC_UNIT)));

function yDomain(values: number[]): [number, number] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat NAV still gets a visible band, about ±0.05% around the value.
  const pad = max > min ? (max - min) * 0.2 : Math.max(Math.abs(max) * 0.0005, 0.01);
  return [min - pad, max + pad];
}

function Readout({ point, label, metric }: { point: HistoryPoint; label: string; metric: "nav" | "sharePrice" }) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-ui tabular-nums">
      <span className="text-tertiary">{label}{point.live ? " · live" : " · snapshot"}</span>
      <span className="font-medium text-foreground">{formatUsd(point[metric], { maxFractionDigits: metric === "nav" ? 2 : 6 })}</span>
      <span className="text-tertiary">
        {formatHistoryTime(point.t)}
      </span>
    </span>
  );
}

function Plot({ points, metric }: { points: HistoryPoint[]; metric: "nav" | "sharePrice" }) {
  const [hover, setHover] = useState<number | null>(null);
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const values = points.map((p) => usdcToNumber(p[metric]));
  const [y0, y1] = yDomain(values);
  const xFrac = (t: number) => (t1 === t0 ? 1 : (t - t0) / (t1 - t0));
  const yFrac = (v: number) => (y1 - v) / (y1 - y0);
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${(xFrac(p.t) * VIEW_W).toFixed(1)},${(yFrac(values[i]) * VIEW_H).toFixed(1)}`)
    .join("");

  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const target = t0 + ((event.clientX - rect.left) / rect.width) * (t1 - t0);
    let nearest = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(points[i].t - target) < Math.abs(points[nearest].t - target)) nearest = i;
    }
    setHover(nearest);
  };

  const shown = hover ?? points.length - 1;
  const marker = { left: `${xFrac(points[shown].t) * 100}%`, top: `${yFrac(values[shown]) * 100}%` };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-5 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <Readout point={points[shown]} label={hover === null ? "Latest" : "At"} metric={metric} />
      </div>
      <div className="flex gap-3">
        <div className="flex h-56 w-20 shrink-0 flex-col justify-between text-right text-label text-tertiary tabular-nums">
          <span>{formatUsd(toUnits(y1), { maxFractionDigits: metric === "nav" ? 2 : 6 })}</span>
          <span>{formatUsd(toUnits((y0 + y1) / 2), { maxFractionDigits: metric === "nav" ? 2 : 6 })}</span>
          <span>{formatUsd(toUnits(y0), { maxFractionDigits: metric === "nav" ? 2 : 6 })}</span>
        </div>
        <div
          className="relative h-56 min-w-0 flex-1 touch-pan-y"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          <svg
            aria-hidden
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            preserveAspectRatio="none"
            className="absolute inset-0 size-full overflow-visible"
          >
            <g className="text-border" stroke="currentColor" strokeWidth={1}>
              {[0, VIEW_H / 2, VIEW_H].map((y) => (
                <line key={y} x1={0} x2={VIEW_W} y1={y} y2={y} vectorEffect="non-scaling-stroke" />
              ))}
            </g>
            <path
              d={path}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className="text-foreground"
            />
          </svg>
          {hover !== null ? (
            <div aria-hidden className="absolute inset-y-0 w-px bg-tertiary/50" style={{ left: marker.left }} />
          ) : null}
          <div
            aria-hidden
            className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-pill bg-foreground"
            style={marker}
          />
        </div>
      </div>
      <div className="flex justify-between pl-23 text-label text-tertiary tabular-nums">
        <span>{formatHistoryTime(t0)}</span>
        <span className="text-right">{formatHistoryTime(t1)}</span>
      </div>
    </div>
  );
}

export function NavChart({ points, metric, loading }: { points: HistoryPoint[]; metric: "nav" | "sharePrice"; loading: boolean }) {
  const latest = points.at(-1);
  return (
    <section aria-label={metric === "nav" ? "NAV history" : "Share price history"} className="flex min-w-0 flex-col gap-3 p-3">
      {loading ? <Skeleton className="h-72 w-full" /> : points.length >= 2 ? (
        <Plot points={points} metric={metric} />
      ) : (
        <div className="flex h-72 flex-col justify-center rounded-md border border-dashed border-border">
          <EmptyState>
            {latest ? <span className="text-foreground tabular-nums">{formatUsd(latest[metric], { maxFractionDigits: metric === "nav" ? 2 : 6 })} at {formatHistoryTime(latest.t)}. </span> : null}
            Not enough observations to draw a history yet. The keeper records at most one snapshot per hour; missed hours are not backfilled.
          </EmptyState>
        </div>
      )}
      <p className="text-label text-tertiary">Hourly onchain snapshots · up to 7 days · latest live read appended. NAV includes deposits and withdrawals; share price isolates performance per share.</p>
    </section>
  );
}
