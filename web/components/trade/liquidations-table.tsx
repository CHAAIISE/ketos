"use client";

import { formatAge, formatUtc, useNow } from "@/components/landing/live-time";
import { Badge } from "@/components/ui/badge";
import { formatPrice, formatUsd } from "@/lib/near/format";
import type { Liquidation } from "@/lib/near/types";

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
      <table className="w-full min-w-[880px] whitespace-nowrap text-ui">
        <thead className="bg-muted text-label text-tertiary">
          <tr className="h-8">
            <th scope="col" className="px-4 text-left font-normal">Time</th>
            <th scope="col" className="px-4 text-left font-normal">Position</th>
            <th scope="col" className="px-4 text-right font-normal">Size</th>
            <th scope="col" className="px-4 text-right font-normal">Entry → liquidated at</th>
            <th scope="col" className="px-4 text-right font-normal">To vault</th>
            <th scope="col" className="px-4 text-right font-normal">Back to trader</th>
            <th scope="col" className="px-4 text-left font-normal">By</th>
          </tr>
        </thead>
        <tbody>
          {liquidations.map((l) => (
            <tr key={l.position_id} data-testid={`liquidation-${l.position_id}`} className="h-12 border-t border-border">
              <td className="px-4 text-left tabular-nums text-muted-foreground" title={new Date(l.timestamp_ms).toISOString()}>
                {formatUtc(l.timestamp_ms)}
                <span className="ml-1.5 text-label text-tertiary">{formatAge(l.timestamp_ms, nowMs)}</span>
              </td>
              <th scope="row" className="px-4 text-left font-medium">
                <div className="flex items-center gap-2">
                  <span className="text-foreground">{l.market_id}-PERP</span>
                  <span className={l.side === "long" ? "text-success" : "text-destructive"}>
                    {l.side === "long" ? "Long" : "Short"}
                  </span>
                  {l.account_id === accountId ? <Badge variant="outline">Yours</Badge> : null}
                </div>
              </th>
              <td className="px-4 text-right tabular-nums">{formatUsd(l.size)}</td>
              <td className="px-4 text-right tabular-nums">
                {formatPrice(l.entry_price)} <span className="text-tertiary">→</span>{" "}
                <span className="text-foreground">{formatPrice(l.price)}</span>
              </td>
              <td className="px-4 text-right tabular-nums text-success">+{formatUsd(l.penalty)}</td>
              <td className="px-4 text-right tabular-nums">{formatUsd(l.returned)}</td>
              <td className="px-4 text-left text-muted-foreground">
                {l.liquidator === keeperId ? (
                  "Liquidated by keeper"
                ) : (
                  <span title={l.liquidator}>Liquidated by {l.liquidator.length > 24 ? `${l.liquidator.slice(0, 22)}…` : l.liquidator}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
