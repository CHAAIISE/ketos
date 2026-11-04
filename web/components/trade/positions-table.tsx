"use client";

import { useState } from "react";
import { useTxToast } from "@/components/app/tx-toast";
import { Term } from "@/components/vault/term";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useClosePosition, useSwitchToCross } from "@/hooks/use-ketos-mutations";
import { formatPrice, formatUnits, formatUsd, PRICE_DECIMALS, USDC_DECIMALS } from "@/lib/near/format";
import { isLiquidatable, type Order, type Position } from "@/lib/near/types";
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

/** Position size in the asset: notional (USDC) ÷ entry price, e.g. "125.0000 NEAR". */
function assetSize(p: Position): string {
  const units = (p.size * 10n ** BigInt(PRICE_DECIMALS)) / p.entry_price;
  return `${formatUnits(units, USDC_DECIMALS, { maxFractionDigits: 4, minFractionDigits: 4 })} ${p.market_id}`;
}

/** Notional at the mark price: asset size × mark. */
function positionValue(p: Position): bigint {
  return (p.size * p.mark_price) / p.entry_price;
}

const pnlClass = (pnl: bigint) => (pnl > 0n ? "text-success" : pnl < 0n ? "text-destructive" : "text-foreground");

const th = "px-2 font-normal whitespace-nowrap";
const td = "px-2 text-right";

