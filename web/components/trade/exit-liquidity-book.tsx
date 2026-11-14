"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { formatAge, formatUtc, STALE_AFTER_MS, useNow } from "@/components/landing/live-time";
import { EmptyState, ErrorState, Skeleton } from "@/components/app/states";
import { Term } from "@/components/vault/term";
import { PanelTabs } from "@/components/ui/panel-tabs";
import { formatSizeUsd } from "@/components/liquidity/format";
import { useAllOpenPositions, useDepth, useLiquidations } from "@/hooks/use-ketos-queries";
import { MAX_EXIT_IMPACT_BPS } from "@/lib/intents/depth";
import { formatPrice, usd0 } from "@/lib/near/format";
import { formatExitCapacity, marketLimitLabel } from "@/lib/near/market-status";
import type { DepthRecord, Market, Side } from "@/lib/near/types";
import { cn } from "@/lib/utils";
import { OiBar } from "./oi-bar";

const TABS = [
  { id: "liquidity", label: "Exit Liquidity", testId: "book-tab-liquidity" },
  { id: "trades", label: "Trades", testId: "book-tab-trades" },
] as const;
type Tab = (typeof TABS)[number]["id"];


/** Same log-size / impact axes as the full measured curve, kept compact for the terminal. */
function MiniImpactCurve({ record, marketId }: { record: DepthRecord; marketId: string }) {
  const samples = [...record.samples].sort((a, b) => a.size_usd - b.size_usd);
  const firstSize = samples[0]?.size_usd;
  const lastSize = samples.at(-1)?.size_usd;
  if (!firstSize || !lastSize) {
    return <p role="status" className="border-t border-border px-3 py-3 text-label text-muted-foreground">No impact samples available.</p>;
  }
  const yMax = Math.ceil(Math.max(150, ...samples.map((sample) => sample.impact_bps ?? 0)) / 50) * 50;
  const logSpan = Math.log10(lastSize) - Math.log10(firstSize) || 1;
  const x = (size: number) => 36 + ((Math.log10(size) - Math.log10(firstSize)) / logSpan) * 188;
  const y = (impact: number) => 104 - (impact / yMax) * 80;
  // A missing quote breaks the line: it is not a zero-impact observation.
  const path = samples.map((sample, index) => {
    if (sample.impact_bps === null) return "";
    const command = index > 0 && samples[index - 1].impact_bps !== null ? "L" : "M";
    return `${command}${x(sample.size_usd)},${y(sample.impact_bps)}`;
  }).join(" ");
  const unquoted = samples.some((sample) => sample.impact_bps === null);

  return (
    <figure className="mt-auto shrink-0 border-t border-border px-3 py-2" data-testid="mini-impact-curve">
      <figcaption className="flex justify-between gap-2 text-label text-muted-foreground">
        <span>Measured impact</span>
        {unquoted ? <span className="text-destructive">× No quote</span> : null}
      </figcaption>
      <svg
        viewBox="0 0 240 144"
        role="img"
        aria-label={`${marketId} measured sell impact by USD size on a logarithmic axis. Dashed line: ${MAX_EXIT_IMPACT_BPS} basis-point threshold. ${samples.length} samples${unquoted ? "; crosses indicate unavailable quotes, not impact values" : ""}.`}
        className="mx-auto w-full max-w-72 text-label tabular-nums"
      >
        <text x="0" y="13" className="fill-tertiary">Impact (bps)</text>
        {[0, yMax].map((tick) => (
          <g key={tick}>
            <line x1="36" x2="224" y1={y(tick)} y2={y(tick)} className="stroke-border" />
            <text x="30" y={y(tick)} dy="0.35em" textAnchor="end" className="fill-tertiary">{tick}</text>
          </g>
        ))}
        <line x1="36" x2="36" y1="24" y2="104" className="stroke-border" />
        <line x1="36" x2="224" y1={y(MAX_EXIT_IMPACT_BPS)} y2={y(MAX_EXIT_IMPACT_BPS)} strokeDasharray="4 4" className="stroke-accent" />
        <text x="224" y={y(MAX_EXIT_IMPACT_BPS) - 5} textAnchor="end" className="fill-accent">{MAX_EXIT_IMPACT_BPS} bps</text>
        <path d={path} fill="none" strokeWidth="1.5" className="stroke-foreground" />
        {samples.map((sample) => sample.impact_bps === null ? (
          <g key={sample.size_usd} className="stroke-destructive" strokeWidth="1.5">
            <path d={`M${x(sample.size_usd) - 3},21 l6,6 m0,-6 l-6,6`} />
            <title>{formatSizeUsd(sample.size_usd)}: no quote</title>
          </g>
        ) : (
          <circle key={sample.size_usd} cx={x(sample.size_usd)} cy={y(sample.impact_bps)} r="2" className={sample.impact_bps > MAX_EXIT_IMPACT_BPS ? "fill-accent" : "fill-foreground"}>
            <title>{formatSizeUsd(sample.size_usd)}: {sample.impact_bps} bps</title>
          </circle>
        ))}
        <text x="36" y="121" className="fill-tertiary">{formatSizeUsd(firstSize)}</text>
        {lastSize !== firstSize ? <text x="224" y="121" textAnchor="end" className="fill-tertiary">{formatSizeUsd(lastSize)}</text> : null}
        <text x="130" y="140" textAnchor="middle" className="fill-tertiary">Sell size (USD, log)</text>
      </svg>
    </figure>
  );
}

