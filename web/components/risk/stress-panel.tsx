"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { EmptyState, ErrorState, Skeleton } from "@/components/app/states";
import { formatAge, formatUtc } from "@/components/landing/live-time";
import { PanelHeading } from "@/components/vault/panel-heading";
import { useNear } from "@/hooks/near-provider";
import { formatPrice, formatUsd } from "@/lib/near/format";
import type { CrossAccount, Market } from "@/lib/near/types";
import { cn } from "@/lib/utils";
import { calculateStress, type StressResult } from "./stress";

export function StressPanel({ markets, selected, onSelect, shock, onShock, now }: {
  markets: Market[];
  selected: string;
  onSelect: (id: string) => void;
  shock: number;
  onShock: (shock: number) => void;
  now: number;
}) {
  const { views } = useNear();
  const snapshot = useQuery({
    queryKey: ["ketos", "risk-snapshot", selected],
    queryFn: async () => {
      const [positions, markets, vaults] = await Promise.all([
        views.allOpenPositions(), views.markets(), views.vaults(),
      ]);
      const ids = [...new Set(positions.filter((p) => p.margin_mode === "cross" && p.market_id === selected).map((p) => p.account_id))];
      const crossAccounts: CrossAccount[] = [];
      for (let from = 0; from < ids.length; from += 8) {
        crossAccounts.push(...await Promise.all(ids.slice(from, from + 8).map((id) => views.crossAccount(id))));
      }
      return { positions, markets, vaults, crossAccounts };
    },
    refetchInterval: 10_000,
  });
  let result: StressResult | undefined;
  let calculationError: unknown;
  if (snapshot.data && now > 0) {
    try {
      result = calculateStress({ ...snapshot.data, marketId: selected, shockPercent: shock, nowMs: now });
    } catch (error) {
      calculationError = error;
    }
  }
  const selectedMarket = snapshot.data?.markets.find((m) => m.id === selected);
  const shockedPrice = selectedMarket ? selectedMarket.price * BigInt(100 - shock) / 100n : 0n;

  return (
    <section aria-labelledby="stress-title" className="order-1 min-w-0 rounded-md border border-border bg-card md:order-2">
      <PanelHeading id="stress-title" aside={<span className="text-label text-tertiary">Read-only scenario</span>}>Stress test</PanelHeading>
      <div className="grid gap-4 p-3 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <label htmlFor="stress-market" className="text-label text-muted-foreground">Asset to shock</label>
          <select id="stress-market" value={selected} onChange={(event) => onSelect(event.target.value)} className="h-control rounded-md border border-border bg-input px-3 text-ui focus-visible:outline-2 focus-visible:outline-ring">
            {markets.map((market) => <option key={market.id} value={market.id}>{market.id}</option>)}
          </select>
          <p className="text-label text-tertiary tabular-nums">{selectedMarket?.price ? <>{formatPrice(selectedMarket.price)} → <span className="text-destructive">{formatPrice(shockedPrice)}</span></> : "Waiting for an oracle price"}</p>
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="stress-shock" className="flex justify-between text-label text-muted-foreground">Instant price drop <output htmlFor="stress-shock" className="text-ui text-destructive tabular-nums">−{shock}%</output></label>
          <input id="stress-shock" type="range" min="10" max="50" step="1" value={shock} aria-valuetext={`Minus ${shock} percent`} onChange={(event) => onShock(Number(event.target.value))} className="h-control w-full cursor-pointer accent-warning" />
          <div className="flex justify-between text-label text-tertiary"><span>−10%</span><span>−50%</span></div>
        </div>
      </div>
      <p className="border-t border-border px-3 py-2 text-label text-muted-foreground">The scenario sends no transaction or oracle update. The background keeper operates independently.</p>
      {snapshot.isError ? <ErrorState className="m-3" title="Could not refresh the stress snapshot." error={snapshot.error} onRetry={() => void snapshot.refetch()} /> : null}
      {calculationError ? <ErrorState className="m-3" title="Scenario unavailable: incomplete onchain state." error={calculationError} onRetry={() => void snapshot.refetch()} /> : null}
      {snapshot.isPending || now === 0 ? <div className="p-3"><Skeleton className="h-40" /></div> : result ? (
        <>
          <dl className="grid grid-cols-2 border-y border-border text-ui lg:grid-cols-4">
            <Metric label="Liquidatable notional" value={formatUsd(result.liquidatableNotional)} testId="stress-notional" />
            <Metric label="Measured exit capacity" value={result.capacity === null ? "Unavailable" : formatUsd(result.capacity)} />
            <Metric label="Core bad debt · est." value={formatUsd(result.badDebtByVault.core)} danger={result.badDebtByVault.core > 0n} testId="stress-debt-core" />
            <Metric label="Long-tail bad debt · est." value={formatUsd(result.badDebtByVault["long-tail"])} danger={result.badDebtByVault["long-tail"] > 0n} testId="stress-debt-long-tail" />
          </dl>
          <div className="flex flex-col gap-1 px-3 py-2 text-label text-tertiary">
            <p>Capacity is the last measured limit, not a forecast after the shock. Bad debt = uncovered trader equity, not total vault loss.</p>
            <p>Accrued fees and funding frozen at the read. Orders, TP/SL and future liquidity changes excluded; liquidation ordering and cross-account cash affect the estimate.</p>
            {result.warnings.map((warning) => <p key={warning} role="status" className="text-warning">{warning}</p>)}
          </div>
          {result.rows.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-176 text-ui tabular-nums">
                <caption className="px-3 py-2 text-left text-label text-muted-foreground">Affected positions · selected asset and all legs of its cross accounts</caption>
                <thead className="bg-muted text-label text-tertiary"><tr>{["Position", "Account", "Mode", "Size", "Scenario price", "Equity", "Maintenance", "Outcome"].map((name) => <th key={name} className="h-8 px-3 text-right font-normal first:text-left">{name}</th>)}</tr></thead>
                <tbody>{result.rows.map((row) => (
                  <tr key={row.position.id} data-testid={`stress-position-${row.position.id}`} className="h-row border-b border-border last:border-0">
                    <td className="px-3 whitespace-nowrap"><Link href={`/trade?market=${encodeURIComponent(row.position.market_id)}`} className="hover:underline">{row.position.market_id} #{row.position.id}</Link><span className={cn("ml-2 text-label", row.position.side === "long" ? "text-success" : "text-destructive")}>{row.position.side}</span></td>
                    <td title={row.position.account_id} className="max-w-32 truncate px-3 text-right text-muted-foreground">{row.position.account_id}</td>
                    <td className="px-3 text-right text-muted-foreground">{row.position.margin_mode}</td>
                    <td className="px-3 text-right">{formatUsd(row.position.size)}</td>
                    <td className="px-3 text-right">{formatPrice(row.price)}</td>
                    <td className={cn("px-3 text-right", row.equity < 0n && "text-destructive")}>{formatUsd(row.equity)}</td>
                    <td className="px-3 text-right text-muted-foreground">{formatUsd(row.position.maintenance_margin)}</td>
                    <td className={cn("px-3 text-right whitespace-nowrap", row.liquidatable ? "text-destructive" : "text-muted-foreground")}>{row.liquidatable ? "Would liquidate" : "Remains open"}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : <EmptyState action={<Link href={`/trade?market=${encodeURIComponent(selected)}`} className="text-foreground underline underline-offset-4">Trade {selected} →</Link>}>No open positions exposed to {selected}. Choose another asset or open a position to inspect its risk.</EmptyState>}
          <p className="px-3 py-2 text-label text-tertiary tabular-nums">Snapshot read {formatUtc(snapshot.dataUpdatedAt, true)} · {formatAge(snapshot.dataUpdatedAt, now)} · separate finalized RPC reads, not one atomic block.</p>
        </>
      ) : null}
    </section>
  );
}

function Metric({ label, value, danger, testId }: { label: string; value: string; danger?: boolean; testId?: string }) {
  return <div className="border-r border-border p-3 last:border-r-0"><dt className="text-label text-tertiary">{label}</dt><dd data-testid={testId} className={cn("mt-1 tabular-nums text-subtitle", danger && "text-destructive")}>{value}</dd></div>;
}
