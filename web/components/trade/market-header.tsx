"use client";

import type { ReactNode } from "react";
import { FlashValue } from "@/components/landing/flash-value";
import { formatAge, useNow } from "@/components/landing/live-time";
import { Badge } from "@/components/ui/badge";
import { formatPrice, formatUsd } from "@/lib/near/format";
import type { Market, MarketId } from "@/lib/near/types";
import { cn } from "@/lib/utils";
import { isPriceFresh, marketStatus } from "./market-status";

function Stat({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-label text-tertiary">{label}</dt>
      <dd className="text-ui font-medium text-foreground tabular-nums">{children}</dd>
      {hint ? <dd className="text-label text-tertiary tabular-nums">{hint}</dd> : null}
    </div>
  );
}

/** Market selector and the live numbers of the selected market. */
export function MarketHeader({
  markets,
  market,
  onSelect,
  aside,
}: {
  markets: readonly Market[];
  market: Market;
  onSelect: (id: MarketId) => void;
  aside?: ReactNode;
}) {
  const nowMs = useNow();
  const status = marketStatus(market, nowMs);
  const fresh = isPriceFresh(market, nowMs);

  return (
    <section
      aria-label={`${market.id}-PERP market`}
      className="flex flex-col gap-4 rounded-lg border border-border bg-card p-3 md:p-4 xl:flex-row xl:items-center xl:gap-8"
    >
      <div className="flex items-center justify-between gap-4 xl:justify-start">
        <div role="tablist" aria-label="Markets" className="flex gap-1 overflow-x-auto [scrollbar-width:none]">
          {markets.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={m.id === market.id}
              data-testid={`market-tab-${m.id}`}
              onClick={() => onSelect(m.id)}
              className="shrink-0 rounded-md px-2.5 py-1.5 text-ui font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring aria-selected:bg-muted aria-selected:text-foreground"
            >
              {m.id}
            </button>
          ))}
        </div>
        {aside ? <div className="xl:hidden">{aside}</div> : null}
      </div>

      <div className="flex items-baseline gap-3">
        <h1 className="font-display text-heading text-foreground">{market.id}-PERP</h1>
        <span className="text-price tabular-nums text-foreground" data-testid="mark-price">
          {market.price > 0n ? (
            <FlashValue text={formatPrice(market.price)} order={Number(market.price)} />
          ) : (
            "—"
          )}
        </span>
        {status.open ? null : <Badge variant="warning">Closed</Badge>}
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4 xl:flex xl:flex-1 xl:gap-8">
        <Stat
          label="Oracle (OutLayer)"
          hint={
            <span className={cn(!fresh && "text-warning")}>
              {market.price_timestamp_ms ? `updated ${formatAge(market.price_timestamp_ms, nowMs)}` : "no price yet"}
            </span>
          }
        >
          {market.price > 0n ? formatPrice(market.price) : "—"}
        </Stat>
        <Stat
          label={
            <span
              title="Open interest: total size of open positions"
              className="underline decoration-dotted decoration-tertiary underline-offset-4"
            >
              Open interest
            </span>
          }
          hint="total size of open positions"
        >
          <span className="text-success">{formatUsd(market.oi_long, { maxFractionDigits: 0 })}</span>
          <span className="text-tertiary"> / </span>
          <span className="text-destructive">{formatUsd(market.oi_short, { maxFractionDigits: 0 })}</span>
        </Stat>
        <Stat label="Max open interest per side" hint="set by live exit liquidity">
          <span data-testid="max-oi">{formatUsd(market.max_oi_per_side, { maxFractionDigits: 0 })}</span>
        </Stat>
        <Stat
          label="Max leverage"
          hint={status.open ? `from ${formatUsd(market.exit_capacity, { maxFractionDigits: 0 })} exit capacity` : status.label}
        >
          <span data-testid="max-leverage">{market.max_leverage}×</span>
        </Stat>
      </dl>
      {aside ? <div className="hidden xl:block">{aside}</div> : null}
    </section>
  );
}
