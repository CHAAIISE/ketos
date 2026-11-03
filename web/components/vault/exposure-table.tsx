"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { ErrorState, Skeleton } from "@/components/app/states";
import { STALE_AFTER_MS, formatAge, formatUtc, useNow } from "@/components/landing/live-time";
import { Badge } from "@/components/ui/badge";
import { networkName } from "@/lib/near/config";
import { formatUsd } from "@/lib/near/format";
import { MARKET_IDS, type Market } from "@/lib/near/types";
import { cn } from "@/lib/utils";
import { Term } from "./term";

const COLUMNS = ["Long OI", "Short OI", "Net", "Exit capacity", "Max OI per side", "Net / capacity"] as const;

const usd0 = (units: bigint) => formatUsd(units, { maxFractionDigits: 0 });

function NetCell({ net }: { net: bigint }) {
  if (net === 0n) return <span className="text-tertiary">$0</span>;
  return net > 0n ? (
    <span className="text-success">{usd0(net)} long</span>
  ) : (
    <span className="text-destructive">{usd0(-net)} short</span>
  );
}

/** |net| as a share of the measured exit capacity. */
function UsageBar({ net, capacity }: { net: bigint; capacity: bigint }) {
  if (capacity === 0n) return <span className="text-warning">no capacity</span>;
  const abs = net < 0n ? -net : net;
  const pct = Number((abs * 10_000n) / capacity) / 100;
  const tone = pct >= 100 ? "bg-destructive" : pct >= 80 ? "bg-warning" : "bg-foreground";
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span aria-hidden className="flex h-1.5 w-16 overflow-hidden rounded-pill bg-muted">
        <span className={cn("h-full", tone)} style={{ width: `${Math.min(pct, 100)}%` }} />
      </span>
      <span className="w-12 text-right">{pct.toFixed(1)}%</span>
    </span>
  );
}

function MeasuredAt({ markets }: { markets: Market[] }) {
  const nowMs = useNow();
  const oldest = Math.min(...markets.map((m) => m.depth_measured_at_ms));
  if (!oldest) return <span className="text-label text-tertiary">Exit capacity not measured yet</span>;
  const stale = nowMs > 0 && nowMs - oldest > STALE_AFTER_MS;
  const age = formatAge(oldest, nowMs);
  return (
    <span className={cn("text-label tabular-nums", stale ? "text-warning" : "text-tertiary")}>
      Exit capacity measured {formatUtc(oldest)}
      {age ? ` · ${age}` : null}
      {stale ? " · older than 30 min, new positions paused" : null}
    </span>
  );
}

export function ExposureTable({ query, className }: { query: UseQueryResult<Market[]>; className?: string }) {
  const panel = cn("flex min-w-0 flex-col rounded-lg border border-border bg-card", className);
  const markets = query.data
    ? [...query.data].sort((a, b) => MARKET_IDS.indexOf(a.id) - MARKET_IDS.indexOf(b.id))
    : null;

  return (
    <section aria-labelledby="exposure-title" className={panel}>
      <div className="flex flex-col gap-1 p-4 pb-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id="exposure-title" className="text-sm font-medium text-foreground">
            Net exposure vs exit capacity
          </h2>
          {markets?.length ? <MeasuredAt markets={markets} /> : null}
        </div>
        <p className="text-ui text-muted-foreground">
          Open interest (total size of open positions) on each side. The vault holds the opposite of the net: when
          traders are net long, the vault is short, and it can only hedge or unwind what NEAR Intents can absorb.
        </p>
      </div>
      {query.isError && !markets ? (
        <div className="px-4 pb-4">
          <ErrorState title={`Could not read the markets from ${networkName()}.`} error={query.error} onRetry={() => void query.refetch()} />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-176 text-ui tabular-nums">
            <thead className="bg-muted text-label text-tertiary">
              <tr>
                <th scope="col" className="h-8 px-4 text-left font-medium">
                  Market
                </th>
                {COLUMNS.map((label) => (
                  <th key={label} scope="col" className="h-8 px-4 text-right font-medium whitespace-nowrap">
                    {label === "Net" ? (
                      <Term hint="Long open interest minus short open interest.">Net</Term>
                    ) : label === "Max OI per side" ? (
                      <Term hint="Open-interest cap of each side: the lower of the measured exit capacity and the market's hard cap.">
                        {label}
                      </Term>
                    ) : (
                      label
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {markets
                ? markets.map((m) => (
                    <tr key={m.id} className="h-row border-t border-border">
                      <th scope="row" className="px-4 text-left font-medium text-foreground">
                        <span className="inline-flex items-center gap-2">
                          {m.id}
                          {m.is_open ? null : <Badge variant="warning">paused</Badge>}
                        </span>
                      </th>
                      <td className="px-4 text-right text-foreground">{usd0(m.oi_long)}</td>
                      <td className="px-4 text-right text-foreground">{usd0(m.oi_short)}</td>
                      <td className="px-4 text-right">
                        <NetCell net={m.oi_long - m.oi_short} />
                      </td>
                      <td className="px-4 text-right text-foreground">{usd0(m.exit_capacity)}</td>
                      <td className="px-4 text-right text-muted-foreground">{usd0(m.max_oi_per_side)}</td>
                      <td className="px-4 text-right text-muted-foreground">
                        <UsageBar net={m.oi_long - m.oi_short} capacity={m.exit_capacity} />
                      </td>
                    </tr>
                  ))
                : MARKET_IDS.map((id) => (
                    <tr key={id} className="h-row border-t border-border">
                      <td colSpan={COLUMNS.length + 1} className="px-4">
                        <Skeleton className="h-4 w-full" />
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
