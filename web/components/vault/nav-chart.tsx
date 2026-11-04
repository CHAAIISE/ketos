"use client";

import { useState, type PointerEvent } from "react";
import { EmptyState, Skeleton } from "@/components/app/states";
import { formatUtc } from "@/components/landing/live-time";
import { formatUsd, usdcToNumber, USDC_UNIT } from "@/lib/near/format";
import { cn } from "@/lib/utils";
import type { NavPoint } from "./nav-history";

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

function Readout({ point, label }: { point: NavPoint; label: string }) {
  return (
    <span className="flex items-baseline gap-2 text-ui tabular-nums">
      <span className="text-tertiary">{label}</span>
      <span className="font-medium text-foreground">{formatUsd(point.nav)}</span>
      <span className="text-tertiary">
        share {formatUsd(point.sharePrice, { maxFractionDigits: 4 })} · {formatUtc(point.t, true)}
      </span>
    </span>
  );
}

function Plot({ points }: { points: NavPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const values = points.map((p) => usdcToNumber(p.nav));
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
        <Readout point={points[shown]} label={hover === null ? "Latest" : "At"} />
      </div>
      <div className="flex gap-3">
        <div className="flex h-56 w-20 shrink-0 flex-col justify-between text-right text-label text-tertiary tabular-nums">
          <span>{formatUsd(toUnits(y1))}</span>
          <span>{formatUsd(toUnits((y0 + y1) / 2))}</span>
          <span>{formatUsd(toUnits(y0))}</span>
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
        <span>{formatUtc(t0, true)}</span>
        <span>{formatUtc(t1, true)}</span>
      </div>
    </div>
  );
}

/** NAV as read by this browser tab; the contract keeps no NAV history. */
export function NavChart({ points, loading, className }: { points: NavPoint[]; loading: boolean; className?: string }) {
  const latest = points.at(-1);
  return (
    <section aria-label="NAV since you opened this page" className={cn("flex min-w-0 flex-col gap-3", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-ui font-medium text-foreground">NAV since you opened this page</h3>
        <span className="text-label text-tertiary">read from the contract every 10 s while this tab is open</span>
      </div>
      {points.length >= 2 ? (
        <Plot points={points} />
      ) : loading || !latest ? (
        <Skeleton className="h-72 w-full" />
      ) : (
        <div className="flex h-72 flex-col justify-center rounded-md border border-dashed border-border">
          <EmptyState>
            <span className="text-foreground tabular-nums">
              {formatUsd(latest.nav)} at {formatUtc(latest.t, true)}.
            </span>{" "}
            The contract keeps no NAV history, so this chart starts with your first read and adds a point every 10 s.
          </EmptyState>
        </div>
      )}
    </section>
  );
}
