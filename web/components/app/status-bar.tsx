"use client";

import { formatAge, formatUtc, useNow } from "@/components/landing/live-time";
import { useKeeperTick, type KeeperStatus } from "@/hooks/use-keeper-tick";
import { useMarkets } from "@/hooks/use-ketos-queries";
import { cn } from "@/lib/utils";

function keeperText(status: KeeperStatus, nowMs: number): string {
  switch (status.state) {
    case "ran":
      return `Keeper ran ${formatAge(status.atMs, nowMs) || `at ${formatUtc(status.atMs, true)}`}${
        status.liquidated > 0 ? ` · liquidated ${status.liquidated}` : ""
      }`;
    case "running":
      return "Keeper checking every open position…";
    case "unavailable":
      return `Keeper unavailable: ${status.reason}`;
    default:
      return "Keeper runs once a minute while the app is open";
  }
}

/**
 * Thin bar pinned to the bottom of every app page: RPC health, the keeper pass this page asks for
 * once a minute, and the age of the newest exit-liquidity measurement.
 */
export function StatusBar() {
  const markets = useMarkets();
  const keeper = useKeeperTick();
  const nowMs = useNow();
  const online = markets.isSuccess && !markets.isError;
  const measured = markets.data ? Math.max(0, ...markets.data.map((m) => m.depth_measured_at_ms)) : 0;

  return (
    <footer className="sticky bottom-0 z-30 flex h-7 shrink-0 items-center gap-4 overflow-hidden border-t border-border bg-background px-3 text-label whitespace-nowrap text-tertiary">
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
        {markets.isPending ? "Connecting" : online ? "Online" : "Offline"}
      </span>
      <span data-testid="keeper-status" className={cn("truncate", keeper.state === "unavailable" && "text-warning")}>
        {keeperText(keeper, nowMs)}
      </span>
      {measured > 0 ? (
        <span className="hidden truncate sm:inline">
          Exit liquidity measured {formatUtc(measured)}{nowMs ? ` · ${formatAge(measured, nowMs)}` : ""}
        </span>
      ) : null}
    </footer>
  );
}
