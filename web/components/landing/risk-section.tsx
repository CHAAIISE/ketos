"use client";

import Link from "next/link";
import { ArrowRight, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Container, Eyebrow } from "@/components/ui/page-shell";
import { useMarkets } from "@/hooks/use-ketos-queries";
import { networkName } from "@/lib/near/config";
import { formatUsd } from "@/lib/near/format";
import { isMeasuring, type Market } from "@/lib/near/types";
import { cn } from "@/lib/utils";
import { STALE_AFTER_MS, useNow } from "./live-time";

/** Larger side of open interest over measured exit capacity, in bps; null when nothing is measured. */
function utilizationBps(market: Market): bigint | null {
  if (market.exit_capacity === 0n) return null;
  const exposure = market.oi_long > market.oi_short ? market.oi_long : market.oi_short;
  return (exposure * 10_000n) / market.exit_capacity;
}

function Tile({ market, nowMs }: { market: Market; nowMs: number }) {
  const bps = utilizationBps(market);
  const stale = !isMeasuring(market) && nowMs > 0 && nowMs - market.depth_measured_at_ms > STALE_AFTER_MS;
  const label = isMeasuring(market)
    ? "Measuring"
    : stale
      ? "Stale sample"
      : bps === null
        ? "No capacity"
        : `${bps / 100n}.${(bps % 100n).toString().padStart(2, "0")}%`;
  const tone = isMeasuring(market)
    ? "border-border bg-muted text-muted-foreground"
    : stale || bps === null
      ? "border-warning/50 bg-warning/10 text-warning"
      : bps >= 10_000n
        ? "border-destructive/50 bg-destructive/10 text-destructive"
        : bps >= 5_000n
          ? "border-warning/50 bg-warning/10 text-warning"
          : "border-success/50 bg-success/10 text-success";
  return (
    <li
      data-testid={`landing-risk-${market.id}`}
      title={`${market.id}: open interest ${formatUsd(market.oi_long + market.oi_short, { maxFractionDigits: 0 })}, exit capacity ${formatUsd(market.exit_capacity, { maxFractionDigits: 0 })}`}
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
          Utilization unavailable. <span className="text-muted-foreground">The {networkName()} RPC did not answer get_markets.</span>
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
        Utilization now: larger side of open interest / measured exit capacity
      </figcaption>
      <ul className="grid grid-cols-3 gap-1 md:grid-cols-4">
        {markets.data.map((m) => (
          <Tile key={m.id} market={m} nowMs={nowMs} />
        ))}
      </ul>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-label text-tertiary">
        <span className="text-success">Below 50%</span>
        <span className="text-warning">50% to 100%, or stale</span>
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
            The risk center shows how much of each market&apos;s exit is already used, how capacity moved over the
            last 24 hours, and what a 10% to 50% crash would do: which positions liquidate, isolated and cross, and
            what each vault would be left owing.
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
