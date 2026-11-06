"use client";

import { useState } from "react";
import { ImpactChart } from "@/components/liquidity/impact-chart";
import { Button } from "@/components/ui/button";
import { Container, Eyebrow } from "@/components/ui/page-shell";
import { useDepth, useMarkets } from "@/hooks/use-ketos-queries";
import { formatExitCapacity } from "@/lib/near/market-status";
import { usd0 } from "@/lib/near/format";
import { STALE_AFTER_MS, formatAge, formatUtc, useNow } from "./live-time";

export function ExitLiquidity() {
  const markets = useMarkets();
  const [selected, setSelected] = useState<string | null>(null);
  const id = markets.data?.find((market) => market.id === selected)?.id ?? markets.data?.[0]?.id ?? null;
  const depth = useDepth(id);
  const record = depth.data?.history.at(-1);
  const market = depth.data?.market;
  const now = useNow();
  const stale = record && now > 0 && now - record.measured_at_ms > STALE_AFTER_MS;
  return (
    <section id="liquidity" aria-labelledby="depth-title">
      <Container className="grid max-w-landing gap-8 md:grid-cols-12 md:px-12">
        <div className="flex flex-col items-start gap-4 md:col-span-4">
          <Eyebrow>Measured, not assumed</Eyebrow>
          <h2 id="depth-title" className="font-display text-title">How much can the exit take?</h2>
          <p className="text-body text-muted-foreground">Real NEAR Intents sell quotes show how price impact changes with size. The first missing quote or impact above 100 bps ends the measured range.</p>
          <label htmlFor="landing-depth-asset" className="text-label text-muted-foreground">Select a market</label>
          <select id="landing-depth-asset" value={id ?? ""} onChange={(event) => setSelected(event.target.value)} disabled={!markets.data?.length} className="h-10 w-full rounded-md border border-border bg-input px-3 text-ui focus-visible:outline-2 focus-visible:outline-ring">
            {!markets.data?.length ? <option value="">{markets.isPending ? "Loading markets…" : "No market available"}</option> : markets.data.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}
          </select>
          {record && market ? <dl className="flex flex-col gap-3 text-ui tabular-nums">
            <div><dt className="text-label text-tertiary">Measured exit depth</dt><dd className="text-heading">{formatExitCapacity(market, record)}</dd></div>
            <div><dt className="text-label text-tertiary">Admitted exit limit</dt><dd>{usd0(market.exit_capacity)}</dd></div>
            <div><dt className="text-label text-tertiary">Effective cap / side</dt><dd>{usd0(market.effective_max_oi_per_side)}</dd></div>
          </dl> : null}
          <p className="text-label text-tertiary">Quotes are nonbinding, not guaranteed fills. Admission can ramp below measured depth; the effective cap also respects vault capital and protocol limits.</p>
        </div>
        <figure className="min-w-0 rounded-lg border border-border bg-card p-4 md:col-span-8 md:p-6">
          <figcaption className="flex flex-col gap-2 text-label text-muted-foreground">
            <span>{id ?? "Market"} · Price impact (bps) / sell size (USD, log scale)</span>
            {record ? <span className={stale ? "text-warning" : "text-tertiary"}>Measured {formatUtc(record.measured_at_ms)} · {formatAge(record.measured_at_ms, now)}{stale ? " · stale, new entries paused" : ""}</span> : null}
          </figcaption>
          {markets.isPending || (id && depth.isPending) ? <div aria-busy="true" className="flex h-96 items-center justify-center text-ui text-muted-foreground"><span role="status">Loading measured depth…</span></div> : record ? <ImpactChart record={record} /> : <div role="status" className="flex h-96 flex-col items-start justify-center gap-4 text-ui text-muted-foreground"><p>{markets.isError || depth.isError ? "Last measurement unavailable." : "No depth measurement yet. This read-only page does not start the keeper."}</p>{markets.isError || depth.isError ? <Button size="sm" variant="outline" onClick={() => { void markets.refetch(); if (id) void depth.refetch(); }}>Retry</Button> : null}</div>}
          {record && depth.isError ? <p role="status" className="text-label text-warning">Refresh failed. The last timestamped measurement remains visible.</p> : null}
          <p className="text-label text-tertiary">Line and dots: measured quotes. Dashed amber: 100 bps (1%) limit. Crosses: no quote. ≥ capacity means the largest size probed passed.</p>
        </figure>
      </Container>
    </section>
  );
}
