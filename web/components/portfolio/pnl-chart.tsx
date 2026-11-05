"use client";

import { useState, type KeyboardEvent, type PointerEvent } from "react";
import { EmptyState, Skeleton } from "@/components/app/states";
import { formatUsd } from "@/lib/near/format";
import type { HistoryEvent } from "@/lib/near/types";
import { formatHistoryAxis, formatHistoryTime } from "@/components/vault/vault-history";
import { cumulativePnl, type PnlPoint } from "./portfolio-math";

const VIEW_W = 1000;
const VIEW_H = 200;

const formatPnl = (value: bigint) => formatUsd(value, { signed: true, maxFractionDigits: 6, minFractionDigits: 2 });
const pnlColor = (value: bigint) => value > 0n ? "text-success" : value < 0n ? "text-destructive" : "text-foreground";

function yDomain(points: readonly PnlPoint[]): [bigint, bigint] {
  let min = points[0].value;
  let max = min;
  for (const point of points) {
    if (point.value < min) min = point.value;
    if (point.value > max) max = point.value;
  }
  let pad = max === min ? (max < 0n ? -max : max) / 2000n : (max - min) / 5n;
  const minimumPad = max === min ? 10_000n : 1n;
  if (pad < minimumPad) pad = minimumPad;
  return [min - pad, max + pad];
}

function Readout({ point, label }: { point: PnlPoint; label: string }) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-ui tabular-nums">
      <span className="text-tertiary">{label}</span>
      <span className={`font-medium ${pnlColor(point.value)}`}>{formatPnl(point.value)}</span>
      <time
        className="text-tertiary"
        dateTime={new Date(point.timestampMs).toISOString()}
        title={new Date(point.timestampMs).toISOString()}
      >
        {formatHistoryTime(point.timestampMs)}
      </time>
    </span>
  );
}

function Plot({ points }: { points: readonly PnlPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const first = points[0];
  const last = points[points.length - 1];
  const [y0, y1] = yDomain(points);
  const xFrac = (timestampMs: number) => (timestampMs - first.timestampMs) / (last.timestampMs - first.timestampMs);
  // Subtract in bigint before conversion so small changes survive a large all-time PnL anchor.
  const yFrac = (value: bigint) => Number(y1 - value) / Number(y1 - y0);
  const path = points.map((point, index) => {
    const x = (xFrac(point.timestampMs) * VIEW_W).toFixed(1);
    const y = (yFrac(point.value) * VIEW_H).toFixed(1);
    return index === 0 ? `M${x},${y}` : `H${x}V${y}`;
  }).join("");

  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const target = first.timestampMs + ((event.clientX - rect.left) / rect.width) * (last.timestampMs - first.timestampMs);
    let nearest = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(points[i].timestampMs - target) < Math.abs(points[nearest].timestampMs - target)) nearest = i;
    }
    setHover(nearest);
  };

  const shown = hover === null ? points.length - 1 : Math.min(hover, points.length - 1);
  const selected = points[shown];
  const marker = { left: `${xFrac(selected.timestampMs) * 100}%`, top: `${yFrac(selected.value) * 100}%` };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next = shown;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = Math.max(0, shown - 1);
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") next = Math.min(points.length - 1, shown + 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = points.length - 1;
    else return;
    event.preventDefault();
    setHover(next);
  };

  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="sr-only">
        {points.length} retained trading observations. All-time booked PnL goes from {formatPnl(first.value)} at {formatHistoryTime(first.timestampMs)} to {formatPnl(last.value)} at {formatHistoryTime(last.timestampMs)}.
        Use arrow keys to inspect actual observations. Earlier history is not plotted.
      </figcaption>
      <div className="flex min-h-5 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <Readout point={selected} label={hover === null ? "Latest booked PnL" : "Booked PnL"} />
      </div>
      <div className="flex gap-3">
        <div aria-hidden className="flex h-56 w-20 shrink-0 flex-col justify-between text-right text-label text-tertiary tabular-nums">
          <span>{formatUsd(y1)}</span>
          <span>{formatUsd((y0 + y1) / 2n)}</span>
          <span>{formatUsd(y0)}</span>
        </div>
        <div
          role="slider"
          tabIndex={0}
          aria-label="Booked PnL observation"
          aria-valuemin={1}
          aria-valuemax={points.length}
          aria-valuenow={shown + 1}
          aria-valuetext={`${formatPnl(selected.value)} at ${formatHistoryTime(selected.timestampMs)}`}
          className={`relative h-56 min-w-0 flex-1 touch-pan-y rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring ${pnlColor(last.value)}`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKeyDown}
          onBlur={() => setHover(null)}
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
            />
          </svg>
          {hover !== null ? (
            <div aria-hidden className="absolute inset-y-0 w-px bg-tertiary/50" style={{ left: marker.left }} />
          ) : null}
          <div
            aria-hidden
            className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-pill bg-current"
            style={marker}
          />
        </div>
      </div>
      <div className="flex justify-between gap-3 pl-23 text-label text-tertiary tabular-nums">
        {formatHistoryAxis(first.timestampMs, last.timestampMs).map((label, i) => (
          <span key={i} className={i ? "text-right" : undefined}>{label}</span>
        ))}
      </div>
    </figure>
  );
}

export function PnlChart({ events, total, loading }: { events: readonly HistoryEvent[]; total: bigint; loading: boolean }) {
  const points = cumulativePnl(events, total);
  const latest = points.at(-1);
  return (
    <section aria-label="All-time booked PnL" aria-busy={loading} className="flex min-w-0 flex-col gap-3 p-3">
      {loading ? (
        <>
          <p role="status" className="sr-only">Loading booked PnL history.</p>
          <Skeleton className="h-72 w-full" />
        </>
      ) : points.length >= 2 ? (
        <Plot points={points} />
      ) : (
        <div className="flex h-72 flex-col justify-center rounded-md border border-dashed border-border">
          <EmptyState>
            <span className={`font-medium tabular-nums ${pnlColor(total)}`}>{formatPnl(total)} all-time booked PnL. </span>
            {latest ? (
              <>
                One retained trading observation at {formatHistoryTime(latest.timestampMs)}. A curve needs at least two distinct trading timestamps.
              </>
            ) : (
              <>No retained trading events to plot. Trades and paid order executions create PnL observations.</>
            )}
          </EmptyState>
        </div>
      )}
      <p className="text-label text-tertiary">
        All-time booked PnL · source: last 200 account events, anchored to the all-time total. Trading fees, order rewards and settled funding included once; transfers and funding annotations excluded. Earlier history is not plotted.
      </p>
    </section>
  );
}
