"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { ErrorState, Skeleton } from "@/components/app/states";
import { Badge } from "@/components/ui/badge";
import { ReadAt } from "@/components/vault/vault-summary";
import { useMarkets } from "@/hooks/use-ketos-queries";
import { formatUsd } from "@/lib/near/format";
import { ListMarketPanel } from "./list-market-panel";

const noSubscription = () => () => {};

export function LaunchScreen() {
  // The shared app queries can finish before this streamed route hydrates.
  const hydrated = useSyncExternalStore(noSubscription, () => true, () => false);
  return hydrated ? <LaunchDashboard /> : <Skeleton className="h-96 w-full" />;
}

function LaunchDashboard() {
  const markets = useMarkets();
  const launched = markets.data?.filter((market) => market.isolated_only) ?? [];
  return <>
    <section className="flex flex-wrap items-start justify-between gap-4 rounded-md border border-border bg-card p-4">
      <div className="max-w-2xl">
        <h1 className="text-heading">Launch</h1>
        <p className="mt-2 text-ui text-muted-foreground">One market. Its own capital. Create a supported perpetual market, fund its vault and let measured liquidity set the limits.</p>
      </div>
      <ReadAt at={markets.dataUpdatedAt} failing={markets.isError} />
    </section>
    {markets.isError ? <ErrorState title="The market registry is unavailable." error={markets.error} onRetry={() => void markets.refetch()} />
      : markets.isPending ? <Skeleton className="h-96 w-full" /> : <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.8fr)]">
        <ListMarketPanel markets={markets.data} />
        <div className="flex min-w-0 flex-col gap-4">
          <section className="rounded-md border border-border bg-card p-4">
            <h2 className="text-subtitle">From creation to trading</h2>
            <ol className="mt-4 flex flex-col gap-4 text-ui">
              <li><span className="font-medium">1. Create · 25 USDC</span><p className="mt-1 text-muted-foreground">Select an exact supported source and route. The listing fee goes to Long-tail; the new vault starts empty.</p></li>
              <li><span className="font-medium">2. Fund · separate LP deposit</span><p className="mt-1 text-muted-foreground">Receive shares in this market only. Trader gains reduce your NAV; fees and trader losses can increase it. There is no fixed return.</p></li>
              <li><span className="font-medium">3. Observe · then trade</span><p className="mt-1 text-muted-foreground">The keeper measures real exit depth. Capital, depth and a fresh execution price must all pass before a position opens. Launching does not guarantee liquidity.</p></li>
            </ol>
          </section>
          <section className="rounded-md border border-border bg-card p-4">
            <h2 className="text-subtitle">Isolated markets</h2>
            {launched.length ? <ul className="mt-3 divide-y divide-border">
              {launched.map((market) => <li key={market.id} className="flex flex-col gap-3 py-4 first:pt-0">
                <div className="flex items-center justify-between gap-3"><Link href={`/trade?market=${encodeURIComponent(market.id)}`} className="font-medium hover:underline">{market.id}-USD</Link><Badge variant={market.launch_state === "ready" ? "success" : "warning"}>{market.launch_state}</Badge></div>
                <p className="text-label text-muted-foreground">Capital-backed cap {formatUsd(market.vault_backed_cap_usd)} · isolated only · up to {market.max_leverage_cap}×</p>
                <div className="flex flex-wrap gap-4 text-ui"><Link href={`/vaults/${market.vault_id}`} className="underline">Fund / withdraw LP capital →</Link><Link href={`/trade?market=${encodeURIComponent(market.id)}`} className="underline">{market.launch_state === "ready" ? "Trade" : "Inspect"} →</Link></div>
              </li>)}
            </ul> : <p className="mt-3 text-ui text-muted-foreground">No isolated markets have been created yet. Existing markets retain their shared Core and Long-tail capital.</p>}
          </section>
        </div>
      </div>}
  </>;
}
