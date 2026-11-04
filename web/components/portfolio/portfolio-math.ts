import type { CrossAccount, HistoryEvent, Position } from "@/lib/near/types";

export function portfolioTotals({
  freeMargin,
  reservedMargin,
  positions,
  cross,
  vaultValues,
}: {
  freeMargin: bigint;
  reservedMargin: bigint;
  positions: readonly Position[];
  cross: CrossAccount;
  vaultValues: readonly bigint[];
}): { tradingEquity: bigint; totalEquity: bigint; unrealizedPnl: bigint } {
  // Cross equity already includes signed cash and every cross position's net equity.
  let tradingEquity = freeMargin + reservedMargin + cross.equity;
  let unrealizedPnl = 0n;
  for (const position of positions) {
    if (position.margin_mode === "isolated") tradingEquity += position.equity;
    unrealizedPnl += position.unrealized_pnl;
  }
  let totalEquity = tradingEquity;
  for (const value of vaultValues) totalEquity += value;
  return { tradingEquity, totalEquity, unrealizedPnl };
}

export interface PnlPoint {
  timestampMs: number;
  value: bigint;
  sequence: number;
}

/** Absolute all-time booked PnL at retained trading events, without inventing earlier observations. */
export function cumulativePnl(events: readonly HistoryEvent[], total: bigint): PnlPoint[] {
  const trading = events
    .filter((event) => event.kind === "open" || event.kind === "close" || event.kind === "liquidation")
    .sort((a, b) => a.sequence - b.sequence)
    .filter((event, index, sorted) => index === 0 || event.sequence !== sorted[index - 1].sequence);

  // The ring can omit older trades. Their booked result remains in the all-time aggregate.
  let value = total;
  for (const event of trading) value -= event.realized_pnl;

  const points: PnlPoint[] = [];
  for (const event of trading) {
    // Settlement deltas already include opening/closing costs and settled funding exactly once.
    value += event.realized_pnl;
    const point = { timestampMs: event.timestamp_ms, value, sequence: event.sequence };
    if (points.at(-1)?.timestampMs === point.timestampMs) points[points.length - 1] = point;
    else points.push(point);
  }
  return points;
}
