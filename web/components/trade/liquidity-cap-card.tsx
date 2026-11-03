"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { formatAge, formatUtc, STALE_AFTER_MS, useNow } from "@/components/landing/live-time";
import { formatUsd } from "@/lib/near/format";
import type { Market } from "@/lib/near/types";
import { cn } from "@/lib/utils";
import { OiBar } from "./oi-bar";

const usd0 = (units: bigint) => formatUsd(units, { maxFractionDigits: 0 });

/** Replaces an order book: how much this market can still take, and where the limit comes from. */
export function LiquidityCapCard({ market }: { market: Market }) {
  const nowMs = useNow();
  const measured = market.depth_measured_at_ms;
  const stale = measured > 0 && nowMs > 0 && nowMs - measured > STALE_AFTER_MS;
  const capped = market.max_oi_per_side < market.hard_cap;

  return (
    <section aria-labelledby="cap-title" className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="cap-title" className="text-ui font-medium text-foreground">
          Liquidity cap
        </h2>
        <span className={cn("text-label tabular-nums text-tertiary", stale && "text-warning")}>
          {measured ? `measured ${formatUtc(measured)} · ${formatAge(measured, nowMs)}` : "not measured yet"}
        </span>
      </div>

      {(["long", "short"] as const).map((side) => {
        const used = side === "long" ? market.oi_long : market.oi_short;
        return (
          <div key={side} className="flex flex-col gap-1.5">
            <div className="flex justify-between text-label">
              <span className={side === "long" ? "text-success" : "text-destructive"}>
                {side === "long" ? "Longs" : "Shorts"}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {usd0(used)} of {usd0(market.max_oi_per_side)}
              </span>
            </div>
            <OiBar used={used} cap={market.max_oi_per_side} />
          </div>
        );
      })}

      <p className="text-label text-muted-foreground">
        {measured ? (
          <>
            NEAR Intents can sell <span className="text-foreground">{usd0(market.exit_capacity)}</span> of{" "}
            {market.id} within 1% right now
            {capped ? ", so that is the most either side can hold." : `; the ${usd0(market.hard_cap)} hard cap applies.`}
          </>
        ) : (
          "No exit-liquidity sample yet: the market opens after the first measurement."
        )}
      </p>
      {stale ? (
        <p role="status" className="text-label text-warning">
          Measurement older than 30 min: new positions are paused until the keeper samples again.
        </p>
      ) : null}
      <Link
        href="/liquidity"
        className="inline-flex w-fit items-center gap-1 text-label text-tertiary transition-colors hover:text-foreground"
      >
        See the measured curve <ArrowRight strokeWidth={1.5} className="size-3" />
      </Link>
    </section>
  );
}