/** Open positions: a table from tablet width, stacked cards on phones so Close stays in reach. */
export function PositionsTable({ positions, orders, allowSwitchToCross = false }: { positions: readonly Position[]; orders: readonly Order[]; allowSwitchToCross?: boolean }) {
  const close = useClosePosition();
  const switchMode = useSwitchToCross();
  const { track } = useTxToast();
  const [switchPosition, setSwitchPosition] = useState<Position | null>(null);
  const triggers = new Map(orders.map((o) => [o.id, o.request.trigger_price]));

  const bracket = (id: number | null) => {
    const price = id === null ? undefined : triggers.get(id);
    return price === undefined ? "—" : formatPrice(price);
  };
  const tpsl = (p: Position) => (
    <span data-testid={`brackets-${p.id}`}>
      <span className="text-success">{bracket(p.take_profit)}</span>
      <span className="text-tertiary"> / </span>
      <span className="text-destructive">{bracket(p.stop_loss)}</span>
    </span>
  );
  // `funding_payment` is positive when the position pays; sub-cent amounts display as $0.00 and stay neutral.
  const fundingValue = (p: Position) => {
    const visible = p.funding_payment >= 5_000n || p.funding_payment <= -5_000n;
    return (
      <span className={!visible ? undefined : p.funding_payment > 0n ? "text-destructive" : "text-success"}>
        {formatUsd(-p.funding_payment, { signed: true })}
      </span>
    );
  };
  const liqValue = (p: Position) =>
    p.margin_mode === "cross" ? (
      <Term hint="Cross positions share one margin pool: the pool is liquidated when its equity falls to its maintenance margin, not at a price of this position alone.">
        Cross
      </Term>
    ) : (
      formatPrice(p.liquidation_price)
    );
  const modeLabel = (p: Position) => (p.margin_mode === "cross" ? "(Cross)" : "(Isolated)");
  const marginMode = (p: Position) => allowSwitchToCross && p.margin_mode === "isolated" ? (
    <Button
      variant="link"
      size="xs"
      className="text-label"
      disabled={switchMode.isPending || close.isPending}
      title="Move this position's collateral into the shared cross pool. This cannot be undone."
      onClick={() => setSwitchPosition(p)}
    >
      {switchMode.isPending && switchMode.variables === p.id ? "Switching…" : "Switch to Cross"}
    </Button>
  ) : <span className="text-tertiary">{modeLabel(p)}</span>;

  const closeButton = (p: Position) => {
    const payout = closePayout(p);
    return (
      <Button
        variant="link"
        size="xs"
        className="text-label"
        disabled={close.isPending || switchMode.isPending}
        title={p.margin_mode === "cross" ? "Market close: profit or loss settles into your shared cross pool" : `Market close: about ${formatUsd(payout)} returns to your free margin`}
        onClick={() =>
          track(() => close.mutateAsync(p.id), {
            pending: `Closing ${p.side} ${p.market_id}…`,
            success: (r) =>
              p.margin_mode === "cross"
                ? `${p.side === "long" ? "Long" : "Short"} ${p.market_id} closed · settled into cross margin`
                : `${p.side === "long" ? "Long" : "Short"} ${p.market_id} closed · ${formatUsd(r.payout ?? payout)} back to margin`,
          })
        }
      >
        {close.isPending && close.variables === p.id ? "Closing…" : "Close"}
      </Button>
    );
  };

  const coin = (p: Position) => (
    <span className="flex items-center gap-2">
      <span className={p.side === "long" ? "text-success" : "text-destructive"}>{p.market_id}</span>
      <Badge variant={p.side === "long" ? "success" : "destructive"}>
        {p.side === "long" ? "Long" : "Short"} {p.leverage}×
      </Badge>
      {isLiquidatable(p) ? <Badge variant="warning">Liquidating</Badge> : null}
    </span>
  );

  const liqTerm = (
    <Term hint="If the oracle price reaches this level, the position can be closed by anyone and loses its margin.">
      Liq. Price
    </Term>
  );
  const feesTerm = (
    <Term hint="Hourly borrow fee accrued so far, plus the 0.1% fee charged when the position closes. Both go to the vault.">
      Fees
    </Term>
  );
  const fundingTerm = (
    <Term hint="Funding accrued since opening: positive when you receive it, negative when you pay. Settled when the position closes.">
      Funding
    </Term>
  );
  const tpslTerm = (
    <Term hint="Take profit / stop loss trigger prices, executed by the keeper at the oracle price.">TP / SL</Term>
  );
  const pnl = (p: Position) => (
    <span className={pnlClass(p.unrealized_pnl)}>
      {formatUsd(p.unrealized_pnl, { signed: true })} ({roe(p)})
    </span>
  );

  return (
    <>
      <ul className="flex flex-col md:hidden">
        {positions.map((p) => (
          <li key={p.id} data-testid={`position-card-${p.id}`} className="flex flex-col gap-3 border-t border-border px-3 py-3 first:border-t-0">
            <div className="flex items-center justify-between gap-3 text-ui">
              {coin(p)}
              {closeButton(p)}
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-label">
              {(
                [
                  ["PNL (ROE %)", pnl(p)],
                  ["Size", assetSize(p)],
                  ["Position Value", formatUsd(positionValue(p))],
                  ["Entry Price", formatPrice(p.entry_price)],
                  ["Mark Price", formatPrice(p.mark_price)],
                  [liqTerm, <span key="liq" className="text-warning">{liqValue(p)}</span>],
                  ["Margin", <span key="margin">{formatUsd(p.margin)} {marginMode(p)}</span>],
                  [fundingTerm, fundingValue(p)],
                  [tpslTerm, tpsl(p)],
                  [feesTerm, formatUsd(p.borrow_fee + p.close_fee)],
                ] as const
              ).map(([label, value], i) => (
                <div key={i} className="flex flex-col gap-0.5">
                  <dt className="text-tertiary">{label}</dt>
                  <dd className="tabular-nums text-foreground">{value}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[1040px] text-label tabular-nums">
          <thead className="text-tertiary">
            <tr className="h-8">
              <th scope="col" className={cn(th, "text-left")}>Coin</th>
              <th scope="col" className={cn(th, "text-right")}>Size</th>
              <th scope="col" className={cn(th, "text-right")}>Position Value</th>
              <th scope="col" className={cn(th, "text-right")}>Entry Price</th>
              <th scope="col" className={cn(th, "text-right")}>Mark Price</th>
              <th scope="col" className={cn(th, "text-right")}>PNL (ROE %)</th>
              <th scope="col" className={cn(th, "text-right")}>{liqTerm}</th>
              <th scope="col" className={cn(th, "text-right")}>Margin</th>
              <th scope="col" className={cn(th, "text-right")}>{fundingTerm}</th>
              <th scope="col" className={cn(th, "text-right")}>{tpslTerm}</th>
              <th scope="col" className={cn(th, "text-right")}>{feesTerm}</th>
              <th scope="col" className={cn(th, "text-right")}>Close</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={p.id} data-testid={`position-${p.id}`} className="h-9 border-t border-border whitespace-nowrap text-foreground">
                <th scope="row" className="px-2 text-left font-normal">
                  {coin(p)}
                </th>
                <td className={td}>{assetSize(p)}</td>
                <td className={td}>{formatUsd(positionValue(p))}</td>
                <td className={td}>{formatPrice(p.entry_price)}</td>
                <td className={td}>{formatPrice(p.mark_price)}</td>
                <td className={td}>{pnl(p)}</td>
                <td className={cn(td, "text-warning")}>{liqValue(p)}</td>
                <td className={td}>{formatUsd(p.margin)} {marginMode(p)}</td>
                <td className={td}>{fundingValue(p)}</td>
                <td className={td}>{tpsl(p)}</td>
                <td className={td}>{formatUsd(p.borrow_fee + p.close_fee)}</td>
                <td className={td}>{closeButton(p)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Modal open={switchPosition !== null} onOpenChange={(open) => { if (!open && !switchMode.isPending) setSwitchPosition(null); }} title="Switch to Cross">
        <p className="text-ui text-muted-foreground">
          Move {switchPosition?.market_id}&apos;s collateral into your shared cross pool. All cross positions share gains and losses and can put each other&apos;s collateral at risk. Entry price and TP/SL stay unchanged. You cannot switch back to isolated.
        </p>
        <Button
          className="mt-4 w-full"
          disabled={switchMode.isPending}
          onClick={async () => {
            if (!switchPosition) return;
            const done = await track(() => switchMode.mutateAsync(switchPosition.id), {
              pending: `Moving ${switchPosition.market_id} into cross margin…`,
              success: `${switchPosition.market_id} now shares cross margin · entry and TP/SL unchanged`,
            });
            if (done) setSwitchPosition(null);
          }}
        >
          {switchMode.isPending ? "Switching…" : "Confirm switch to Cross"}
        </Button>
      </Modal>
    </>
  );
}
