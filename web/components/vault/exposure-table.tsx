"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import Link from "next/link";
import { ErrorState, Skeleton } from "@/components/app/states";
import { STALE_AFTER_MS, formatAge, formatUtc, useNow } from "@/components/landing/live-time";
import { Badge } from "@/components/ui/badge";
import { networkName } from "@/lib/near/config";
import { usd0 } from "@/lib/near/format";
import { isMeasuring, type Market, type VaultId } from "@/lib/near/types";
import { cn } from "@/lib/utils";
import { PanelHeading } from "./panel-heading";
import { Term } from "./term";

const COLUMNS = ["Long OI", "Short OI", "Net", "Exit capacity", "Max OI per side", "Net / capacity"] as const;

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
  const measured = markets.map((m) => m.depth_measured_at_ms).filter((ms) => ms > 0);
  if (!measured.length) return <span className="text-label text-tertiary">Exit capacity not measured yet</span>;
  const oldest = Math.min(...measured);
  const waiting = markets.length - measured.length;
  const stale = nowMs > 0 && nowMs - oldest > STALE_AFTER_MS;
  const age = formatAge(oldest, nowMs);
  return (
    <span className={cn("text-label tabular-nums", stale ? "text-warning" : "text-tertiary")}>
      Exit capacity measured {formatUtc(oldest)}
      {age ? ` · ${age}` : null}
      {stale ? " · older than 30 min, new positions paused" : null}
      {waiting ? ` · ${waiting} awaiting first measurement` : null}
    </span>
  );
}

export function ExposureTable({ query, vaultId, className }: { query: UseQueryResult<Market[]>; vaultId: VaultId; className?: string }) {
  const panel = cn("flex min-w-0 flex-col rounded-md border border-border bg-card", className);
  const markets = query.data?.filter((market) => market.vault_id === vaultId);

  return (
    <section aria-labelledby="exposure-title" className={panel}>
      <PanelHeading id="exposure-title" aside={markets?.length ? <MeasuredAt markets={markets} /> : null}>
        Net exposure vs exit capacity
      </PanelHeading>
      <p className="px-3 pt-2 pb-1 text-label text-tertiary">
        Open interest (total size of open positions) on each side. The vault holds the opposite of traders&apos; net exposure.
        Exit capacity is a measured market limit, not a hedge held by the vault.
      </p>
      {query.isError && !markets ? (
        <div className="p-3">
          <ErrorState title={`Could not read the markets from ${networkName()}.`} error={query.error} onRetry={() => void query.refetch()} />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-176 text-ui tabular-nums">
            <thead className="text-label text-tertiary">
              <tr>
                <th scope="col" className="h-8 px-3 text-left font-normal">
                  Market
                </th>
                {COLUMNS.map((label) => (
                  <th key={label} scope="col" className="h-8 px-3 text-right font-normal whitespace-nowrap">
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
                    <tr key={m.id} className="h-8 hover:bg-muted/40">
                      <th scope="row" className="px-3 text-left font-medium text-foreground">
                        <span className="inline-flex items-center gap-2">
                          <Link href={`/trade?market=${m.id}`} className="hover:underline">{m.id}</Link>
                          {isMeasuring(m) ? (
                            <Badge variant="warning">Measuring</Badge>
                          ) : m.is_open ? null : (
                            <Badge>Paused</Badge>
                          )}
                        </span>
                      </th>
                      <td className="px-3 text-right text-foreground">{usd0(m.oi_long)}</td>
                      <td className="px-3 text-right text-foreground">{usd0(m.oi_short)}</td>
                      <td className="px-3 text-right">
                        <NetCell net={m.oi_long - m.oi_short} />
                      </td>
                      <td className="px-3 text-right text-foreground">{isMeasuring(m) ? "—" : usd0(m.exit_capacity)}</td>
                      <td className="px-3 text-right text-muted-foreground">{isMeasuring(m) ? "—" : usd0(m.max_oi_per_side)}</td>
                      <td className="px-3 text-right text-muted-foreground">
                        {isMeasuring(m) ? <span className="text-tertiary">awaiting measurement</span> : <UsageBar net={m.oi_long - m.oi_short} capacity={m.exit_capacity} />}
                      </td>
                    </tr>
                  ))
                : Array.from({ length: 4 }, (_, i) => (
                    <tr key={i} className="h-8">
                      <td colSpan={COLUMNS.length + 1} className="px-3">
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
