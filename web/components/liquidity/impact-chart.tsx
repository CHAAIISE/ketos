"use client";

import { useEffect, useRef, useState } from "react";
import { exitCapacityUsd, MAX_EXIT_IMPACT_BPS } from "@/lib/intents/depth";
import type { DepthRecord } from "@/lib/near/types";
import { formatSizeUsd } from "./format";

const HEIGHT = 440;
const PAD = { top: 28, right: 20, bottom: 36, left: 52 };

/** Impact curve of one depth record: log-scaled sell size against net price impact. */
export function ImpactChart({ record }: { record: DepthRecord }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const samples = [...record.samples].sort((a, b) => a.size_usd - b.size_usd);
  const measured = samples.flatMap((s) => (s.impact_bps === null ? [] : [s.impact_bps]));
  const yMax = niceMax(Math.max(MAX_EXIT_IMPACT_BPS * 1.5, ...measured));
  const minSize = samples[0]?.size_usd ?? 1_000;
  const maxSize = samples.at(-1)?.size_usd ?? 1_000_000;
  const innerW = Math.max(0, width - PAD.left - PAD.right);
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const logSpan = Math.log10(maxSize) - Math.log10(minSize) || 1;
  const x = (size: number) => PAD.left + ((Math.log10(size) - Math.log10(minSize)) / logSpan) * innerW;
  const y = (bps: number) => PAD.top + innerH - (Math.min(bps, yMax) / yMax) * innerH;
  const yTicks = [0, 1, 2, 3, 4].map((i) => (i * yMax) / 4);
  const compact = width < 520;

  const points = samples.filter((s) => s.impact_bps !== null).map((s) => `${x(s.size_usd)},${y(s.impact_bps as number)}`);
  const capacity = exitCapacityUsd(samples);
  const gridMax = capacity > 0 && capacity === maxSize;

  return (
    <div ref={ref} className="w-full" style={{ height: HEIGHT }}>
      {width > 0 ? (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={`Price impact by sell size; measured exit ${gridMax ? "at least " : ""}${formatSizeUsd(capacity)}${gridMax ? ", largest size probed" : ""}; admission depth ${formatSizeUsd(record.exit_capacity_usd)}`}
          className="text-label"
        >
          {yTicks.map((tick) => (
            <g key={tick}>
              <line x1={PAD.left} x2={PAD.left + innerW} y1={y(tick)} y2={y(tick)} className="stroke-border" />
              <text x={PAD.left - 8} y={y(tick)} dy="0.35em" textAnchor="end" className="fill-tertiary tabular-nums">
                {tick}
              </text>
            </g>
          ))}
          <text x={PAD.left - 8} y={PAD.top - 14} textAnchor="end" className="fill-tertiary">
            bps
          </text>

          {samples.map((s, i) => (
            <text
              key={s.size_usd}
              x={x(s.size_usd)}
              y={HEIGHT - PAD.bottom + 20}
              textAnchor="middle"
              className="fill-tertiary tabular-nums"
            >
              {compact && i % 2 === 1 && i !== samples.length - 1 ? "" : formatSizeUsd(s.size_usd)}
            </text>
          ))}

          <line
            x1={PAD.left}
            x2={PAD.left + innerW}
            y1={y(MAX_EXIT_IMPACT_BPS)}
            y2={y(MAX_EXIT_IMPACT_BPS)}
            className="stroke-accent"
            strokeDasharray="4 4"
          />
          <text x={PAD.left + innerW} y={y(MAX_EXIT_IMPACT_BPS) - 6} textAnchor="end" className="fill-accent">
            {MAX_EXIT_IMPACT_BPS} bps limit
          </text>

          {capacity > 0 ? (
            <g>
              <line
                x1={x(capacity)}
                x2={x(capacity)}
                y1={PAD.top}
                y2={PAD.top + innerH}
                className="stroke-foreground"
                strokeOpacity={0.5}
              />
              <text
                x={x(capacity) + (x(capacity) > PAD.left + innerW * 0.5 ? -6 : 6)}
                y={PAD.top + innerH - 8}
                textAnchor={x(capacity) > PAD.left + innerW * 0.5 ? "end" : "start"}
                className="fill-foreground"
              >
                Exit {gridMax ? "≥ " : ""}{formatSizeUsd(capacity)}
              </text>
            </g>
          ) : null}

          {points.length > 1 ? (
            <polyline points={points.join(" ")} fill="none" className="stroke-foreground" strokeWidth={1.5} />
          ) : null}
          {samples.map((s) =>
            s.impact_bps === null ? (
              <g key={s.size_usd} className="text-destructive">
                <path
                  d={`M${x(s.size_usd) - 4},${PAD.top - 4} l8,8 m0,-8 l-8,8`}
                  stroke="currentColor"
                  strokeWidth={1.5}
                />
                <title>{`${formatSizeUsd(s.size_usd)}: no liquidity`}</title>
              </g>
            ) : (
              <circle
                key={s.size_usd}
                cx={x(s.size_usd)}
                cy={y(s.impact_bps)}
                r={3}
                className={s.impact_bps > MAX_EXIT_IMPACT_BPS ? "fill-accent" : "fill-foreground"}
              >
                <title>{`${formatSizeUsd(s.size_usd)}: ${s.impact_bps} bps`}</title>
              </circle>
            ),
          )}
          {samples.some((s) => s.impact_bps === null) ? (
            <text
              x={x(samples.find((s) => s.impact_bps === null)!.size_usd) - 10}
              y={PAD.top - 14}
              textAnchor="end"
              className="fill-destructive"
            >
              No liquidity
            </text>
          ) : null}
        </svg>
      ) : null}
    </div>
  );
}

function niceMax(value: number): number {
  const step = value <= 200 ? 50 : value <= 1_000 ? 100 : 500;
  return Math.ceil(value / (step * 4)) * step * 4;
}
