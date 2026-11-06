"use client";

import type { ReactNode } from "react";
import { formatAge, formatUtc, useNow } from "@/components/landing/live-time";
import { useTxToast } from "@/components/app/tx-toast";
import { Term } from "@/components/vault/term";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCancelOrder } from "@/hooks/use-ketos-mutations";
import { formatPrice, formatUsd } from "@/lib/near/format";
import type { HistoryEvent, Order, OrderKind, Position, Side } from "@/lib/near/types";
import { cn } from "@/lib/utils";

const th = "px-3 font-normal whitespace-nowrap";

export const ORDER_KIND_LABEL: Record<OrderKind, string> = {
  limit: "Limit",
  stop_market: "Stop Market",
  take_profit: "Take Profit",
  stop_loss: "Stop Loss",
};

const sideText = (side: Side) => (side === "long" ? "Long" : "Short");
const sideClass = (side: Side) => (side === "long" ? "text-success" : "text-destructive");
const pnlClass = (pnl: bigint) => (pnl > 0n ? "text-success" : pnl < 0n ? "text-destructive" : "text-foreground");

const KEEPER_HINT =
  "Triggered orders are executed by the keeper at the oracle price once it reaches the trigger. There is no price guarantee.";

function Table({ minWidth, head, children }: { minWidth: string; head: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className={cn("w-full whitespace-nowrap text-label tabular-nums", minWidth)}>
        <thead className="text-tertiary">
          <tr className="h-8">{head}</tr>
        </thead>
        <tbody className="text-foreground">{children}</tbody>
      </table>
    </div>
  );
}

function Time({ ms, nowMs }: { ms: number; nowMs: number }) {
  return (
    <td className="px-3 text-left text-muted-foreground" title={new Date(ms).toISOString()}>
      {formatUtc(ms)}
      <span className="ml-1.5 text-tertiary">{formatAge(ms, nowMs)}</span>
    </td>
  );
}

/** Market, side and notional an order acts on; exits read them from their position. */
function orderTarget(order: Order, positions: ReadonlyMap<number, Position>) {
  const request = order.request;
  if (request.kind === "limit" || request.kind === "stop_market") {
    return {
      market: request.market_id,
      direction: `Open ${sideText(request.side)}`,
      side: request.side,
      size: request.margin * BigInt(request.leverage),
      reserved: request.margin,
      mode: request.margin_mode,
    };
  }
  const position = positions.get(request.position_id);
  return {
    market: position?.market_id ?? "—",
    direction: position ? `Close ${sideText(position.side)}` : "Close",
    side: position?.side ?? null,
    size: position?.size ?? null,
    reserved: null,
    mode: position?.margin_mode ?? null,
  };
}

/** Pending Limit, Stop Market, Take Profit and Stop Loss orders, each cancellable. */
export function OpenOrdersTable({ orders, positions }: { orders: readonly Order[]; positions: readonly Position[] }) {
  const nowMs = useNow();
  const cancel = useCancelOrder();
  const { track } = useTxToast();
  const byId = new Map(positions.map((p) => [p.id, p]));

  return (
    <Table
      minWidth="min-w-[880px]"
      head={
        <>
          <th scope="col" className={cn(th, "text-left")}>Time</th>
          <th scope="col" className={cn(th, "text-left")}>Type</th>
          <th scope="col" className={cn(th, "text-left")}>Coin</th>
          <th scope="col" className={cn(th, "text-left")}>Direction</th>
          <th scope="col" className={cn(th, "text-right")}>Size</th>
          <th scope="col" className={cn(th, "text-right")}>
            <Term hint={KEEPER_HINT}>Trigger Price</Term>
          </th>
          <th scope="col" className={cn(th, "text-right")}>Margin Reserved</th>
          <th scope="col" className={cn(th, "text-right")}>Cancel</th>
        </>
      }
    >
      {orders.map((order) => {
        const target = orderTarget(order, byId);
        const label = ORDER_KIND_LABEL[order.request.kind];
        return (
          <tr key={order.id} data-testid={`open-order-${order.id}`} className="h-9 border-t border-border">
            <Time ms={order.created_at_ms} nowMs={nowMs} />
            <td className="px-3 text-left">{label}</td>
            <th scope="row" className="px-3 text-left font-normal">
              {target.market}
            </th>
            <td className={cn("px-3 text-left", target.side && sideClass(target.side))}>
              {target.direction}
              {target.mode === "cross" ? <span className="ml-1.5 text-tertiary">(Cross)</span> : null}
            </td>
            <td className="px-3 text-right">{target.size === null ? "—" : formatUsd(target.size)}</td>
            <td className="px-3 text-right">{formatPrice(order.request.trigger_price)}</td>
            <td className="px-3 text-right">{target.reserved === null ? "—" : formatUsd(target.reserved)}</td>
            <td className="px-3 text-right">
              <Button
                variant="link"
                size="xs"
                className="text-label"
                disabled={cancel.isPending}
                onClick={() =>
                  track(() => cancel.mutateAsync(order.id), {
                    pending: `Cancelling ${label.toLowerCase()} on ${target.market}…`,
                    success: `${label} on ${target.market} cancelled · released collateral returning to your wallet`,
                  })
                }
              >
                {cancel.isPending && cancel.variables === order.id ? "Cancelling…" : "Cancel"}
              </Button>
            </td>
          </tr>
        );
      })}
    </Table>
  );
}

