import type { HistoryEvent, HistoryKind } from "./types";

export const DAY_MS = 24 * 60 * 60_000;

/** Kinds that add notional to the contract's volume totals; fills, funding and transfers are annotations. */
const ADDS_VOLUME: Record<HistoryKind, boolean> = {
  open: true,
  close: true,
  liquidation: true,
  order_fill: false,
  funding: false,
  deposit: false,
  withdrawal: false,
};

export interface WindowVolume {
  /** Entry and exit notional inside the window, USDC units. */
  volume: bigint;
  trades: number;
  /**
   * False when some account's retained history starts inside the window: its older events
   * were evicted from the ring, so `volume` is a lower bound.
   */
  complete: boolean;
}

/**
 * Sums entry and exit notional of the window ending at `nowMs`, across account histories
 * read with `get_history` (oldest first, at most `retention` events each).
 */
export function windowVolume(
  histories: readonly (readonly HistoryEvent[])[],
  nowMs: number,
  retention: number,
  windowMs = DAY_MS,
): WindowVolume {
  const from = nowMs - windowMs;
  let volume = 0n;
  let trades = 0;
  let complete = true;
  for (const events of histories) {
    if (events.length >= retention && events[0].timestamp_ms >= from) complete = false;
    for (const event of events) {
      if (event.timestamp_ms < from || event.timestamp_ms > nowMs || !ADDS_VOLUME[event.kind]) continue;
      volume += event.size;
      trades += 1;
    }
  }
  return { volume, trades, complete };
}
