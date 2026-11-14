"use client";

import { formatAge, formatUtc, STALE_AFTER_MS, useNow } from "@/components/landing/live-time";
import { useMarkets } from "@/hooks/use-ketos-queries";
import { cn } from "@/lib/utils";

export function StatusBar() {
  const markets = useMarkets();
  const nowMs = useNow();
  const online = markets.isSuccess && !markets.isError;
  const measured = markets.data ? Math.max(0, ...markets.data.map((m) => m.depth_measured_at_ms)) : 0;
  const active = markets.data?.filter((market) => market.oi_long > 0n || market.oi_short > 0n) ?? [];
  const stale = active.filter((market) => market.price <= 0n || market.price_timestamp_ms <= 0
    || market.price_timestamp_ms > nowMs || nowMs - market.price_timestamp_ms > 30_000);

  return (
    <footer className="sticky bottom-0 z-20 flex h-7 shrink-0 items-center gap-4 overflow-hidden border-t border-border bg-background px-3 text-label whitespace-nowrap text-tertiary">
      <span
        data-testid="rpc-status"
        className={cn(
          "inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-px",
          markets.isPending
            ? "border-border text-tertiary"
            : online
              ? "border-success/40 text-success"
              : "border-destructive/40 text-destructive",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "size-1.5 rounded-pill",
            markets.isPending ? "bg-tertiary" : online ? "bg-success" : "bg-destructive",
          )}
        />
        {markets.isPending ? "RPC connecting" : online ? "RPC connected" : "RPC unavailable"}
      </span>
      <span data-testid="keeper-status" className={cn("truncate", stale.length > 0 && "text-warning")}>
        {!online || !nowMs ? "Risk observations unavailable"
          : stale.length > 0 ? `Stale risk prices · ${stale.map((market) => market.id).join(", ")}`
          : active.length > 0 ? `Active risk prices fresh · ${active.length} markets`
          : "No open interest · prices refreshed on trade"}
      </span>
      {measured > 0 ? (
        <span className={cn("hidden truncate sm:inline", nowMs > 0 && nowMs - measured > STALE_AFTER_MS && "text-warning")}>
          Exit liquidity: latest of {markets.data?.length ?? 0} markets · {formatUtc(measured)}{nowMs ? ` · ${formatAge(measured, nowMs)}` : ""}
        </span>
      ) : null}
    </footer>
  );
}
