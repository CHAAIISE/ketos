"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { ConnectButton } from "@/components/app/connect-button";
import { EmptyState, ErrorState, Skeleton } from "@/components/app/states";
import { shortAccount } from "@/components/app/wallet-button";
import { SortHeader } from "@/components/markets/markets-table";
import { HeaderStat, ReadAt } from "@/components/vault/vault-summary";
import { Term } from "@/components/vault/term";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAccountId } from "@/hooks/near-provider";
import { useLeaderboard } from "@/hooks/use-ketos-queries";
import { networkName } from "@/lib/near/config";
import { formatUnits, formatUsd, usd0 } from "@/lib/near/format";
import { LEADERBOARD_MAX } from "@/lib/near/views";
import { cn } from "@/lib/utils";
import { rankLeaderboard, type LeaderboardKey, type RankedEntry } from "./leaderboard-math";

interface Sort {
  key: LeaderboardKey;
  dir: "asc" | "desc";
}

const KEY_LABEL: Record<LeaderboardKey, string> = {
  pnl: "realized PnL",
  roi: "ROI",
  volume: "volume",
  trades: "trades",
};

const signedTone = (value: bigint) => (value > 0n ? "text-success" : value < 0n ? "text-destructive" : "text-muted-foreground");

export function LeaderboardScreen() {
  // The contract ranks at most LEADERBOARD_MAX accounts, so one read returns the whole board.
  const board = useLeaderboard("pnl", LEADERBOARD_MAX);
  const accountId = useAccountId();
  const [sort, setSort] = useState<Sort>({ key: "pnl", dir: "desc" });
  const [query, setQuery] = useState("");

  const ranked = useMemo(() => rankLeaderboard(board.data ?? [], sort.key), [board.data, sort.key]);
  const needle = query.trim().toLowerCase();
  const filtered = needle ? ranked.filter((row) => row.account_id.toLowerCase().includes(needle)) : ranked;
  const rows = sort.dir === "asc" ? [...filtered].reverse() : filtered;
  const mine = accountId ? ranked.find((row) => row.account_id === accountId) : undefined;
  const totalVolume = ranked.reduce((sum, row) => sum + row.volume, 0n);
  const totalTrades = ranked.reduce((sum, row) => sum + row.trades, 0);

  const onSort = (key: LeaderboardKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));

  return (
    <>
      <section aria-label="Leaderboard overview" className="flex min-w-0 flex-col gap-4 rounded-md border border-border bg-card p-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between md:gap-6">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-heading text-foreground">Leaderboard</h1>
            <p className="text-ui text-muted-foreground">
              All-time ranking of traders by PnL booked onchain at each close and liquidation.
            </p>
          </div>
          <ReadAt at={board.dataUpdatedAt} failing={board.isError} />
        </div>
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between md:gap-6">
          {board.data ? (
            <dl className="flex flex-wrap gap-x-10 gap-y-4">
              <HeaderStat label="Traders ranked">
                <span data-testid="leaderboard-count">{ranked.length}</span>
              </HeaderStat>
              <HeaderStat label={<Term hint="Entry plus exit notional of every ranked trader's positions.">Volume · all-time</Term>}>
                {usd0(totalVolume)}
              </HeaderStat>
              <HeaderStat label="Trades">{totalTrades.toLocaleString("en-US")}</HeaderStat>
            </dl>
          ) : (
            <Skeleton className="h-12 w-80 max-w-full" />
          )}
          <YourRank accountId={accountId} mine={mine} sortKey={sort.key} loading={board.isPending} />
        </div>
      </section>

      <section aria-label="Traders" className="flex min-h-96 min-w-0 flex-1 flex-col rounded-md border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
          <span className="text-ui text-foreground">
            All-time <span className="text-tertiary">· sorted by {KEY_LABEL[sort.key]}</span>
          </span>
          <label className="relative block w-full sm:w-56">
            <span className="sr-only">Search traders</span>
            <Search aria-hidden strokeWidth={1.5} className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-tertiary" />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search account"
              data-testid="leaderboard-search"
              className="h-7 pl-8 text-ui"
            />
          </label>
        </div>
        {board.isPending ? (
          <div aria-busy className="flex flex-col gap-1 p-3">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-row" />
            ))}
          </div>
        ) : board.isError && !board.data ? (
          <div className="p-3">
            <ErrorState
              title={`The leaderboard is unavailable: the ${networkName()} RPC did not answer.`}
              error={board.error}
              onRetry={() => void board.refetch()}
            />
          </div>
        ) : ranked.length === 0 ? (
          <EmptyState action={<Link href="/trade" className="text-foreground underline underline-offset-4">Open the first position →</Link>}>
            No trader is ranked yet. Every open and close is recorded onchain and appears here.
          </EmptyState>
        ) : rows.length === 0 ? (
          <EmptyState>No ranked account matches “{query.trim()}”.</EmptyState>
        ) : (
          <LeaderboardTable rows={rows} sort={sort} onSort={onSort} accountId={accountId} />
        )}
        <p className="border-t border-border px-3 py-2 text-label text-tertiary">
          Read from <span className="font-mono">get_leaderboard</span>. Ranks the {LEADERBOARD_MAX} most recently active
          traders; PnL includes trading fees, borrow fees and settled funding, not open positions.
        </p>
      </section>
    </>
  );
}

