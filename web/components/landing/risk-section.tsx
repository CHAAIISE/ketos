"use client";

import Link from "next/link";
import { ArrowRight, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Container, Eyebrow } from "@/components/ui/page-shell";
import { useMarkets } from "@/hooks/use-ketos-queries";
import { networkName } from "@/lib/near/config";
import { formatUsd } from "@/lib/near/format";
import { formatExitCapacity, marketDisplayStatus, marketLimitLabel } from "@/lib/near/market-status";
import type { Market } from "@/lib/near/types";
import { cn } from "@/lib/utils";
import { useNow } from "./live-time";

/** Largest open-interest side over the effective admission cap. */
function utilizationBps(market: Market): bigint | null {
  if (market.effective_max_oi_per_side === 0n) return null;
  const exposure = market.oi_long > market.oi_short ? market.oi_long : market.oi_short;
  return (exposure * 10_000n) / market.effective_max_oi_per_side;
}

function Tile({ market, nowMs }: { market: Market; nowMs: number }) {
  const bps = utilizationBps(market);
  const status = marketDisplayStatus(market, nowMs);
  const label = !status.open
    ? status.label
    : bps === null
      ? "No capacity"
      : `${bps / 100n}.${(bps % 100n).toString().padStart(2, "0")}%`;
  const tone = !status.open || bps === null
    ? "border-warning/50 bg-warning/10 text-warning"
    : bps >= 10_000n
      ? "border-destructive/50 bg-destructive/10 text-destructive"
      : bps >= 5_000n
        ? "border-warning/50 bg-warning/10 text-warning"
        : "border-success/50 bg-success/10 text-success";
  return (
    <li
      data-testid={`landing-risk-${market.id}`}
      title={`${market.id}: largest OI side ${formatUsd(market.oi_long > market.oi_short ? market.oi_long : market.oi_short, { maxFractionDigits: 0 })}, effective cap ${formatUsd(market.effective_max_oi_per_side, { maxFractionDigits: 0 })} · ${marketLimitLabel(market)} · admission exit limit ${formatExitCapacity(market)}${market.measured_cap_is_grid_max ? ". Probe grid passed; admission depth may be ramp-limited. See the curve for the largest size probed." : ""}`}
      className={cn("flex min-w-0 flex-col gap-1 rounded-sm border p-3", tone)}
    >
      <span className="truncate text-ui font-medium text-foreground">{market.id}</span>
      <span className="text-ui tabular-nums">{label}</span>
    </li>
  );
}

function Heatmap() {
  const markets = useMarkets();
  const nowMs = useNow();
  if (markets.isPending) {
    return (
      <ul aria-busy className="grid grid-cols-3 gap-1 md:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <li key={i} aria-hidden className="h-16 rounded-sm bg-muted" />
        ))}
      </ul>
    );
  }
  if (markets.isError) {
    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-3 rounded-lg border border-destructive/40 p-4 text-sm md:flex-row md:items-center md:justify-between"
      >
        <span className="text-foreground">
          Utilization unavailable. <span className="text-muted-foreground">The {networkName()} market registry could not be loaded.</span>
        </span>
        <Button variant="outline" size="sm" onClick={() => void markets.refetch()}>
          <RotateCw />
          Retry
        </Button>
      </div>
    );
  }
  return (
    <figure className="flex flex-col gap-4">
      <figcaption className="text-label text-tertiary">
        Utilization: larger side of open interest (total size of open positions) / effective cap per side
      </figcaption>
      <ul className="grid grid-cols-3 gap-1 md:grid-cols-4">
        {markets.data.map((m) => (
          <Tile key={m.id} market={m} nowMs={nowMs} />
        ))}
      </ul>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-label text-tertiary">
        <span className="text-success">Below 50%</span>
        <span className="text-warning">50% to 100%, or entry not ready</span>
        <span className="text-destructive">At capacity</span>
      </p>
    </figure>
  );
}

export function RiskSection() {
  return (
    <section id="risk" aria-labelledby="risk-title" className="scroll-mt-8">
      <Container className="grid gap-12 md:grid-cols-12">
        <div className="flex flex-col items-start gap-4 md:col-span-5">
          <Eyebrow>Risk</Eyebrow>
          <h2 id="risk-title" className="font-display text-title text-foreground">
            See the stress before it happens.
          </h2>
          <p className="text-body text-muted-foreground">
            The risk center shows how much of each market&apos;s effective cap is used, recent measurement history,
            and estimated effects of a 10% to 50% crash on positions and vaults. Cached-price status is not a
            fill guarantee: actions fetch a fresh price when needed and recheck limits.
          </p>
          <Link
            href="/risk"
            className="mt-2 inline-flex items-center gap-1 rounded-sm text-ui text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Open the risk center
            <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        </div>
        <div className="min-w-0 md:col-span-6 md:col-start-7">
          <Heatmap />
        </div>
      </Container>
    </section>
  );
}
