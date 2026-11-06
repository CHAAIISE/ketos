"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { EmptyState, ErrorState, Skeleton } from "@/components/app/states";
import { formatUtc, useNow } from "@/components/landing/live-time";
import { marketDisplayStatus, marketStatus } from "@/lib/near/market-status";
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
  const all = nowMs ? markets.data ?? [] : [];
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
  const openCount = all.filter((m) => marketDisplayStatus(m, nowMs).open).length;
  const openRows = rows.filter((m) => marketStatus(m, nowMs).open);
  const closedRows = rows.filter((m) => !marketStatus(m, nowMs).open);
  const totalOi = all.reduce((sum, m) => sum + m.oi_long + m.oi_short, 0n);

  const onSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "coin" ? "asc" : "desc" }));

  return (
    <>
      <section aria-label="Markets overview" className="flex min-w-0 flex-col gap-4 rounded-md border border-border bg-card p-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between md:gap-6">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-heading text-foreground">Markets</h1>
            <p className="text-ui text-muted-foreground">
              Market limits reflect measured exit liquidity and vault capital. Pick one to inspect or trade.
            </p>
          </div>
          <ReadAt at={markets.dataUpdatedAt} failing={markets.isError} />
        </div>
        {nowMs > 0 && markets.data ? (
          <dl className="flex flex-wrap gap-x-10 gap-y-4">
            <HeaderStat label="Markets">
              <span data-testid="markets-count">{all.length}</span>
              <span className="text-ui text-tertiary"> · {openCount} open</span>
            </HeaderStat>
            <HeaderStat label={<Term hint="Total size of open positions on every market, longs and shorts.">Open Interest</Term>}>
              {usd0(totalOi)}
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
          <p className="border-b border-border px-3 py-2 text-label text-muted-foreground sm:hidden">
            Swipe for funding, limits and vaults. Coin stays in view.
          </p>
          <div id="markets-panel" role="tabpanel" aria-labelledby={`markets-tab-${filter}`} className="flex min-h-0 flex-1 flex-col">
            {!nowMs || markets.isPending ? (
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
              <>
                {openRows.length ? (
                  <MarketsTable
                    markets={openRows}
                    nowMs={nowMs}
                    sort={sort}
                    onSort={onSort}
                    changes={stats.data?.changes}
                    changesLoading={stats.isPending}
                    favorites={favorites}
                    onToggleFavorite={toggle}
                  />
                ) : (
                  <p role="status" className="p-3 text-ui text-muted-foreground">
                    No markets accepting new positions match this view. Browse the thin and closed markets below to inspect measurements and limits.
                  </p>
                )}
                {closedRows.length ? (
                  <details className="border-t border-border" data-testid="markets-closed-group">
                    <summary className="cursor-pointer px-3 py-3 text-ui text-muted-foreground outline-none hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
                      Thin &amp; closed markets · {closedRows.length}
                    </summary>
                    <p className="px-3 pb-3 text-label text-tertiary">
                      Depth or vault-backing requirements currently prevent new positions. Market details remain accessible.
                    </p>
                    <MarketsTable
                      markets={closedRows}
                      nowMs={nowMs}
                      tableTestId="markets-closed-table"
                      sort={sort}
                      onSort={onSort}
                      changes={stats.data?.changes}
                      changesLoading={stats.isPending}
                      favorites={favorites}
                      onToggleFavorite={toggle}
                    />
                  </details>
                ) : null}
              </>
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