function ExitLadder({ market }: { market: Market }) {
  const depth = useDepth(market.id);
  const nowMs = useNow();
  const record = depth.data?.history.at(-1);

  if (depth.isPending) return <Skeleton className="m-3 h-64" />;
  if (depth.isError) {
    return <ErrorState className="m-3" title="Exit liquidity could not be read." error={depth.error} onRetry={() => void depth.refetch()} />;
  }
  if (!record) {
    return <EmptyState>No exit-liquidity measurement yet: the market opens after the first one.</EmptyState>;
  }

  const stale = nowMs > 0 && nowMs - record.measured_at_ms > STALE_AFTER_MS;
  const maxSize = Math.max(...record.samples.map((s) => s.size_usd));
  // The cap line goes under the last size that every smaller size also kept within 100 bps.
  let capIndex = -1;
  for (const [i, s] of record.samples.entries()) {
    if (s.impact_bps === null || s.impact_bps > MAX_EXIT_IMPACT_BPS) break;
    capIndex = i;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn("flex items-center justify-between px-3 py-1.5 text-label tabular-nums text-tertiary", stale && "text-warning")}>
        <span>
          Measured {formatUtc(record.measured_at_ms)}
          {nowMs ? ` · ${formatAge(record.measured_at_ms, nowMs)}` : ""}
        </span>
        <span>NEAR Intents</span>
      </div>
      <div role="table" aria-label={`${market.id} exit liquidity by sell size`} className="min-h-0 overflow-y-auto text-label tabular-nums">
        <div role="row" className="grid h-6 grid-cols-3 items-center px-3 text-tertiary">
          <span role="columnheader">
            <Term hint="Whether NEAR Intents returned a nonbinding dry quote at the measurement time. This is not an executable price or reserved liquidity.">
              Quote
            </Term>
          </span>
          <span role="columnheader" className="text-right">Size (USD)</span>
          <span role="columnheader" className="text-right">
            <Term hint="Price impact quoted by NEAR Intents 1Click for selling this size into USDC, after its fee.">Impact</Term>
          </span>
        </div>
        {record.samples.map((s, i) => {
          const none = s.impact_bps === null;
          const within = i <= capIndex;
          const tone = none ? "text-destructive" : within ? "text-success" : "text-warning";
          return (
            <Fragment key={s.size_usd}>
              <div role="row" data-testid={`exit-row-${s.size_usd}`} className="relative grid h-6 grid-cols-3 items-center px-3">
                <span
                  aria-hidden
                  className={cn(
                    "absolute inset-y-px right-0",
                    none ? "bg-destructive/10" : within ? "bg-success/10" : "bg-warning/10",
                  )}
                  style={{ width: `${none ? 100 : (s.size_usd / maxSize) * 100}%` }}
                />
                <span role="cell" className={cn("relative", tone)}>
                  {s.impact_bps === null ? "No quote" : "Available"}
                </span>
                <span role="cell" className="relative text-right text-foreground">{formatSizeUsd(s.size_usd)}</span>
                <span role="cell" className={cn("relative text-right", none ? "text-destructive" : within ? "text-foreground" : "text-warning")}>
                  {s.impact_bps === null ? "—" : `${s.impact_bps} bps`}
                </span>
              </div>
              {i === capIndex ? (
                <div role="row" data-testid="cap-line" className="flex h-7 items-center justify-between border-y border-border bg-muted px-3 text-foreground">
                  <span role="cell">{MAX_EXIT_IMPACT_BPS} bps cap</span>
                  <span role="cell" className="tabular-nums" title={capIndex === record.samples.length - 1 ? "Largest size probed; actual exit capacity may be greater." : undefined}>Exit {formatExitCapacity(market, record)}</span>
                </div>
              ) : null}
            </Fragment>
          );
        })}
        {capIndex === -1 ? (
          <div role="row" data-testid="cap-line" className="flex h-7 items-center border-y border-border bg-muted px-3 text-destructive">
            <span role="cell">No size sold within {MAX_EXIT_IMPACT_BPS} bps</span>
          </div>
        ) : null}
      </div>
      <MiniImpactCurve record={record} marketId={market.id} />
      <div className="flex shrink-0 flex-col gap-2 border-t border-border px-3 py-2.5">
        <p className="text-label text-muted-foreground">
          Effective cap {usd0(market.effective_max_oi_per_side)} · {marketLimitLabel(market)}
        </p>
        {capIndex === record.samples.length - 1 ? <p className="text-label text-tertiary">{formatExitCapacity(market, record)} (largest size probed)</p> : null}
        {(["long", "short"] as const).map((side) => {
          const used = side === "long" ? market.oi_long : market.oi_short;
          return (
            <div key={side} className="flex flex-col gap-1">
              <div className="flex justify-between text-label">
                <span className={side === "long" ? "text-success" : "text-destructive"}>{side === "long" ? "Longs" : "Shorts"}</span>
                <span className="tabular-nums text-muted-foreground">
                  {usd0(used)} of {usd0(market.effective_max_oi_per_side)}
                </span>
              </div>
              <OiBar used={used} cap={market.effective_max_oi_per_side} />
            </div>
          );
        })}
        <Link href="/risk" className="text-label text-tertiary transition-colors hover:text-foreground">
          See the measured curves →
        </Link>
      </div>
    </div>
  );
}

