"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import Link from "next/link";
import { ErrorState, Skeleton } from "@/components/app/states";
import { STALE_AFTER_MS, formatAge, formatUtc, useNow } from "@/components/landing/live-time";
import { Badge } from "@/components/ui/badge";
import { networkName } from "@/lib/near/config";
import { usd0 } from "@/lib/near/format";
import { formatExitCapacity, marketDisplayStatus, marketLimitLabel } from "@/lib/near/market-status";
import { isMeasuring, type Market, type VaultId } from "@/lib/near/types";
import { cn } from "@/lib/utils";
import { PanelHeading } from "./panel-heading";
import { Term } from "./term";

const COLUMNS = ["Long OI", "Short OI", "Net", "Exit depth", "Effective cap per side", "Net / exit depth"] as const;

function NetCell({ net }: { net: bigint }) {
  if (net === 0n) return <span className="text-tertiary">$0</span>;
  return net > 0n ? (
    <span className="text-success">{usd0(net)} long</span>
  ) : (
    <span className="text-destructive">{usd0(-net)} short</span>
  );
}

/** |net| as a share of the measured exit capacity. */
function UsageBar({ net, capacity, lowerBound }: { net: bigint; capacity: bigint; lowerBound: boolean }) {
  if (capacity === 0n) return <span className="text-warning">no capacity</span>;
  const abs = net < 0n ? -net : net;
  const pct = Number((abs * 10_000n) / capacity) / 100;
  const tone = pct >= 100 ? "bg-destructive" : pct >= 80 ? "bg-warning" : "bg-foreground";
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span aria-hidden className="flex h-1.5 w-16 overflow-hidden rounded-pill bg-muted">
        <span className={cn("h-full", tone)} style={{ width: `${Math.min(pct, 100)}%` }} />
      </span>
      <span className="min-w-12 text-right">{lowerBound ? "≤ " : ""}{pct.toFixed(1)}%</span>
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
      Oldest depth in this vault: {formatUtc(oldest)}
      {age ? ` · ${age}` : null}
      {stale ? ` · ${markets.filter((m) => m.depth_measured_at_ms > 0 && nowMs - m.depth_measured_at_ms > STALE_AFTER_MS).length} stale markets` : null}
      {waiting ? ` · ${waiting} awaiting first measurement` : null}
    </span>
  );
}

export function ExposureTable({ query, vaultId, className }: { query: UseQueryResult<Market[]>; vaultId: VaultId; className?: string }) {
  const panel = cn("flex min-w-0 flex-col rounded-md border border-border bg-card", className);
  const markets = query.data?.filter((market) => market.vault_id === vaultId);
  const nowMs = useNow();

  return (
    <section aria-labelledby="exposure-title" className={panel}>
      <PanelHeading id="exposure-title" aside={markets?.length ? <MeasuredAt markets={markets} /> : null}>
        Net exposure vs exit capacity
      </PanelHeading>
      <p className="px-3 pt-2 pb-1 text-label text-tertiary">
        Open interest (total size of open positions) on each side. The vault holds the opposite of traders&apos; net exposure.
        Exit depth is admitted from measurements and may be ramp-limited, not a hedge held by the vault. The effective cap also accounts for protocol limits and vault backing. Ratios marked ≤ use the admitted lower bound.
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
                    ) : label === "Effective cap per side" ? (
                      <Term hint="The lowest of measured exit liquidity, the protocol limit and vault-backed capacity. Applies separately to long and short open interest.">
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
                ? markets.map((m) => {
                  const status = marketDisplayStatus(m, nowMs);
                  return (
                    <tr key={m.id} className="h-8 hover:bg-muted/40">
                      <th scope="row" className="px-3 text-left font-medium text-foreground">
                        <span className="inline-flex items-center gap-2">
                          <Link href={`/trade?market=${m.id}`} className="hover:underline">{m.id}</Link>
                          {!status.open ? (
                            <Term hint={status.reason === "price" ? `${status.label}. Actions pull a fresh execution price.` : status.label}>
                              <Badge variant={status.reason === "thin" ? "warning" : "default"}>
                                {status.reason === "no-depth" ? "Measuring" : status.reason === "thin" ? "Thin" : status.reason === "price" ? "Price refresh" : status.reason === "capital" ? "Vault-limited" : "Stale depth"}
                              </Badge>
                            </Term>
                          ) : null}
                        </span>
                      </th>
                      <td className="px-3 text-right text-foreground">{usd0(m.oi_long)}</td>
                      <td className="px-3 text-right text-foreground">{usd0(m.oi_short)}</td>
                      <td className="px-3 text-right">
                        <NetCell net={m.oi_long - m.oi_short} />
                      </td>
                      <td className="px-3 py-2 text-right text-foreground">
                        {isMeasuring(m) ? "—" : <Term hint={`${m.id} depth measured ${formatUtc(m.depth_measured_at_ms, true)} · ${formatAge(m.depth_measured_at_ms, nowMs)}.${m.measured_cap_is_grid_max ? " Probe grid passed; admission depth may be ramp-limited. See the curve for the largest size probed." : " Admission depth may be ramp-limited."}`}>{formatExitCapacity(m)}</Term>}
                      </td>
                      <td className="px-3 py-2 text-right text-muted-foreground">
                        <span className="block">{usd0(m.effective_max_oi_per_side)}</span>
                        <span className="block text-label text-tertiary">{marketLimitLabel(m)}</span>
                      </td>
                      <td className="px-3 text-right text-muted-foreground">
                        {isMeasuring(m) ? <span className="text-tertiary">awaiting measurement</span> : <UsageBar net={m.oi_long - m.oi_short} capacity={m.exit_capacity} lowerBound={m.measured_cap_is_grid_max} />}
                      </td>
                    </tr>
                  );
                })
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
