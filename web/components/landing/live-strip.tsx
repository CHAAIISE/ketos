"use client";

import type { ReactNode } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNear } from "@/hooks/near-provider";
import { useMarkets, useVault } from "@/hooks/use-perps-queries";
import { networkName } from "@/lib/near/config";
import { formatUsd, usdcToNumber } from "@/lib/near/format";
import { cn } from "@/lib/utils";
import { FlashValue } from "./flash-value";
import { STALE_AFTER_MS, formatAge, formatUtc, useNow } from "./live-time";

function Cell({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 items-baseline justify-between gap-4 py-4 md:flex-col md:items-start md:justify-start md:gap-2 md:px-6 md:py-0 md:first:pl-0">
      <dt className="text-label text-tertiary">{label}</dt>
      <dd className="flex flex-col items-end gap-1 md:items-start">
        <span className="text-price tabular-nums text-foreground">{children}</span>
        {hint ? <span className="text-label tabular-nums text-tertiary">{hint}</span> : null}
      </dd>
    </div>
  );
}

const LABELS = ["Markets open", "Total exit capacity", "Open interest", "Vault NAV", "Last measurement"];

const stripClass =
  "flex flex-col divide-y divide-border border-y border-border md:flex-row md:divide-x md:divide-y-0 md:py-8";

/** Protocol totals read from `get_markets` and `get_vault`, refreshed while the page is open. */
export function LiveStrip() {
  const { config } = useNear();
  const markets = useMarkets();
  const vault = useVault();
  const nowMs = useNow();

  if (markets.isPending || vault.isPending) {
    return (
      <dl aria-busy className={stripClass}>
        {LABELS.map((label) => (
          <Cell key={label} label={label}>
            <span aria-hidden className="block h-7 w-24 rounded-sm bg-muted" />
          </Cell>
        ))}
      </dl>
    );
  }

  if (markets.isError || vault.isError) {
    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-3 rounded-lg border border-destructive/40 p-4 text-sm md:flex-row md:items-center md:justify-between"
      >
        <span className="text-foreground">
          Live numbers unavailable.{" "}
          <span className="text-muted-foreground">
            The {networkName()} RPC did not answer get_markets or get_vault.
          </span>
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void markets.refetch();
            void vault.refetch();
          }}
        >
          <RotateCw />
          Retry
        </Button>
      </div>
    );
  }

  const list = markets.data;
  const open = list.filter((m) => m.is_open).length;
  const capacity = list.reduce((sum, m) => sum + m.exit_capacity, 0n);
  const openInterest = list.reduce((sum, m) => sum + m.oi_long + m.oi_short, 0n);
  const measuredAt = list.length ? Math.max(...list.map((m) => m.depth_measured_at_ms)) : 0;
  const stale = measuredAt > 0 && nowMs > 0 && nowMs - measuredAt > STALE_AFTER_MS;
  const readAt = Math.max(markets.dataUpdatedAt, vault.dataUpdatedAt);

  return (
    <div className="flex flex-col gap-6">
      <dl className={stripClass}>
        <Cell label={LABELS[0]} hint="BTC · ETH · NEAR · ZEC">
          <FlashValue text={`${open} / ${list.length}`} order={open} />
        </Cell>
        <Cell label={LABELS[1]} hint="sum of the four markets">
          <FlashValue text={formatUsd(capacity, { maxFractionDigits: 0 })} order={usdcToNumber(capacity)} />
        </Cell>
        <Cell label={LABELS[2]} hint="longs + shorts">
          <FlashValue text={formatUsd(openInterest, { maxFractionDigits: 0 })} order={usdcToNumber(openInterest)} />
        </Cell>
        <Cell label={LABELS[3]} hint="USDC">
          <FlashValue text={formatUsd(vault.data.nav)} order={usdcToNumber(vault.data.nav)} />
        </Cell>
        <Cell
          label={LABELS[4]}
          hint={
            measuredAt ? (
              <span className={cn(stale && "text-warning")}>{formatAge(measuredAt, nowMs) || "\u00a0"}</span>
            ) : undefined
          }
        >
          {measuredAt ? formatUtc(measuredAt) : <span className="text-muted-foreground">unavailable</span>}
        </Cell>
      </dl>
      <p className="text-label text-tertiary tabular-nums">
        Read from {config.perpsContract} on {networkName()} at {formatUtc(readAt, true)}, refreshed while this page is open.
      </p>
    </div>
  );
}
