"use client";

import { useNow } from "@/components/landing/live-time";
import { Badge } from "@/components/ui/badge";
import { formatPrice, formatUsd } from "@/lib/near/format";
import type { Market, MarketId } from "@/lib/near/types";
import { cn } from "@/lib/utils";
import { marketStatus } from "./market-status";
import { OiBar } from "./oi-bar";

const usd0 = (units: bigint) => formatUsd(units, { maxFractionDigits: 0 });

function SideCell({ used, cap, tone }: { used: bigint; cap: bigint; tone: "long" | "short" }) {
  return (
    <div className="ml-auto flex w-32 flex-col items-end gap-1.5">
      <span className="tabular-nums">
        <span className={tone === "long" ? "text-success" : "text-destructive"}>{usd0(used)}</span>
        <span className="text-tertiary"> / {usd0(cap)}</span>
      </span>
      <OiBar used={used} cap={cap} />
    </div>
  );
}

/** Every market with its live cap; picking a row selects it in the ticket. */
export function MarketsTable({
  markets,
  selected,
  onSelect,
}: {
  markets: readonly Market[];
  selected: MarketId;
  onSelect: (id: MarketId) => void;
}) {
  const nowMs = useNow();

  return (
    <section aria-labelledby="markets-title" className="flex flex-col rounded-lg border border-border bg-card">
      <div className="flex items-baseline justify-between gap-4 px-4 py-3">
        <h2 id="markets-title" className="text-ui font-medium text-foreground">
          Markets
        </h2>
        <p className="text-label text-tertiary">
          Caps per side = min(hard cap, size that sells within 1% on NEAR Intents)
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] whitespace-nowrap text-ui">
          <thead className="bg-muted text-label text-tertiary">
            <tr className="h-8">
              <th scope="col" className="px-4 text-left font-normal">Market</th>
              <th scope="col" className="px-4 text-right font-normal">Oracle price</th>
              <th scope="col" className="px-4 text-right font-normal">Exit capacity</th>
              <th scope="col" className="px-4 text-right font-normal">Max lev.</th>
              <th scope="col" className="px-4 text-right font-normal">Long OI / cap</th>
              <th scope="col" className="px-4 text-right font-normal">Short OI / cap</th>
              <th scope="col" className="px-4 text-right font-normal">Status</th>
            </tr>
          </thead>
          <tbody>
            {markets.map((m) => {
              const status = marketStatus(m, nowMs);
              const active = m.id === selected;
              return (
                <tr
                  key={m.id}
                  data-testid={`market-row-${m.id}`}
                  aria-selected={active}
                  onClick={() => onSelect(m.id)}
                  className={cn(
                    "h-12 cursor-pointer border-t border-border transition-colors hover:bg-muted/60",
                    active && "bg-muted/60",
                  )}
                >
                  <th scope="row" className="px-4 text-left font-medium">
                    <button
                      type="button"
                      onClick={() => onSelect(m.id)}
                      className={cn(
                        "rounded-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring",
                        active && "text-foreground",
                      )}
                    >
                      {m.id}-PERP
                    </button>
                  </th>
                  <td className="px-4 text-right tabular-nums text-foreground">
                    {m.price > 0n ? formatPrice(m.price) : "—"}
                  </td>
                  <td className="px-4 text-right tabular-nums">{usd0(m.exit_capacity)}</td>
                  <td className="px-4 text-right tabular-nums">{m.max_leverage}×</td>
                  <td className="px-4">
                    <SideCell used={m.oi_long} cap={m.max_oi_per_side} tone="long" />
                  </td>
                  <td className="px-4">
                    <SideCell used={m.oi_short} cap={m.max_oi_per_side} tone="short" />
                  </td>
                  <td className="px-4 text-right">
                    {status.open ? (
                      <Badge variant="success">Open</Badge>
                    ) : (
                      <Badge variant="warning" title={status.label}>
                        Closed
                      </Badge>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
