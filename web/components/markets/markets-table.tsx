"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Star } from "lucide-react";
import { marketName } from "@/components/trade/market-header";
import { formatExitCapacity, isPriceFresh, marketDisplayStatus, marketLimitLabel } from "@/lib/near/market-status";
import { OiBar } from "@/components/trade/oi-bar";
import { Term } from "@/components/vault/term";
import { Badge } from "@/components/ui/badge";
import { formatFundingRate, formatPrice, usd0 } from "@/lib/near/format";
import type { Market, VaultId } from "@/lib/near/types";
import type { Change24h } from "@/lib/prices/market-stats";
import { cn } from "@/lib/utils";

export type SortKey = "coin" | "price" | "change" | "funding" | "oi" | "leverage";
export interface Sort {
  key: SortKey;
  dir: "asc" | "desc";
}

export const VAULT_LABEL: Record<VaultId, string> = { core: "Core", "long-tail": "Long-tail" };

/**
 * Rows in display order; markets without a value for the sort key always go last. Ties go to the
 * larger effective cap within each open/closed group.
 */
export function sortMarkets(
  markets: readonly Market[],
  sort: Sort,
  changes: Record<string, Change24h | null> | undefined,
): Market[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const value = (m: Market): number | bigint | string | null => {
    switch (sort.key) {
      case "coin":
        return m.id;
      case "price":
        return m.price > 0n ? m.price : null;
      case "change":
        return changes?.[m.id]?.percent ?? null;
      case "funding":
        return m.funding_rate_per_hour;
      case "oi":
        return m.oi_long + m.oi_short;
      case "leverage":
        return m.max_leverage;
    }
  };
  const tieBreak = (a: Market, b: Market) =>
    a.effective_max_oi_per_side === b.effective_max_oi_per_side
      ? a.id.localeCompare(b.id)
      : a.effective_max_oi_per_side > b.effective_max_oi_per_side
        ? -1
        : 1;
  return [...markets].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null || vb === null) return va === vb ? tieBreak(a, b) : va === null ? 1 : -1;
    const c =
      typeof va === "bigint" && typeof vb === "bigint"
        ? (va > vb ? 1 : 0) - (va < vb ? 1 : 0)
        : typeof va === "string" && typeof vb === "string"
          ? va.localeCompare(vb)
          : Number(va) - Number(vb);
    return c === 0 ? tieBreak(a, b) : c * sign;
  });
}

export function SortHeader<K extends string>({
  label,
  sortKey,
  sort,
  onSort,
  align = "right",
}: {
  label: ReactNode;
  sortKey: K;
  sort: { key: K; dir: "asc" | "desc" };
  onSort: (key: K) => void;
  align?: "left" | "right";
}) {
  const active = sort.key === sortKey;
  const Icon = sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
      className={cn("h-8 px-3 font-normal whitespace-nowrap", align === "right" ? "text-right" : "text-left")}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 rounded-sm transition-colors outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
          active && "text-foreground",
        )}
      >
        {label}
        <Icon aria-hidden strokeWidth={1.5} className={cn("size-3", active ? "opacity-100" : "opacity-0")} />
      </button>
    </th>
  );
}

function ChangeCell({ change, loading }: { change: Change24h | null | undefined; loading: boolean }) {
  if (!change) return <span className="text-tertiary">{loading ? "…" : "—"}</span>;
  const up = change.percent >= 0;
  return (
    <span className={up ? "text-success" : "text-destructive"}>
      {up ? "+" : "−"}
      {Math.abs(change.percent).toFixed(2)}%
    </span>
  );
}

function StatusCell({ market, nowMs }: { market: Market; nowMs: number }) {
  const status = marketDisplayStatus(market, nowMs);
  if (status.open) {
    return <Badge variant="success" data-testid={`market-status-${market.id}`}>Open</Badge>;
  }
  const label = status.reason === "no-depth" ? "Measuring"
    : status.reason === "thin" ? "Thin liquidity"
      : status.reason === "price" ? "Price refresh needed"
        : status.reason === "capital" ? "Vault-limited"
          : "Stale depth";
  return (
    <Term hint={status.reason === "price" ? `${status.label}. The displayed mark is not current; entries request a fresh price. Closing supports the contract's conservative stale-price fallback.` : `${status.label}. New positions are unavailable. Existing positions can still be closed, subject to the contract's price and payout rules.`}>
      <Badge variant={status.reason === "thin" ? "warning" : "default"} data-testid={`market-status-${market.id}`}>{label}</Badge>
    </Term>
  );
}