const fillKey = (e: Pick<HistoryEvent, "position_id" | "timestamp_ms">) => `${e.position_id}:${e.timestamp_ms}`;

/** Index of the `order_fill` events by the trade they produced (same position, same block). */
function fillsByTrade(events: readonly HistoryEvent[]): Map<string, HistoryEvent> {
  const fills = new Map<string, HistoryEvent>();
  for (const e of events) if (e.kind === "order_fill") fills.set(fillKey(e), e);
  return fills;
}

const TRADE_LABEL = { open: "Open", close: "Close", liquidation: "Liquidated" } as const;

/** Opens, closes and liquidations, newest first; trades made by a triggered order say so. */
export function TradeHistoryTable({ events }: { events: readonly HistoryEvent[] }) {
  const nowMs = useNow();
  const fills = fillsByTrade(events);
  const trades = events.filter((e) => e.kind === "open" || e.kind === "close" || e.kind === "liquidation");

  return (
    <Table
      minWidth="min-w-[880px]"
      head={
        <>
          <th scope="col" className={cn(th, "text-left")}>Time</th>
          <th scope="col" className={cn(th, "text-left")}>Coin</th>
          <th scope="col" className={cn(th, "text-left")}>Direction</th>
          <th scope="col" className={cn(th, "text-right")}>Price</th>
          <th scope="col" className={cn(th, "text-right")}>Trade Value</th>
          <th scope="col" className={cn(th, "text-right")}>Fee</th>
          <th scope="col" className={cn(th, "text-right")}>
            <Term hint="What the close booked to your margin after fees, borrow and funding.">Closed PnL</Term>
          </th>
          <th scope="col" className={cn(th, "text-left")}>Executed</th>
        </>
      }
    >
      {trades.map((e) => {
        const kind = e.kind as keyof typeof TRADE_LABEL;
        const fill = fills.get(fillKey(e));
        return (
          <tr key={e.sequence} data-testid={`trade-${e.sequence}`} className="h-9 border-t border-border">
            <Time ms={e.timestamp_ms} nowMs={nowMs} />
            <th scope="row" className="px-3 text-left font-normal">
              {e.market_id}
            </th>
            <td className={cn("px-3 text-left", sideClass(e.side))}>
              {TRADE_LABEL[kind]} {sideText(e.side)}
            </td>
            <td className="px-3 text-right">{formatPrice(e.price)}</td>
            <td className="px-3 text-right">{formatUsd(e.size)}</td>
            <td className="px-3 text-right">{formatUsd(e.fees)}</td>
            <td className={cn("px-3 text-right", kind === "open" ? "text-tertiary" : pnlClass(e.realized_pnl))}>
              {kind === "open" ? "—" : formatUsd(e.realized_pnl, { signed: true })}
            </td>
            <td className="px-3 text-left text-muted-foreground">
              {kind === "liquidation" ? (
                "Liquidated by keeper"
              ) : fill ? (
                <Term hint={KEEPER_HINT}>Order #{fill.order_id} · by keeper at oracle price</Term>
              ) : (
                "Market order"
              )}
            </td>
          </tr>
        );
      })}
    </Table>
  );
}

/** Funding settled into positions, newest first: paid amounts negative, received positive. */
export function FundingHistoryTable({ events }: { events: readonly HistoryEvent[] }) {
  const nowMs = useNow();
  return (
    <Table
      minWidth="min-w-[720px]"
      head={
        <>
          <th scope="col" className={cn(th, "text-left")}>Time</th>
          <th scope="col" className={cn(th, "text-left")}>Coin</th>
          <th scope="col" className={cn(th, "text-left")}>Side</th>
          <th scope="col" className={cn(th, "text-right")}>Position Size</th>
          <th scope="col" className={cn(th, "text-right")}>
            <Term hint="Funding booked into the position since its last settlement. Negative: you paid the other side.">Payment</Term>
          </th>
        </>
      }
    >
      {events
        .filter((e) => e.kind === "funding")
        .map((e) => {
          // `funding_payment` is positive when the position paid.
          const received = -e.funding_payment;
          return (
            <tr key={e.sequence} data-testid={`funding-${e.sequence}`} className="h-9 border-t border-border">
              <Time ms={e.timestamp_ms} nowMs={nowMs} />
              <th scope="row" className="px-3 text-left font-normal">
                {e.market_id}
              </th>
              <td className={cn("px-3 text-left", sideClass(e.side))}>{sideText(e.side)}</td>
              <td className="px-3 text-right">{formatUsd(e.size)}</td>
              <td className={cn("px-3 text-right", pnlClass(received))}>{formatUsd(received, { signed: true })}</td>
            </tr>
          );
        })}
    </Table>
  );
}

