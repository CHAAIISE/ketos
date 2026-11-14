"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { EmptyState, ErrorState, Skeleton } from "@/components/app/states";
import { formatUtc, useNow } from "@/components/landing/live-time";
import { Button } from "@/components/ui/button";
import { useDepth, useMarkets } from "@/hooks/use-ketos-queries";
import type { Market } from "@/lib/near/types";
import { CapacityHeatmap, CapacityHistory } from "./capacity-panels";
import { StressPanel } from "./stress-panel";
import { STRESS_MODEL_LIMITATIONS } from "./stress";
import { HedgePanel } from "./hedge-panel";
import { HedgeReplayPanel } from "./hedge-replay-panel";

export function RiskScreen() {
  const markets = useMarkets();
  const [selection, setSelection] = useState("NEAR");
  const [shock, setShock] = useState(20);
  // The shared query can settle in the shell before this screen hydrates; useNow stays zero until then.
  const now = useNow();
  const selected = markets.data?.some((m) => m.id === selection) ? selection : markets.data?.[0]?.id ?? selection;
  const depth = useDepth(selected);
  const market = markets.data?.find((m) => m.id === selected);

  return (
    <>
      <section className="flex flex-col gap-2 rounded-md border border-border bg-card p-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <h1 className="text-heading">Risk</h1>
          <p className="mt-1 text-ui text-muted-foreground">Measured exit liquidity, market limits and the impact of a sudden price drop.</p>
        </div>
        <p className="shrink-0 text-label text-tertiary tabular-nums">{now > 0 && markets.data ? `Registry read ${formatUtc(markets.dataUpdatedAt, true)}` : "Reading onchain markets…"}</p>
      </section>
      {now > 0 && markets.isError ? <ErrorState title="Could not refresh the market registry." error={markets.error} onRetry={() => void markets.refetch()} /> : null}
      {!now || markets.isPending ? <Skeleton className="h-80" /> : markets.data?.length ? (
        <div className="flex min-w-0 flex-col gap-1">
          <CapacityHeatmap markets={markets.data} selected={selected} onSelect={setSelection} now={now} />
          <StressPanel markets={markets.data} selected={selected} onSelect={setSelection} shock={shock} onShock={setShock} now={now} />
          <div className="order-3 flex min-w-0 flex-col gap-1">
            {depth.isError ? <ErrorState title="Could not refresh capacity history." error={depth.error} onRetry={() => void depth.refetch()} /> : null}
            {depth.isPending ? <Skeleton className="h-80" /> : <CapacityHistory key={selected} view={depth.data ?? null} now={now} />}
          </div>
        </div>
      ) : !markets.isError ? <EmptyState>No markets registered yet. Reload once a market has been listed.</EmptyState> : null}
      <HedgePanel markets={markets.data ?? []} now={now} />
      <HedgeReplayPanel />
      <Methodology market={now ? market : undefined} />
    </>
  );
}

function Methodology({ market }: { market?: Market }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText("pnpm depth:sample");
      setCopied(true);
      setError(false);
    } catch {
      setError(true);
    }
  };
  return (
    <section className="rounded-md border border-border bg-card p-3">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div><h2 className="text-ui font-medium">Re-run the measurement</h2><p className="mt-1 text-label text-muted-foreground">Read-only 1Click quotes from your machine. No key required.</p></div>
        <div className="flex flex-wrap items-center gap-3"><code className="text-ui text-muted-foreground">pnpm depth:sample</code><Button data-primary onClick={copy}>{copied ? <Check aria-hidden /> : <Copy aria-hidden />}{copied ? "Copied" : "Copy re-run command"}</Button></div>
      </div>
      {error ? <p role="alert" className="mt-2 text-label text-warning">Clipboard unavailable. Select and copy the command above.</p> : null}
      {copied ? <p role="status" className="sr-only">Command copied to clipboard.</p> : null}
      <details className="mt-3 border-t border-border pt-3 text-ui">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Methodology &amp; details</summary>
        <dl className="mt-3 grid gap-x-6 gap-y-3 text-muted-foreground md:grid-cols-[auto_1fr]">
          <dt className="text-tertiary">Exit capacity</dt><dd>Largest sell size whose net price impact and every smaller sampled size stay within 100 bps on NEAR Intents. Dry 1Click quotes into USDC on NEAR; platform fee removed (25 bps without a partner key, route-specific partner fee otherwise). A missing route is not liquidity.</dd>
          <dt className="text-tertiary">Limits</dt><dd>The effective open-interest cap per side is the lowest of measured exit capacity, the protocol limit and vault backing. Capacity below $10,000 or older than 30 min pauses new entries; insufficient vault backing also blocks them. A stale displayed price requires a fresh execution price. Leverage tiers: 2× below $50,000, 5× from $50,000, 10× from $250,000, 20× from $1,000,000, subject to the market ceiling.</dd>
          <dt className="text-tertiary">Stress model</dt><dd>One instantaneous price drop. Trader gains round down and are capped at position size; losses round up. Maintenance uses leverage locked at entry. Cross legs share account cash and equity; whole positions close by increasing equity / maintenance until health recovers. Penalties and vault payout caps are included. Debt is attributed to the vault owed, not netted across vaults. This is an estimate from separate reads, not a liquidation guarantee.</dd>
          <dt className="text-tertiary">Estimate boundaries</dt><dd className="flex flex-col gap-2">{STRESS_MODEL_LIMITATIONS.map((limitation) => <p key={limitation}>{limitation}</p>)}</dd>
          <dt className="text-tertiary">History</dt><dd>Up to 48 real onchain samples per market inside the last 24h. Faster sampling shortens retained coverage. Missed observations are not backfilled. Tightening compares the two latest samples when the latest is within 30 min.</dd>
          <dt className="text-tertiary">Selected market</dt><dd className="break-all font-mono text-label">{market ? `${market.id} · ${market.intents_asset_id} · ${market.oracle_asset_id} · ${market.price_source}` : "—"}</dd>
          <dt className="text-tertiary">Data sources</dt><dd>Onchain market registry, depth history, open positions, cross-margin accounts and vault balances, read separately.</dd>
        </dl>
      </details>
    </section>
  );
}
