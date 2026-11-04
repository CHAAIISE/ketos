"use client";

import { formatAge, formatUtc, useNow } from "@/components/landing/live-time";
import { Badge } from "@/components/ui/badge";
import { formatPrice, formatUsd } from "@/lib/near/format";
import type { Liquidation } from "@/lib/near/types";
import { cn } from "@/lib/utils";

const th = "px-3 font-normal whitespace-nowrap";

/** Latest liquidations on every market; the signed-in account's rows are tagged. */
export function LiquidationsTable({
  liquidations,
  keeperId,
  accountId,
}: {
  liquidations: readonly Liquidation[];
  keeperId: string | null;
  accountId: string | null;
}) {
  const nowMs = useNow();

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[920px] whitespace-nowrap text-label tabular-nums">
        <thead className="text-tertiary">
          <tr className="h-8">
            <th scope="col" className={cn(th, "text-left")}>Time</th>
            <th scope="col" className={cn(th, "text-left")}>Coin</th>
            <th scope="col" className={cn(th, "text-left")}>Direction</th>
            <th scope="col" className={cn(th, "text-right")}>Size</th>
            <th scope="col" className={cn(th, "text-right")}>Entry → Liq. Price</th>
            <th scope="col" className={cn(th, "text-right")}>To Vault</th>
            <th scope="col" className={cn(th, "text-right")}>Back to Trader</th>
            <th scope="col" className={cn(th, "text-left")}>By</th>
          </tr>
        </thead>
        <tbody className="text-foreground">
          {liquidations.map((l) => (
            <tr key={l.position_id} data-testid={`liquidation-${l.position_id}`} className="h-9 border-t border-border">
              <td className="px-3 text-left text-muted-foreground" title={new Date(l.timestamp_ms).toISOString()}>
                {formatUtc(l.timestamp_ms)}
                <span className="ml-1.5 text-tertiary">{formatAge(l.timestamp_ms, nowMs)}</span>
              </td>
              <th scope="row" className="px-3 text-left font-normal">
                <span className="flex items-center gap-2">
                  {l.market_id}
                  {l.account_id === accountId ? <Badge variant="outline">Yours</Badge> : null}
                </span>
              </th>
              <td className={cn("px-3 text-left", l.side === "long" ? "text-success" : "text-destructive")}>
                {l.side === "long" ? "Long" : "Short"} liquidated
              </td>
              <td className="px-3 text-right">{formatUsd(l.size)}</td>
              <td className="px-3 text-right">
                {formatPrice(l.entry_price)} <span className="text-tertiary">→</span> {formatPrice(l.price)}
              </td>
              <td className="px-3 text-right text-success">+{formatUsd(l.penalty)}</td>
              <td className="px-3 text-right">{formatUsd(l.returned)}</td>
              <td className="px-3 text-left text-muted-foreground">
                {l.liquidator === keeperId ? (
                  "Liquidated by keeper"
                ) : (
                  <span title={l.liquidator}>
                    Liquidated by {l.liquidator.length > 24 ? `${l.liquidator.slice(0, 22)}…` : l.liquidator}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
