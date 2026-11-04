"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useCandles } from "@/hooks/use-candles";
import { formatUtc } from "@/components/landing/live-time";
import { PRICE_DECIMALS } from "@/lib/near/format";
import type { Market } from "@/lib/near/types";
import { CANDLE_SOURCE, type CandleInterval } from "@/lib/prices/candles";
import { cn } from "@/lib/utils";

const INTERVALS: ReadonlyArray<{ id: CandleInterval; label: string }> = [
  { id: "5m", label: "5m" },
  { id: "1h", label: "1h" },
  { id: "1d", label: "D" },
];

const UP = "#2DBE8C";
const DOWN = "#F0506E";

interface ChartHandles {
  chart: IChartApi;
  candles: ISeriesApi<"Candlestick">;
  volume: ISeriesApi<"Histogram">;
  markLine: IPriceLine | null;
}

/** Decimals that keep about five significant digits: 78,180.7 · 2,316.65 · 4.0120. */
function precisionFor(price: number): number {
  if (price >= 10_000) return 1;
  if (price >= 100) return 2;
  if (price >= 1) return 4;
  return 6;
}

/**
 * Spot candles of the underlying from Coinbase (through `/api/candles`), with the onchain oracle
 * price, which positions are marked at, drawn as a dashed line.
 */
export function PriceChart({ market, className }: { market: Market; className?: string }) {
  const [interval, setChartInterval] = useState<CandleInterval>("1h");
  const candles = useCandles(market.id, interval);
  const container = useRef<HTMLDivElement>(null);
  const handles = useRef<ChartHandles | null>(null);
  const oraclePrice = market.price > 0n ? Number(market.price) / 10 ** PRICE_DECIMALS : null;

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#0B0B0C" },
        textColor: "#A3A3A3",
        fontSize: 11,
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        attributionLogo: true,
      },
      grid: { vertLines: { color: "#151517" }, horzLines: { color: "#151517" } },
      rightPriceScale: { borderColor: "#1F1F22" },
      timeScale: { borderColor: "#1F1F22", timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: "#7A7A7A" }, horzLine: { color: "#7A7A7A" } },
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    handles.current = { chart, candles: candleSeries, volume, markLine: null };
    return () => {
      handles.current = null;
      chart.remove();
    };
  }, []);

  useEffect(() => {
    const h = handles.current;
    const data = candles.data?.candles;
    if (!h || !data) return;
    const last = data.at(-1)?.close ?? 1;
    const precision = precisionFor(last);
    h.candles.applyOptions({ priceFormat: { type: "price", precision, minMove: 10 ** -precision } });
    h.candles.setData(
      data.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })),
    );
    h.volume.setData(
      data.map((c) => ({
        time: c.time as UTCTimestamp,
        value: c.volume,
        color: c.close >= c.open ? "rgba(45,190,140,0.35)" : "rgba(240,80,110,0.35)",
      })),
    );
  }, [candles.data]);

  // A new market or interval: show the whole new series instead of the previous zoom.
  useEffect(() => {
    if (candles.data) handles.current?.chart.timeScale().fitContent();
  }, [candles.data?.product, candles.data?.interval]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const h = handles.current;
    if (!h) return;
    if (oraclePrice === null) {
      if (h.markLine) h.candles.removePriceLine(h.markLine);
      h.markLine = null;
      return;
    }
    if (h.markLine) {
      h.markLine.applyOptions({ price: oraclePrice });
    } else {
      h.markLine = h.candles.createPriceLine({
        price: oraclePrice,
        color: "#F5B83D",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "Mark",
      });
    }
  }, [oraclePrice]);

  const last = candles.data?.candles.at(-1);

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-border px-3 text-label">
        <div role="group" aria-label="Interval" className="flex items-center gap-1">
          {INTERVALS.map((i) => (
            <button
              key={i.id}
              type="button"
              aria-pressed={interval === i.id}
              onClick={() => setChartInterval(i.id)}
              className="rounded-sm px-1.5 py-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring aria-pressed:text-foreground aria-pressed:bg-muted"
            >
              {i.label}
            </button>
          ))}
        </div>
        {last ? (
          <span className="hidden gap-2 tabular-nums text-tertiary sm:flex">
            <span>
              O <span className="text-foreground">{last.open}</span>
            </span>
            <span>
              H <span className="text-foreground">{last.high}</span>
            </span>
            <span>
              L <span className="text-foreground">{last.low}</span>
            </span>
            <span>
              C <span className={last.close >= last.open ? "text-success" : "text-destructive"}>{last.close}</span>
            </span>
          </span>
        ) : null}
        <span className="ml-auto truncate text-tertiary" data-testid="chart-source">
          Prices: {CANDLE_SOURCE}
          <span className="hidden sm:inline">
            {" "}
            {market.id}-USD spot{candles.data ? ` · ${formatUtc(candles.data.fetchedAtMs, true)}` : ""}
          </span>
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          ref={container}
          role="img"
          aria-label={`${market.id}-USD ${interval} candles from ${CANDLE_SOURCE}, with the oracle mark price line`}
          className="absolute inset-0"
        />
        {candles.isError && !candles.data ? (
          <p role="alert" className="absolute inset-x-0 top-1/2 text-center text-ui text-tertiary">
            {CANDLE_SOURCE} candles are unavailable right now: {candles.error.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}
