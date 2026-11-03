"use client";

import { useTxToast } from "@/components/app/tx-toast";
import { Term } from "@/components/vault/term";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useClosePosition } from "@/hooks/use-perps-mutations";
import { formatPrice, formatUsd } from "@/lib/near/format";
import { isLiquidatable, type Position } from "@/lib/near/types";
import { cn } from "@/lib/utils";

/** What closing now would credit to free margin: equity minus the closing fee, never below zero. */
function closePayout(position: Pick<Position, "equity" | "close_fee">): bigint {
  const owed = position.equity - position.close_fee;
  return owed > 0n ? owed : 0n;
}

/** Unrealized PnL as a share of the posted margin, one decimal, e.g. "+12.4%". */
function roe(position: Position): string {
  if (position.margin === 0n) return "";
  const tenths = (position.unrealized_pnl * 1000n) / position.margin;
  const sign = tenths > 0n ? "+" : tenths < 0n ? "-" : "";
  const abs = tenths < 0n ? -tenths : tenths;
  return `${sign}${abs / 10n}.${abs % 10n}%`;
}

const pnlClass = (pnl: bigint) => (pnl > 0n ? "text-success" : pnl < 0n ? "text-destructive" : "text-foreground");

/** Open positions: a table from tablet width, stacked cards on phones so Close stays in reach. */
export function PositionsTable({ positions }: { positions: readonly Position[] }) {
  const close = useClosePosition();
  const { track } = useTxToast();

  const closeButton = (p: Position) => {
    const payout = closePayout(p);
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={close.isPending}
        title={`About ${formatUsd(payout)} returns to your free margin`}
        onClick={() =>
          track(() => close.mutateAsync(p.id), {
            pending: `Closing ${p.side} ${p.market_id}…`,
            success: (r) =>
              `${p.side === "long" ? "Long" : "Short"} ${p.market_id} closed · ${formatUsd(r.payout ?? payout)} back to margin`,
          })
        }
      >
        {close.isPending && close.variables === p.id ? "Closing…" : "Close"}
      </Button>
    );
  };

  const title = (p: Position) => (
    <div className="flex items-center gap-2">
      <span className="text-foreground">{p.market_id}-PERP</span>
      <span className={p.side === "long" ? "text-success" : "text-destructive"}>
        {p.side === "long" ? "Long" : "Short"} {p.leverage}×
      </span>
      {isLiquidatable(p) ? <Badge variant="warning">Liquidating</Badge> : null}
    </div>
  );

  const liqTerm = (
    <Term hint="If the oracle price reaches this level, the position can be closed by anyone and loses its margin.">
      Liq. price
    </Term>
  );
  const feesTerm = (
    <Term hint="Hourly borrow fee accrued so far, plus the 0.1% fee charged when the position closes. Both go to the vault.">
      Fees
    </Term>
  );

  return (
    <>
      <ul className="flex flex-col md:hidden">
        {positions.map((p) => (
          <li key={p.id} data-testid={`position-card-${p.id}`} className="flex flex-col gap-3 border-t border-border px-3 py-3">
            <div className="flex items-center justify-between gap-3 text-ui font-medium">
              {title(p)}
              {closeButton(p)}
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-ui">
              {(
                [
                  ["PnL", <span key="pnl" className={pnlClass(p.unrealized_pnl)}>{formatUsd(p.unrealized_pnl, { signed: true })} <span className="text-label">{roe(p)}</span></span>],
                  ["Size", formatUsd(p.size)],
                  ["Entry", formatPrice(p.entry_price)],
                  ["Mark", formatPrice(p.mark_price)],
                  [liqTerm, <span key="liq" className="text-warning">{formatPrice(p.liquidation_price)}</span>],
                  ["Margin", formatUsd(p.margin)],
                  [feesTerm, formatUsd(p.borrow_fee + p.close_fee)],
                ] as const
              ).map(([label, value], i) => (
                <div key={i} className="flex flex-col gap-0.5">
                  <dt className="text-label text-tertiary">{label}</dt>
                  <dd className="tabular-nums text-foreground">{value}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>

      <div className="relative hidden overflow-x-auto md:block">
        <table className="w-full min-w-[880px] whitespace-nowrap text-ui">
          <thead className="bg-muted text-label text-tertiary">
            <tr className="h-8">
              <th scope="col" className="px-4 text-left font-normal">Market</th>
              <th scope="col" className="px-4 text-right font-normal">Size</th>
              <th scope="col" className="px-4 text-right font-normal">Entry</th>
              <th scope="col" className="px-4 text-right font-normal">Mark</th>
              <th scope="col" className="px-4 text-right font-normal">{liqTerm}</th>
              <th scope="col" className="px-4 text-right font-normal">Margin</th>
              <th scope="col" className="px-4 text-right font-normal">PnL</th>
              <th scope="col" className="px-4 text-right font-normal">{feesTerm}</th>
              <th scope="col" className="px-4 text-right font-normal">
                <span className="sr-only">Close</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={p.id} data-testid={`position-${p.id}`} className="h-14 border-t border-border">
                <th scope="row" className="px-4 text-left font-medium">
                  {title(p)}
                </th>
                <td className="px-4 text-right tabular-nums">{formatUsd(p.size)}</td>
                <td className="px-4 text-right tabular-nums">{formatPrice(p.entry_price)}</td>
                <td className="px-4 text-right tabular-nums text-foreground">{formatPrice(p.mark_price)}</td>
                <td className="px-4 text-right tabular-nums text-warning">{formatPrice(p.liquidation_price)}</td>
                <td className="px-4 text-right tabular-nums">{formatUsd(p.margin)}</td>
                <td className={cn("px-4 text-right tabular-nums", pnlClass(p.unrealized_pnl))}>
                  {formatUsd(p.unrealized_pnl, { signed: true })}
                  <span className="ml-1.5 text-label">{roe(p)}</span>
                </td>
                <td className="px-4 text-right tabular-nums">{formatUsd(p.borrow_fee + p.close_fee)}</td>
                <td className="px-4 text-right">{closeButton(p)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
