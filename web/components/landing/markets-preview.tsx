"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Container, Eyebrow } from "@/components/ui/page-shell";
import { useDepths, useMarkets } from "@/hooks/use-ketos-queries";
import { useMarketStats } from "@/hooks/use-market-feeds";
import { formatPrice, usd0 } from "@/lib/near/format";
import { formatExitCapacity, isPriceFresh, marketDisplayStatus } from "@/lib/near/market-status";
import type { DepthRecord, Market } from "@/lib/near/types";
import { STALE_AFTER_MS, formatAge, formatUtc, useNow } from "./live-time";

function Measurement({ record, now }: { record: DepthRecord | undefined; now: number }) {
  if (!record) return <span className="text-tertiary">—</span>;
  const stale = now > 0 && now - record.measured_at_ms > STALE_AFTER_MS;
  return <span className={stale ? "text-warning" : "text-tertiary"}>{formatUtc(record.measured_at_ms)} · {formatAge(record.measured_at_ms, now)}{stale ? " · stale" : ""}</span>;
}

function MarketDetails({ market, record, now, change }: { market: Market; record: DepthRecord | undefined; now: number; change: number | null | undefined }) {
  const status = marketDisplayStatus(market, now);
  return (
    <dl className="grid grid-cols-2 gap-3 text-label tabular-nums">
      <div><dt className="text-tertiary">Measured exit depth</dt><dd>{record ? formatExitCapacity(market, record) : "—"}</dd></div>
      <div><dt className="text-tertiary">Admitted exit limit</dt><dd>{market.depth_measured_at_ms ? usd0(market.exit_capacity) : "—"}</dd></div>
      <div><dt className="text-tertiary">Effective cap / side</dt><dd>{usd0(market.effective_max_oi_per_side)}</dd></div>
      <div><dt className="text-tertiary">Effective leverage</dt><dd>{market.depth_measured_at_ms ? `${market.max_leverage}×` : "—"}</dd></div>
      <div><dt className="text-tertiary">24h spot change</dt><dd>{change == null ? "—" : `${change > 0 ? "+" : ""}${change.toFixed(2)}%`}</dd></div>
      <div className="col-span-2"><dt className="text-tertiary">Status</dt><dd className={status.open ? "text-success" : "text-warning"}>{status.open ? "Open" : status.label}</dd></div>
      <div className="col-span-2"><dt className="sr-only">Measurement time</dt><dd><Measurement record={record} now={now} /></dd></div>
    </dl>
  );
}