interface OrderHistoryRow {
  key: string;
  timestampMs: number;
  type: string;
  market: string;
  direction: string;
  side: Side | null;
  size: bigint | null;
  price: ReactNode;
  status: ReactNode;
}

/**
 * Filled orders from the onchain history, plus the ones still waiting. The history records a
 * fill, not its order type: an entry fill is a Limit or Stop Market, an exit fill is a take
 * profit when it closed in profit and a stop loss otherwise.
 */
export function orderHistoryRows(
  events: readonly HistoryEvent[],
  orders: readonly Order[],
  positions: readonly Position[],
): OrderHistoryRow[] {
  const byId = new Map(positions.map((p) => [p.id, p]));
  const trades = new Map<string, HistoryEvent>();
  const entries = new Map<number, HistoryEvent>();
  for (const e of events) {
    if (e.kind === "open") entries.set(e.position_id, e);
    if (e.kind === "open" || e.kind === "close") trades.set(fillKey(e), e);
  }

  const pending: OrderHistoryRow[] = orders.map((order) => {
    const target = orderTarget(order, byId);
    return {
      key: `order-${order.id}`,
      timestampMs: order.created_at_ms,
      type: ORDER_KIND_LABEL[order.request.kind],
      market: target.market,
      direction: target.direction,
      side: target.side,
      size: target.size,
      price: <>Trigger {formatPrice(order.request.trigger_price)}</>,
      status: <Badge variant="outline">Open</Badge>,
    };
  });

  const filled: OrderHistoryRow[] = events
    .filter((e) => e.kind === "order_fill")
    .map((fill) => {
      const trade = trades.get(fillKey(fill));
      const isEntry = trade?.kind === "open";
      let type = isEntry ? "Limit / Stop Market" : "Take Profit / Stop Loss";
      if (!isEntry) {
        const entry = entries.get(fill.position_id);
        if (entry) {
          const gained = fill.side === "long" ? fill.price > entry.price : fill.price < entry.price;
          type = gained ? "Take Profit" : "Stop Loss";
        }
      }
      return {
        key: `fill-${fill.sequence}`,
        timestampMs: fill.timestamp_ms,
        type,
        market: fill.market_id,
        direction: `${isEntry ? "Open" : "Close"} ${sideText(fill.side)}`,
        side: fill.side,
        size: fill.size,
        price: <>Filled {formatPrice(fill.price)}</>,
        status: (
          <Badge variant="success" title={`Order #${fill.order_id} executed by the keeper at the oracle price`}>
            Filled
          </Badge>
        ),
      };
    });

  return [...pending, ...filled].sort((a, b) => b.timestampMs - a.timestampMs);
}

export function OrderHistoryTable({ rows }: { rows: readonly OrderHistoryRow[] }) {
  const nowMs = useNow();
  return (
    <Table
      minWidth="min-w-[820px]"
      head={
        <>
          <th scope="col" className={cn(th, "text-left")}>Time</th>
          <th scope="col" className={cn(th, "text-left")}>Type</th>
          <th scope="col" className={cn(th, "text-left")}>Coin</th>
          <th scope="col" className={cn(th, "text-left")}>Direction</th>
          <th scope="col" className={cn(th, "text-right")}>Size</th>
          <th scope="col" className={cn(th, "text-right")}>
            <Term hint={KEEPER_HINT}>Price</Term>
          </th>
          <th scope="col" className={cn(th, "text-left")}>Status</th>
        </>
      }
    >
      {rows.map((row) => (
        <tr key={row.key} data-testid={`order-history-${row.key}`} className="h-9 border-t border-border">
          <Time ms={row.timestampMs} nowMs={nowMs} />
          <td className="px-3 text-left">{row.type}</td>
          <th scope="row" className="px-3 text-left font-normal">
            {row.market}
          </th>
          <td className={cn("px-3 text-left", row.side && sideClass(row.side))}>{row.direction}</td>
          <td className="px-3 text-right">{row.size === null ? "—" : formatUsd(row.size)}</td>
          <td className="px-3 text-right">{row.price}</td>
          <td className="px-3 text-left">{row.status}</td>
        </tr>
      ))}
    </Table>
  );
}