export function MarketsTable({
  markets,
  nowMs,
  tableTestId = "markets-table",
  sort,
  onSort,
  changes,
  changesLoading,
  favorites,
  onToggleFavorite,
}: {
  markets: readonly Market[];
  nowMs: number;
  tableTestId?: string;
  sort: Sort;
  onSort: (key: SortKey) => void;
  changes: Record<string, Change24h | null> | undefined;
  changesLoading: boolean;
  favorites: readonly string[];
  onToggleFavorite: (id: string) => void;
}) {
  const router = useRouter();
  const header = { sort, onSort };

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table data-testid={tableTestId} className="w-full min-w-232 text-ui tabular-nums">
        <thead className="sticky top-0 z-10 bg-card text-label text-tertiary">
          <tr className="border-b border-border">
            <SortHeader label="Coin" sortKey="coin" align="left" {...header} />
            <SortHeader label="Price" sortKey="price" {...header} />
            <SortHeader
              label={<Term hint="Change of the coin's USD spot price on Coinbase over the last 24 hours.">24h Change</Term>}
              sortKey="change"
              {...header}
            />
            <SortHeader
              label={
                <Term hint="Hourly rate paid by the larger side of open interest to the smaller one. Positive: longs pay shorts.">
                  Funding / h
                </Term>
              }
              sortKey="funding"
              {...header}
            />
            <SortHeader
              label={
                <Term hint="Open interest is the total size of open positions, longs + shorts. The effective cap applies separately to each side and is the lowest of measured exit liquidity, the protocol limit and vault backing.">
                  Open Interest / Effective Cap
                </Term>
              }
              sortKey="oi"
              {...header}
            />
            <th scope="col" className="h-8 px-3 text-right font-normal">
              <Term hint="Depth admitted from the latest exit-liquidity measurement; increases may be ramp-limited. ≥ means the probe grid passed, not that this admitted value is the largest size probed.">Exit depth</Term>
            </th>
            <SortHeader label="Max Leverage" sortKey="leverage" {...header} />
            <th scope="col" className="h-8 px-3 text-left font-normal">
              <Term hint="The LP vault that takes the other side of this market's traders.">Vault</Term>
            </th>
          </tr>
        </thead>
        <tbody>
          {markets.map((m) => {
            const favorite = favorites.includes(m.id);
            const href = `/trade?market=${encodeURIComponent(m.id)}`;
            const maxSide = m.oi_long > m.oi_short ? m.oi_long : m.oi_short;
            return (
              <tr
                key={m.id}
                data-testid={`market-row-${m.id}`}
                onClick={() => router.push(href)}
                className="h-row cursor-pointer border-b border-border/60 transition-colors last:border-b-0 hover:bg-muted"
              >
                <td className="px-3">
                  <span className="flex items-center gap-2">
                    <button
                      type="button"
                      aria-pressed={favorite}
                      aria-label={favorite ? `Remove ${m.id} from favorites` : `Add ${m.id} to favorites`}
                      data-testid={`favorite-${m.id}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggleFavorite(m.id);
                      }}
                      className="-m-1 rounded-sm p-1 text-tertiary transition-colors outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring aria-pressed:text-warning"
                    >
                      <Star aria-hidden strokeWidth={1.5} className={cn("size-3.5", favorite && "fill-current")} />
                    </button>
                    <span className="flex flex-col items-start gap-1 py-2">
                      <Link
                        href={href}
                        onClick={(event) => event.stopPropagation()}
                        className="rounded-sm font-medium whitespace-nowrap text-foreground outline-none focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        {marketName(m.id)}
                        <span aria-hidden className={cn("ml-1.5 inline-block size-1.5 rounded-pill align-middle sm:hidden", marketDisplayStatus(m, nowMs).open ? "bg-success" : "bg-warning")} />
                      </Link>
                      <StatusCell market={m} nowMs={nowMs} />
                    </span>
                  </span>
                </td>
                <td className={cn("px-3 text-right", !isPriceFresh(m, nowMs) && "text-tertiary")}>
                  {m.price > 0n ? formatPrice(m.price) : "—"}
                </td>
                <td className="px-3 text-right">
                  <ChangeCell change={changes?.[m.id]} loading={changesLoading} />
                </td>
                <td
                  className={cn(
                    "px-3 text-right",
                    m.funding_rate_per_hour > 0n
                      ? "text-success"
                      : m.funding_rate_per_hour < 0n
                        ? "text-destructive"
                        : "text-muted-foreground",
                  )}
                >
                  {formatFundingRate(m.funding_rate_per_hour)}
                </td>
                <td className="px-3 text-right">
                  <span className="inline-flex flex-col items-end gap-1">
                    <span className="whitespace-nowrap">
                      {usd0(m.oi_long + m.oi_short)}
                      <span className="text-tertiary"> / {usd0(m.effective_max_oi_per_side)}</span>
                    </span>
                    <OiBar used={maxSide} cap={m.effective_max_oi_per_side} className="w-28" />
                    <span className="text-label text-tertiary">{marketLimitLabel(m)}</span>
                  </span>
                </td>
                <td className="px-3 text-right">
                  <Term hint={`Measured for ${m.id}: ${m.depth_measured_at_ms > 0 ? new Date(m.depth_measured_at_ms).toISOString() : "not measured yet"}.${m.measured_cap_is_grid_max ? " Probe grid passed; admission depth may be ramp-limited. See the curve for the largest size probed." : " Admission depth may be ramp-limited."}`}>
                    {formatExitCapacity(m)}
                  </Term>
                </td>
                <td className="px-3 text-right">{m.max_leverage}×</td>
                <td className="px-3 text-muted-foreground">{VAULT_LABEL[m.vault_id]}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