interface TradeRow {
  key: string;
  timeMs: number;
  side: Side;
  size: bigint;
  price: bigint;
  kind: "Open" | "Liquidation";
}

function TradesList({ market }: { market: Market }) {
  const open = useAllOpenPositions();
  const liquidations = useLiquidations();
  const nowMs = useNow();

  if (open.isPending || liquidations.isPending) return <Skeleton className="m-3 h-64" />;
  if (open.isError || liquidations.isError) {
    return (
      <ErrorState
        className="m-3"
        title="Trades could not be read."
        error={open.error ?? liquidations.error}
        onRetry={() => {
          void open.refetch();
          void liquidations.refetch();
        }}
      />
    );
  }

  const rows: TradeRow[] = [
    ...open.data
      .filter((p) => p.market_id === market.id)
      .map((p) => ({ key: `p${p.id}`, timeMs: p.opened_at_ms, side: p.side, size: p.size, price: p.entry_price, kind: "Open" as const })),
    ...liquidations.data
      .filter((l) => l.market_id === market.id)
      .map((l) => ({ key: `l${l.position_id}`, timeMs: l.timestamp_ms, side: l.side, size: l.size, price: l.price, kind: "Liquidation" as const })),
  ].sort((a, b) => b.timeMs - a.timeMs);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {rows.length === 0 ? (
        <EmptyState>No open position or liquidation on {market.id} yet.</EmptyState>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full text-label tabular-nums">
            <thead className="sticky top-0 bg-card text-tertiary">
              <tr className="h-7">
                <th scope="col" className="px-3 text-left font-normal">Price</th>
                <th scope="col" className="px-3 text-right font-normal">Size (USD)</th>
                <th scope="col" className="px-3 text-right font-normal">Time</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="h-6">
                  <td className={cn("px-3 text-left", r.side === "long" ? "text-success" : "text-destructive")}>
                    {formatPrice(r.price)}
                    {r.kind === "Liquidation" ? <span className="ml-1.5 text-warning">Liq.</span> : null}
                  </td>
                  <td className="px-3 text-right text-foreground">{usd0(r.size)}</td>
                  <td className="px-3 text-right text-tertiary" title={new Date(r.timeMs).toISOString()}>
                    {formatAge(r.timeMs, nowMs) || formatUtc(r.timeMs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="border-t border-border px-3 py-2 text-label text-tertiary">
        Current open positions and recent keeper liquidations. Your closed trades are in Trade History.
      </p>
    </div>
  );
}

/** Where an order book would be: the measured exit liquidity and the market's trades. */
export function ExitLiquidityBook({ market, className }: { market: Market; className?: string }) {
  const [tab, setTab] = useState<Tab>("liquidity");
  return (
    <section aria-label="Exit liquidity and trades" className={cn("flex min-h-0 min-w-0 flex-col rounded-md border border-border bg-card", className)}>
      <PanelTabs tabs={TABS} value={tab} onChange={setTab} label="Market data" idPrefix="book" />
      <div id="book-panel" role="tabpanel" aria-labelledby={`book-tab-${tab}`} className="flex min-h-0 flex-1 flex-col">
        {tab === "liquidity" ? <ExitLadder market={market} /> : <TradesList market={market} />}
      </div>
    </section>
  );
}
