"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Container, Eyebrow } from "@/components/ui/page-shell";
import { PriceChart } from "@/components/trade/price-chart";
import { useMarkets } from "@/hooks/use-ketos-queries";
import { formatPrice, usd0 } from "@/lib/near/format";
import { marketDisplayStatus } from "@/lib/near/market-status";
import { formatUtc, useNow } from "./live-time";

export function Hero() {
  const markets = useMarkets();
  const [selected, setSelected] = useState("BTC");
  const market = markets.data?.find((item) => item.id === selected) ?? markets.data?.[0];
  const now = useNow();
  const status = market ? marketDisplayStatus(market, now) : null;

  return (
    <section aria-labelledby="hero-title">
      <Container className="grid max-w-landing gap-10 py-10 md:px-landing-gutter md:py-16 lg:grid-cols-[0.85fr_1.15fr] lg:items-center lg:gap-12">
        <div className="flex min-w-0 flex-col items-start gap-6">
          <Eyebrow>NEAR-native perpetuals</Eyebrow>
          <h1 id="hero-title" className="font-display text-display-sm leading-[1.02] tracking-tight text-foreground md:text-display">
            Trade perps.<br /><span className="text-muted-foreground">See the risk.</span>
          </h1>
          <p className="max-w-reading text-body text-muted-foreground">
            Long or short on NEAR. See the collateral, execution bounds, and liquidity behind every market before you trade.
          </p>
          <div className="flex flex-wrap items-center gap-6">
            <Link href="/trade" data-primary className={buttonVariants({ size: "pill" })}>
              Start trading <ArrowRight aria-hidden />
            </Link>
            <Link href="/vaults" className="inline-flex items-center gap-2 rounded-sm py-3 text-ui text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              Explore vaults <ArrowUpRight aria-hidden className="size-4" />
            </Link>
          </div>
          <ul className="flex flex-wrap gap-x-5 gap-y-2 border-t border-border pt-5 text-label text-tertiary">
            <li>Wallet-funded entries</li><li>Onchain TP / SL</li><li>Partial closes</li>
          </ul>
        </div>

        <div aria-label="Live terminal preview" className="min-w-0 overflow-hidden rounded-xl border border-border bg-card shadow-2xl shadow-black/20">
          <div className="flex min-h-11 items-center justify-between gap-3 border-b border-border px-4 text-label">
            <span className="text-muted-foreground">Trading terminal <span className="text-tertiary">/ Testnet</span></span>
            <Link href={market ? `/trade?market=${encodeURIComponent(market.id)}` : "/trade"} aria-label="Open trading terminal" className="flex size-11 items-center justify-center rounded-sm hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"><ArrowUpRight aria-hidden className="size-4" /></Link>
          </div>
          {!market ? <div className="flex h-80 flex-col items-center justify-center gap-4 px-5 text-ui text-muted-foreground" role="status">
            <p>{markets.isPending ? "Loading onchain markets…" : markets.isError ? "Market registry unavailable." : "No markets listed yet."}</p>
            {markets.isError ? <Button size="sm" variant="outline" onClick={() => void markets.refetch()}>Retry</Button> : null}
          </div> : <>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2">
              <div role="group" aria-label="Preview market" className="flex gap-1">
                {markets.data?.slice(0, 3).map((item) => <button key={item.id} type="button" aria-pressed={market.id === item.id} onClick={() => setSelected(item.id)} className={`min-h-11 rounded-md px-3 text-ui transition-colors focus-visible:outline-2 focus-visible:outline-ring ${market.id === item.id ? "bg-muted text-foreground" : "text-tertiary hover:text-foreground"}`}>{item.id}</button>)}
              </div>
              <div className="px-1 text-right tabular-nums"><p className="text-label text-tertiary">{market.id}-USD · Mark</p><p className="text-heading">{market.price > 0n ? formatPrice(market.price) : "—"}</p></div>
            </div>
            <PriceChart key={market.id} market={market} className="h-72 md:h-80" />
            <dl className="grid grid-cols-2 gap-4 border-t border-border px-4 py-3 text-label tabular-nums">
              <div><dt className="text-tertiary">Admitted exit limit</dt><dd className="mt-1 text-ui">{market.depth_measured_at_ms ? usd0(market.exit_capacity) : "—"}</dd></div>
              <div><dt className="text-tertiary">Effective leverage</dt><dd className="mt-1 text-ui">{market.depth_measured_at_ms ? `${market.max_leverage}×` : "—"}</dd></div>
            </dl>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-label">
              <span className={status?.open ? "text-success" : "text-warning"}>{status?.open ? "Open" : status?.label}</span>
              <span className="text-tertiary">Oracle {market.price_timestamp_ms ? formatUtc(market.price_timestamp_ms, true) : "unavailable"}</span>
              {markets.isError ? <span role="status" className="w-full text-warning">Registry refresh unavailable. Showing timestamped cached data.</span> : null}
            </div>
          </>}
        </div>
      </Container>
    </section>
  );
}
