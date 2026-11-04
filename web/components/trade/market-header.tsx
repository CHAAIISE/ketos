"use client";

import { useState, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { ChevronDown } from "lucide-react";
import { FlashValue } from "@/components/landing/flash-value";
import { formatAge, formatUtc, useNow } from "@/components/landing/live-time";
import { Term } from "@/components/vault/term";
import { Badge } from "@/components/ui/badge";
import { useCandles } from "@/hooks/use-candles";
import { formatPrice, formatUsd } from "@/lib/near/format";
import type { Market, MarketId } from "@/lib/near/types";
import { CANDLE_SOURCE, change24h } from "@/lib/prices/candles";
import { cn } from "@/lib/utils";
import { isPriceFresh, marketStatus } from "./market-status";

const usd0 = (units: bigint) => formatUsd(units, { maxFractionDigits: 0 });

export const marketName = (id: MarketId) => `${id}-USD`;

function Stat({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex shrink-0 flex-col gap-0.5", className)}>
      <dt className="text-label text-tertiary">{label}</dt>
      <dd className="text-label font-medium whitespace-nowrap text-foreground tabular-nums">{children}</dd>
    </div>
  );
}

/** Coinbase 24h move of the underlying, from 5-minute candles. */
function Change24h({ market }: { market: MarketId }) {
  const candles = useCandles(market, "5m");
  const change = candles.data ? change24h(candles.data.candles) : null;
  if (!change) return <span className="text-tertiary">{candles.isError ? "Unavailable" : "—"}</span>;
  const up = change.absolute >= 0;
  const digits = Math.abs(change.absolute) >= 100 ? 0 : Math.abs(change.absolute) >= 1 ? 2 : 4;
  return (
    <span className={up ? "text-success" : "text-destructive"} data-testid="change-24h">
      {up ? "+" : "−"}
      {Math.abs(change.absolute).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })} /{" "}
      {up ? "+" : "−"}
      {Math.abs(change.percent).toFixed(2)}%
    </span>
  );
}

function MarketSelector({
  markets,
  market,
  onSelect,
}: {
  markets: readonly Market[];
  market: Market;
  onSelect: (id: MarketId) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        data-testid="market-selector"
        aria-label={`Market ${marketName(market.id)}, change market`}
        className="flex shrink-0 items-center gap-2 rounded-md px-1 py-1 text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="text-xl font-medium tracking-tight">{marketName(market.id)}</span>
        <ChevronDown aria-hidden className="size-4 text-tertiary" />
        <Badge variant="success" className="ml-1">
          {market.max_leverage}x
        </Badge>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} className="z-50">
          <Popover.Popup className="z-50 w-[30rem] max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-popover outline-none">
            <table className="w-full text-label">
              <thead className="text-tertiary">
                <tr className="h-8 border-b border-border">
                  <th scope="col" className="px-3 text-left font-normal">Market</th>
                  <th scope="col" className="px-3 text-right font-normal">Mark</th>
                  <th scope="col" className="px-3 text-right font-normal">Max OI</th>
                  <th scope="col" className="px-3 text-right font-normal">Max Leverage</th>
                </tr>
              </thead>
              <tbody role="listbox" aria-label="Markets">
                {markets.map((m) => (
                  <tr
                    key={m.id}
                    role="option"
                    tabIndex={0}
                    aria-selected={m.id === market.id}
                    data-testid={`market-tab-${m.id}`}
                    onClick={() => {
                      onSelect(m.id);
                      setOpen(false);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(m.id);
                        setOpen(false);
                      }
                    }}
                    className="h-9 cursor-pointer text-foreground outline-none hover:bg-muted focus-visible:bg-muted aria-selected:bg-muted/60"
                  >
                    <td className="px-3">
                      <span className="flex items-center gap-2">
                        {marketName(m.id)}
                        <Badge variant="success">{m.max_leverage}x</Badge>
                      </span>
                    </td>
                    <td className="px-3 text-right tabular-nums">{m.price > 0n ? formatPrice(m.price) : "—"}</td>
                    <td className="px-3 text-right tabular-nums">{usd0(m.max_oi_per_side)}</td>
                    <td className="px-3 text-right tabular-nums">{m.max_leverage}×</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Market selector and the live numbers of the selected market, in one row. */
export function MarketHeader({
  markets,
  market,
  onSelect,
  className,
}: {
  markets: readonly Market[];
  market: Market;
  onSelect: (id: MarketId) => void;
  className?: string;
}) {
  const nowMs = useNow();
  const status = marketStatus(market, nowMs);
  const fresh = isPriceFresh(market, nowMs);
  const measured = market.depth_measured_at_ms;

  return (
    <section
      aria-label={`${marketName(market.id)} market`}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-md border border-border bg-card px-3 py-2 md:flex-row md:items-center md:gap-6",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <MarketSelector markets={markets} market={market} onSelect={onSelect} />
        <span className="text-lg font-medium tabular-nums text-foreground md:hidden">
          {market.price > 0n ? formatPrice(market.price) : "—"}
        </span>
      </div>

      <dl className="flex min-w-0 items-center gap-6 overflow-x-auto [scrollbar-width:none]">
        <Stat
          label={
            <Term hint="Price open positions are marked and liquidated at: the onchain oracle price.">Mark</Term>
          }
        >
          <span data-testid="mark-price">
            {market.price > 0n ? <FlashValue text={formatPrice(market.price)} order={Number(market.price)} /> : "—"}
          </span>
        </Stat>
        <Stat
          label={
            <Term
              hint={
                market.price_timestamp_ms
                  ? `Oracle price pushed onchain at ${formatUtc(market.price_timestamp_ms, true)}. Orders are refused when it is older than 2 minutes.`
                  : "No oracle price yet."
              }
            >
              Oracle
            </Term>
          }
        >
          <span className={cn(!fresh && "text-warning")}>
            {market.price_timestamp_ms ? formatAge(market.price_timestamp_ms, nowMs) || formatUtc(market.price_timestamp_ms) : "No price yet"}
          </span>
        </Stat>
        <Stat
          label={<Term hint={`${CANDLE_SOURCE} ${marketName(market.id)} spot, last 24 hours (5-minute candles).`}>24h Change</Term>}
        >
          <Change24h market={market.id} />
        </Stat>
        <Stat
          label={<Term hint="Total size of open positions on this market: longs / shorts.">Open Interest</Term>}
        >
          <span className="text-success">{usd0(market.oi_long)}</span>
          <span className="text-tertiary"> / </span>
          <span className="text-destructive">{usd0(market.oi_short)}</span>
        </Stat>
        <Stat
          label={
            <Term
              hint={
                measured
                  ? `Max open interest per side, set by live exit liquidity: NEAR Intents could sell ${usd0(market.exit_capacity)} of ${market.id} within 1% price impact at ${formatUtc(measured)}. Hard cap ${usd0(market.hard_cap)}.`
                  : "Set by live exit liquidity once the first NEAR Intents measurement lands."
              }
            >
              Max OI
            </Term>
          }
        >
          <span data-testid="max-oi">{usd0(market.max_oi_per_side)}</span>
        </Stat>
        <Stat
          label={
            <Term hint="Highest leverage allowed today, derived from the same exit-liquidity measurement.">
              Max Leverage
            </Term>
          }
        >
          <span data-testid="max-leverage">{market.max_leverage}×</span>
        </Stat>
        {status.open ? null : (
          <Stat label="Status">
            <Badge variant="warning">{status.label}</Badge>
          </Stat>
        )}
      </dl>
    </section>
  );
}
