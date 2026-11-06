"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { EmptyState, ErrorState, Skeleton } from "@/components/app/states";
import { formatUtc, useNow } from "@/components/landing/live-time";
import { marketStatus } from "@/lib/near/market-status";
import { HeaderStat, ReadAt } from "@/components/vault/vault-summary";
import { Term } from "@/components/vault/term";
import { Input } from "@/components/ui/input";
import { PanelTabs } from "@/components/ui/panel-tabs";
import { useFavorites } from "@/hooks/use-favorites";
import { useMarkets } from "@/hooks/use-ketos-queries";
import { useMarketStats } from "@/hooks/use-market-feeds";
import { networkName } from "@/lib/near/config";
import { usd0 } from "@/lib/near/format";
import { CANDLE_SOURCE } from "@/lib/prices/candles";
import { ListMarketPanel } from "./list-market-panel";
import { MarketsTable, sortMarkets, type Sort, type SortKey } from "./markets-table";

type Filter = "all" | "favorites" | "core" | "long-tail";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "favorites", label: "Favorites", testId: "markets-filter-favorites" },
  { id: "core", label: "Core vault" },
  { id: "long-tail", label: "Long-tail vault" },
] as const;

export function MarketsScreen() {
  const markets = useMarkets();
  const { favorites, toggle } = useFavorites();
  const nowMs = useNow();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "oi", dir: "desc" });
  const all = markets.data ?? [];
  const stats = useMarketStats(all.map((m) => m.id));

  const needle = query.trim().toUpperCase();
  const rows = sortMarkets(
    all.filter(
      (m) =>
        (filter === "all" ||
          (filter === "favorites" ? favorites.includes(m.id) : m.vault_id === filter)) &&
        (!needle || m.id.includes(needle)),
    ),
    sort,
    stats.data?.changes,
  );
  const openCount = all.filter((m) => marketStatus(m, nowMs).open).length;
  const totalOi = all.reduce((sum, m) => sum + m.oi_long + m.oi_short, 0n);
  const totalCapacity = all.reduce((sum, m) => sum + m.exit_capacity, 0n);

  const onSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "coin" ? "asc" : "desc" }));

  return (
    <>
      <section aria-label="Markets overview" className="flex min-w-0 flex-col gap-4 rounded-md border border-border bg-card p-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between md:gap-6">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-heading text-foreground">Markets</h1>
            <p className="text-ui text-muted-foreground">
              Every market&apos;s size cap comes from exit liquidity measured on NEAR Intents. Pick one to trade.
            </p>
          </div>
          <ReadAt at={markets.dataUpdatedAt} failing={markets.isError} />
        </div>
        {markets.data ? (
          <dl className="flex flex-wrap gap-x-10 gap-y-4">
            <HeaderStat label="Markets">
              <span data-testid="markets-count">{all.length}</span>
              <span className="text-ui text-tertiary"> · {openCount} open</span>
            </HeaderStat>
            <HeaderStat label={<Term hint="Total size of open positions on every market, longs and shorts.">Open Interest</Term>}>
              {usd0(totalOi)}
            </HeaderStat>
            <HeaderStat
              label={
                <Term hint="Sum over markets of the largest sale NEAR Intents could absorb within 1% price impact, at the last measurement.">
                  Measured exit capacity
                </Term>
              }
            >
              {usd0(totalCapacity)}
            </HeaderStat>
          </dl>
        ) : (
          <Skeleton className="h-12 w-80 max-w-full" />
        )}
      </section>

      <div className="grid flex-1 gap-1 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-label="All markets" className="flex min-h-96 min-w-0 flex-col rounded-md border border-border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-x-2 border-b border-border">
            <PanelTabs
              tabs={FILTERS}
              value={filter}
              onChange={setFilter}
              label="Filter markets"
              idPrefix="markets"
              className="min-w-0 border-b-0"
            />
            <div className="w-full px-2 pb-2 sm:w-auto sm:pb-0">
              <SearchBox value={query} onChange={setQuery} />
            </div>
          </div>
          <div id="markets-panel" role="tabpanel" aria-labelledby={`markets-tab-${filter}`} className="flex min-h-0 flex-1 flex-col">
            {markets.isPending ? (
              <div aria-busy className="flex flex-col gap-1 p-3">
                {Array.from({ length: 8 }, (_, i) => (
                  <Skeleton key={i} className="h-row" />
                ))}
              </div>
            ) : markets.isError && !markets.data ? (
              <div className="p-3">
                <ErrorState
                  title={`Markets are unavailable: the ${networkName()} RPC did not answer.`}
                  error={markets.error}
                  onRetry={() => void markets.refetch()}
                />
              </div>
            ) : rows.length === 0 ? (
              <EmptyState>
                {filter === "favorites" && !needle
                  ? "No favorites yet. Star a market to pin it here."
                  : `No market matches “${query.trim()}”.`}
              </EmptyState>
            ) : (
              <MarketsTable
                markets={rows}
                sort={sort}
                onSort={onSort}
                changes={stats.data?.changes}
                changesLoading={stats.isPending}
                favorites={favorites}
                onToggleFavorite={toggle}
              />
            )}
          </div>
          <p className="border-t border-border px-3 py-2 text-label text-tertiary">
            Prices: onchain oracle. 24h change: {CANDLE_SOURCE} USD spot
            {stats.data ? `, read ${formatUtc(stats.data.fetchedAtMs)}` : ""}
            {stats.isError ? " (unavailable, retrying)" : ""}.
          </p>
        </section>
        <ListMarketPanel markets={all} className="lg:self-start" />
      </div>
    </>
  );
}

function SearchBox({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="relative block w-full sm:w-56">
      <span className="sr-only">Search markets</span>
      <Search aria-hidden strokeWidth={1.5} className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-tertiary" />
      <Input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search"
        data-testid="markets-search"
        className="h-7 pl-8 text-ui"
      />
    </label>
  );
}