function YourRank({
  accountId,
  mine,
  sortKey,
  loading,
}: {
  accountId: string | null;
  mine: RankedEntry | undefined;
  sortKey: LeaderboardKey;
  loading: boolean;
}) {
  if (!accountId) {
    return (
      <div className="flex w-full flex-col gap-2 md:w-64">
        <p className="text-label text-tertiary">Connect to find your rank.</p>
        <ConnectButton />
      </div>
    );
  }
  let body: ReactNode;
  if (loading) body = <Skeleton className="h-5 w-32" />;
  else if (mine)
    body = (
      <span data-testid="leaderboard-your-rank" className="text-subtitle text-foreground tabular-nums">
        #{mine.rank}
        <span className="text-ui text-tertiary"> by {KEY_LABEL[sortKey]}</span>
      </span>
    );
  else body = <span className="text-ui text-muted-foreground">Not ranked yet: your first trade adds you.</span>;
  return (
    <div className="flex w-full flex-wrap items-end justify-between gap-3 rounded-md border border-border px-3 py-2 md:w-auto md:justify-start md:gap-6">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-label text-tertiary">Your rank · {shortAccount(accountId)}</span>
        {body}
      </div>
      <Link href="/trade" data-primary className={buttonVariants({ size: "sm" })}>
        {mine ? "Trade" : "Start trading"}
      </Link>
    </div>
  );
}

function LeaderboardTable({
  rows,
  sort,
  onSort,
  accountId,
}: {
  rows: readonly RankedEntry[];
  sort: Sort;
  onSort: (key: LeaderboardKey) => void;
  accountId: string | null;
}) {
  const header = { sort, onSort };
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table data-testid="leaderboard-table" className="w-full min-w-xl text-ui tabular-nums">
        <thead className="sticky top-0 z-10 bg-card text-label text-tertiary">
          <tr className="border-b border-border">
            <th scope="col" className="h-8 w-16 px-3 text-left font-normal">
              Rank
            </th>
            <th scope="col" className="h-8 px-3 text-left font-normal">
              Trader
            </th>
            <SortHeader
              label={<Term hint="All-time realized PnL after trading fees, borrow fees and settled funding.">PnL</Term>}
              sortKey="pnl"
              {...header}
            />
            <SortHeader
              label={<Term hint="Realized PnL divided by the margin committed when each position was opened.">ROI</Term>}
              sortKey="roi"
              {...header}
            />
            <SortHeader label="Volume" sortKey="volume" {...header} />
            <SortHeader
              label={<Term hint="Opens and closes, liquidations included.">Trades</Term>}
              sortKey="trades"
              {...header}
            />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const current = row.account_id === accountId;
            return (
              <tr
                key={row.account_id}
                data-testid={`leaderboard-row-${row.account_id}`}
                data-current={current || undefined}
                aria-current={current ? "true" : undefined}
                className={cn(
                  "h-row border-b border-border/60 last:border-b-0",
                  current ? "bg-muted shadow-[inset_2px_0_0_var(--color-foreground)]" : "hover:bg-muted/60",
                )}
              >
                <td className={cn("px-3", row.rank <= 3 ? "text-foreground" : "text-tertiary")}>{row.rank}</td>
                <th scope="row" className="px-3 text-left font-normal">
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-foreground" title={row.account_id}>
                      {shortAccount(row.account_id)}
                    </span>
                    {current ? <Badge variant="success">You</Badge> : null}
                  </span>
                </th>
                <td className={cn("px-3 text-right", signedTone(row.realized_pnl))}>{formatUsd(row.realized_pnl, { signed: true })}</td>
                <td className={cn("px-3 text-right", signedTone(row.roi_bps))}>
                  {formatUnits(row.roi_bps, 2, { maxFractionDigits: 2, signed: true })}%
                </td>
                <td className="px-3 text-right">{usd0(row.volume)}</td>
                <td className="px-3 text-right">{row.trades}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
