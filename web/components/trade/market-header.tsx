"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Popover } from "@base-ui/react/popover";
import { ChevronDown } from "lucide-react";
import { FlashValue } from "@/components/landing/flash-value";
import { formatAge, formatUtc, useNow, useSecondClock } from "@/components/landing/live-time";
import { Term } from "@/components/vault/term";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useCandles } from "@/hooks/use-candles";
import { formatFundingRate, formatPrice, usd0 } from "@/lib/near/format";
import { isMeasuring, type Market, type MarketId } from "@/lib/near/types";
import { CANDLE_SOURCE, change24h } from "@/lib/prices/candles";
import { cn } from "@/lib/utils";
import { formatExitCapacity, isPriceFresh, marketDisplayStatus, marketLimitLabel, marketStatus } from "@/lib/near/market-status";

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
function Volume24h({ market }: { market: MarketId }) {
  const candles = useCandles(market, "5m");
  const rows = candles.data?.candles;
  const end = rows?.at(-1)?.time;
  const volume = rows && end !== undefined && change24h(rows)
    ? rows.filter((row) => row.time > end - 86_400).reduce((sum, row) => sum + row.volume * row.close, 0)
    : null;
  return <span title={candles.data ? `${CANDLE_SOURCE} spot estimate, fetched ${formatUtc(candles.data.fetchedAtMs, true)}` : undefined}>
    {volume === null ? candles.isError ? "Unavailable" : "—" : `≈ $${volume.toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
  </span>;
}

/** Time left in the current UTC hour as "mm:ss"; null while hydrating. */
function useHourCountdown(): string | null {
  const clock = useSecondClock();
  if (clock === null) return null;
  const left = 3_600 - ((clock / 1_000) % 3_600);
  return `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`;
}

/** Signed hourly funding rate of the market and the time left in the hour it is quoted for. */
function FundingStat({ market }: { market: Market }) {
  const countdown = useHourCountdown();
  const rate = market.funding_rate_per_hour;
  return (
    <Stat
      label={
        <Term hint="Hourly cash flow per side: negative pays, positive receives. The majority pays the minority, with unmatched funding going to the vault; capped at 0.05% per hour. Countdown to the next UTC hour.">
          Funding / 1h
        </Term>
      }
    >
      <span data-testid="funding-rate">
        <span className={rate > 0n ? "text-destructive" : rate < 0n ? "text-success" : undefined}>L {formatFundingRate(-rate)}</span>
        <span className="text-tertiary"> / </span>
        <span className={rate < 0n ? "text-destructive" : rate > 0n ? "text-success" : undefined}>S {formatFundingRate(rate)}</span>
      </span>
      <span className="text-tertiary"> · </span>
      <span data-testid="funding-countdown">{countdown ?? "—"}</span>
    </Stat>
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
  const [query, setQuery] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const nowMs = useNow();
  const needle = query.trim().toUpperCase();
  const shown = needle ? markets.filter((m) => m.id.includes(needle)) : markets;
  const closedCount = shown.filter((m) => !marketStatus(m, nowMs).open).length;
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
          <Popover.Popup className="z-50 flex max-h-[min(30rem,70vh)] w-[30rem] max-w-[calc(100vw-1rem)] flex-col rounded-lg border border-border bg-popover outline-none">
            <div className="border-b border-border p-2">
              <Input
                type="search"
                autoFocus
                aria-label="Search markets"
                placeholder="Search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-7 text-ui"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
            <table className="w-full text-label">
              <thead className="sticky top-0 bg-popover text-tertiary">
                <tr className="h-8 border-b border-border">
                  <th scope="col" className="px-3 text-left font-normal">Market</th>
                  <th scope="col" className="px-3 text-right font-normal">Mark</th>
                  <th scope="col" className="px-3 text-right font-normal">Effective cap</th>
                  <th scope="col" className="px-3 text-right font-normal">Max Leverage</th>
                </tr>
              </thead>
              <tbody role="listbox" aria-label="Markets">
                {shown.filter((m) => showClosed || marketStatus(m, nowMs).open).map((m) => (
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
                        {isMeasuring(m) ? <Badge variant="warning">Measuring</Badge> : null}
                        {!marketStatus(m, nowMs).open ? <Badge variant="warning">Closed</Badge> : null}
                      </span>
                    </td>
                    <td className="px-3 text-right tabular-nums">{m.price > 0n ? formatPrice(m.price) : "—"}</td>
                    <td className="px-3 text-right tabular-nums" title={marketLimitLabel(m)}>{usd0(m.effective_max_oi_per_side)}</td>
                    <td className="px-3 text-right tabular-nums">{m.max_leverage}×</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {closedCount > 0 ? (
              <button type="button" aria-expanded={showClosed} onClick={() => setShowClosed((value) => !value)} className="w-full border-t border-border px-3 py-2 text-left text-label text-warning hover:bg-muted">
                {showClosed ? "Hide" : "Show"} thin / closed markets ({closedCount})
              </button>
            ) : null}
            {shown.length === 0 ? <p className="px-3 py-4 text-ui text-muted-foreground">No market matches “{query.trim()}”.</p> : null}
            </div>
            <Link
              href="/markets"
              onClick={() => setOpen(false)}
              className="border-t border-border px-3 py-2 text-label text-tertiary transition-colors hover:text-foreground"
            >
              All markets, funding and listing →
            </Link>
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
  const status = marketDisplayStatus(market, nowMs);
  const fresh = isPriceFresh(market, nowMs);
  const measured = market.depth_measured_at_ms;

  return (
    <section
      aria-label={`${marketName(market.id)} market`}
      className={cn(
        "flex min-w-0 items-center gap-4 rounded-lg border border-border bg-card px-3 py-3",
        className,
      )}
    >
      <h1 className="sr-only">Trade {marketName(market.id)}</h1>
      <div className="flex shrink-0 items-center gap-3">
        <MarketSelector markets={markets} market={market} onSelect={onSelect} />
      </div>

      <dl className="flex min-w-0 flex-1 items-center gap-5 overflow-x-auto py-1">
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
                  ? `Stored price at ${formatUtc(market.price_timestamp_ms, true)}. New entries fetch a fresh price and require it to be no older than 30 seconds.`
                  : "No stored oracle price yet; an action requests a fresh price."
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
        <Stat label={<Term hint={`${CANDLE_SOURCE} underlying spot volume, estimated from each 5-minute candle's base volume × close over the last 24 hours. Not Ketos trading volume.`}>24h Volume</Term>}>
          <Volume24h market={market.id} />
        </Stat>
        <FundingStat market={market} />
        <Stat
          label={<Term hint="Total size of open positions on this market: longs / shorts.">Open Interest</Term>}
        >
          <span className="text-success">L {usd0(market.oi_long)}</span>
          <span className="text-tertiary"> / </span>
          <span className="text-destructive">S {usd0(market.oi_short)}</span>
        </Stat>
        <Stat
          label={
            <Term
              hint={
                measured
                  ? `Effective open-interest cap per side: minimum of exit liquidity, protocol hard cap and available vault backing. Admitted exit ${formatExitCapacity(market)}${market.measured_cap_is_grid_max ? "; probe grid passed, but admission depth may be ramp-limited (see curve for largest size probed)" : ""} at ${formatUtc(measured)}. Hard cap ${usd0(market.hard_cap)}.`
                  : "New positions wait for the first exit-liquidity measurement and available vault capital."
              }
            >
              Max OI
            </Term>
          }
        >
          <span data-testid="max-oi" title={marketLimitLabel(market)}>{usd0(market.effective_max_oi_per_side)}</span>
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
        <Stat label={marketLimitLabel(market)}>
          {status.open ? <Badge variant="success">Open</Badge> : (
            <span title={status.label}><Badge variant="warning">{status.reason === "price" ? status.label : status.reason === "stale" ? "Stale depth" : "Closed"}</Badge></span>
          )}
        </Stat>
      </dl>
    </section>
  );
}
