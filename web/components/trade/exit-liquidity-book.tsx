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
import type { Market, Side } from "@/lib/near/types";
import { cn } from "@/lib/utils";
import { OiBar } from "./oi-bar";

const TABS = [
  { id: "liquidity", label: "Exit Liquidity", testId: "book-tab-liquidity" },
  { id: "trades", label: "Trades", testId: "book-tab-trades" },
] as const;
type Tab = (typeof TABS)[number]["id"];

/** Oracle price moved down by the measured impact: the average price a sell of that size got. */
function exitPrice(price: bigint, impactBps: number): bigint {
  return (price * BigInt(10_000 - Math.round(impactBps))) / 10_000n;
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
      <div role="table" aria-label={`${market.id} exit liquidity by sell size`} className="text-label tabular-nums">
        <div role="row" className="grid h-6 grid-cols-3 items-center px-3 text-tertiary">
          <span role="columnheader">
            <Term hint="Oracle price lowered by the measured impact: the average price a sell of this size would get.">
              Avg. Exit
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
                  {s.impact_bps === null
                    ? "No liquidity"
                    : market.price > 0n
                      ? formatPrice(exitPrice(market.price, s.impact_bps))
                      : "—"}
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
      <div className="mt-auto flex flex-col gap-2 border-t border-border px-3 py-2.5">
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
