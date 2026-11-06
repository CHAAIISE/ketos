"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Star } from "lucide-react";
import { useNow } from "@/components/landing/live-time";
import { marketName } from "@/components/trade/market-header";
import { isPriceFresh, marketStatus } from "@/lib/near/market-status";
import { OiBar } from "@/components/trade/oi-bar";
import { Term } from "@/components/vault/term";
import { Badge } from "@/components/ui/badge";
import { formatFundingRate, formatPrice, usd0 } from "@/lib/near/format";
import { isMeasuring, type Market, type VaultId } from "@/lib/near/types";
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
 * larger measured cap, so tradable markets come before ones still being measured.
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
    a.max_oi_per_side === b.max_oi_per_side
      ? a.id.localeCompare(b.id)
      : a.max_oi_per_side > b.max_oi_per_side
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
  if (isMeasuring(market)) {
    return (
      <Term hint="Newly listed. It opens once the keeper has measured how much of it NEAR Intents can sell.">
        <Badge variant="warning" data-testid={`market-status-${market.id}`}>
          Measuring
        </Badge>
      </Term>
    );
  }
  const status = marketStatus(market, nowMs);
  if (status.open) {
    return isPriceFresh(market, nowMs) ? (
      <Badge variant="success" data-testid={`market-status-${market.id}`}>
        Open
      </Badge>
    ) : (
      <Term hint="The oracle price is older than 2 minutes; orders resume at the next keeper update.">
        <Badge data-testid={`market-status-${market.id}`}>Waiting for price</Badge>
      </Term>
    );
  }
  return (
    <Term hint={`${status.label}: new positions are paused, open positions can still be closed.`}>
      <Badge data-testid={`market-status-${market.id}`}>{status.reason === "thin" ? "Thin liquidity" : "Paused"}</Badge>
    </Term>
  );
}

export function MarketsTable({
  markets,
  sort,
  onSort,
  changes,
  changesLoading,
  favorites,
  onToggleFavorite,
}: {
  markets: readonly Market[];
  sort: Sort;
  onSort: (key: SortKey) => void;
  changes: Record<string, Change24h | null> | undefined;
  changesLoading: boolean;
  favorites: readonly string[];
  onToggleFavorite: (id: string) => void;
}) {
  const router = useRouter();
  const nowMs = useNow();
  const header = { sort, onSort };

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table data-testid="markets-table" className="w-full min-w-232 text-ui tabular-nums">
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
                <Term hint="Open interest (total size of open positions, longs + shorts) against the cap per side, set by exit liquidity measured on NEAR Intents.">
                  Open Interest / Cap
                </Term>
              }
              sortKey="oi"
              {...header}
            />
            <SortHeader label="Max Leverage" sortKey="leverage" {...header} />
            <th scope="col" className="h-8 px-3 text-left font-normal">
              <Term hint="The LP vault that takes the other side of this market's traders.">Vault</Term>
            </th>
            <th scope="col" className="h-8 px-3 text-left font-normal">
              Status
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
                    <Link
                      href={href}
                      onClick={(event) => event.stopPropagation()}
                      className="rounded-sm font-medium whitespace-nowrap text-foreground outline-none focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {marketName(m.id)}
                    </Link>
                    <Badge variant="success">{m.max_leverage}x</Badge>
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
                      <span className="text-tertiary"> / {usd0(m.max_oi_per_side)}</span>
                    </span>
                    <OiBar used={maxSide} cap={m.max_oi_per_side} className="w-28" />
                  </span>
                </td>
                <td className="px-3 text-right">{m.max_leverage}×</td>
                <td className="px-3 text-muted-foreground">{VAULT_LABEL[m.vault_id]}</td>
                <td className="px-3">
                  <StatusCell market={m} nowMs={nowMs} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