export function MarketsPreview() {
  const router = useRouter();
  const markets = useMarkets();
  const rows = markets.data?.slice(0, 4) ?? [];
  const depths = useDepths(rows.map((market) => market.id));
  const stats = useMarketStats(rows.map((market) => market.id));
  const now = useNow();
  return (
    <section id="markets" aria-labelledby="markets-title" className="scroll-mt-8">
      <Container className="max-w-landing md:px-12">
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between gap-4 border-b border-border p-5 md:p-6">
            <div className="flex flex-col gap-2"><Eyebrow>Live markets</Eyebrow><h2 id="markets-title" className="font-display text-heading">Real depth. Defined limits.</h2></div>
            <Link href="/markets" className="inline-flex shrink-0 items-center gap-2 rounded-sm text-ui text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">All markets <ArrowRight aria-hidden className="size-4" /></Link>
          </div>
          {markets.isPending ? <div aria-busy="true" className="p-5"><p role="status" className="sr-only">Loading markets</p>{[0, 1, 2, 3].map((i) => <div key={i} aria-hidden className="mb-2 h-16 rounded-sm bg-muted" />)}</div> : !markets.data ? (
            <div role="status" className="flex flex-wrap items-center justify-between gap-4 p-6"><p>Market registry unavailable.</p><Button size="sm" variant="outline" onClick={() => void markets.refetch()}>Retry</Button></div>
          ) : rows.length === 0 ? <p role="status" className="p-6 text-muted-foreground">No markets listed yet.</p> : <>
            <div className="hidden md:block">
              <table className="w-full table-fixed text-ui tabular-nums">
                <caption className="sr-only">Four markets from the onchain registry. 24 hour change is spot, not mark.</caption>
                <thead className="bg-muted text-label text-tertiary"><tr>{["Market", "Mark", "24h spot", "Measured exit depth", "Effective leverage", "Status"].map((label) => <th key={label} scope="col" className="px-5 py-3 text-left font-medium">{label}</th>)}</tr></thead>
                <tbody>{rows.map((market, i) => {
                  const record = depths[i]?.data?.history.at(-1);
                  const change = stats.data?.changes[market.id]?.percent;
                  const status = marketDisplayStatus(market, now);
                  return <tr key={market.id} data-testid={`landing-market-${market.id}`} onClick={() => router.push(`/trade?market=${encodeURIComponent(market.id)}`)} className="cursor-pointer border-t border-border hover:bg-muted/50">
                    <th scope="row" className="px-5 py-5 text-left font-medium"><Link href={`/trade?market=${encodeURIComponent(market.id)}`} onClick={(event) => event.stopPropagation()} className="rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">{market.id}-PERP <span aria-hidden>↗</span></Link></th>
                    <td className="px-5 py-5">{market.price > 0n ? formatPrice(market.price) : "—"}{market.price > 0n && !isPriceFresh(market, now) ? <span className="block text-label text-warning">Stale · {formatUtc(market.price_timestamp_ms)}</span> : null}</td>
                    <td className="px-5 py-5">{change == null ? "—" : `${change > 0 ? "+" : ""}${change.toFixed(2)}%`}</td>
                    <td className="px-5 py-5">{record ? formatExitCapacity(market, record) : "—"}<span className="block text-label"><Measurement record={record} now={now} /></span></td>
                    <td className="px-5 py-5">{market.depth_measured_at_ms ? `${market.max_leverage}×` : "—"}</td>
                    <td className={"px-5 py-5 text-label " + (status.open ? "text-success" : "text-warning")}>{status.open ? "Open" : status.label}</td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
            <ul className="divide-y divide-border md:hidden">{rows.map((market, i) => <li key={market.id} className="p-5">
              <div className="flex items-center justify-between gap-3 text-ui tabular-nums"><span className="font-medium">{market.id}</span><span className="ml-auto">{market.price > 0n ? formatPrice(market.price) : "—"}</span><Link href={`/trade?market=${encodeURIComponent(market.id)}`} className="rounded-sm border border-border px-3 py-2 focus-visible:outline-2 focus-visible:outline-ring">Trade<span className="sr-only"> {market.id}</span></Link></div>
              {market.price > 0n && !isPriceFresh(market, now) ? <p className="mt-2 text-label text-warning">Stale mark · {formatUtc(market.price_timestamp_ms)}</p> : null}
              <details className="mt-3"><summary className="w-fit cursor-pointer rounded-sm text-label text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">Market details</summary><div className="pt-3"><MarketDetails market={market} record={depths[i]?.data?.history.at(-1)} now={now} change={stats.data?.changes[market.id]?.percent} /></div></details>
            </li>)}</ul>
          </>}
          <div className="flex flex-col gap-3 border-t border-border p-5 text-label text-tertiary md:p-6">
            <p>Measured depth is the quoted sell size within 100 bps (1%) impact; ≥ means the largest probe passed. Admission may ramp more slowly. Effective caps also respect vault capital and protocol limits.</p>
            <details><summary className="w-fit cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">Admission and effective caps</summary><ul className="mt-3 grid gap-2 md:grid-cols-2">{rows.map((market) => <li key={market.id}>{market.id}: admitted {market.depth_measured_at_ms ? usd0(market.exit_capacity) : "—"} · effective {usd0(market.effective_max_oi_per_side)} / side</li>)}</ul></details>
            <p>24h change: {stats.data ? `${stats.data.source} spot · ${formatUtc(stats.data.fetchedAtMs)}` : "unavailable"}. Mark prices come from the protocol oracle. This page is read-only.</p>
            {markets.isError || stats.isError || depths.some((query) => query.isError) ? <p role="status" className="text-warning">Some data could not refresh. Cached values retain their timestamps; unavailable values are —.</p> : null}
          </div>
        </div>
      </Container>
    </section>
  );
}
