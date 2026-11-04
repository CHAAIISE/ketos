import { describe, expect, it } from "vitest";
import type { HistoryEvent, HistoryKind } from "./types";
import { DAY_MS, windowVolume } from "./volume";

const NOW = 1_800_000_000_000;

function event(kind: HistoryKind, size: bigint, timestamp_ms: number): HistoryEvent {
  return {
    sequence: 0,
    kind,
    position_id: 1,
    order_id: null,
    market_id: "NEAR",
    side: "long",
    price: 0n,
    size,
    pnl: 0n,
    realized_pnl: 0n,
    fees: 0n,
    funding_paid: 0n,
    funding_received: 0n,
    funding_payment: 0n,
    timestamp_ms,
  };
}

describe("windowVolume", () => {
  it("counts entry and exit notional only, like the contract's volume totals", () => {
    const history = [
      event("deposit", 900n, NOW - 1_000),
      event("open", 500n, NOW - 1_000),
      event("order_fill", 500n, NOW - 1_000),
      event("funding", 3n, NOW - 500),
      event("close", 500n, NOW - 500),
      event("liquidation", 200n, NOW - 100),
    ];
    expect(windowVolume([history], NOW, 200)).toEqual({ volume: 1_200n, trades: 3, complete: true });
  });

  it("includes the window start and excludes older or future events", () => {
    const history = [
      event("open", 1n, NOW - DAY_MS - 1),
      event("open", 10n, NOW - DAY_MS),
      event("close", 100n, NOW),
      event("close", 1_000n, NOW + 1),
    ];
    expect(windowVolume([history], NOW, 200).volume).toBe(110n);
  });

  it("sums every account", () => {
    const a = [event("open", 7n, NOW - 10)];
    const b = [event("close", 5n, NOW - 10)];
    expect(windowVolume([a, b, []], NOW, 200)).toEqual({ volume: 12n, trades: 2, complete: true });
  });

  it("flags a lower bound when a full ring starts inside the window", () => {
    const full = [event("open", 1n, NOW - 10), event("close", 1n, NOW - 5)];
    expect(windowVolume([full], NOW, 2).complete).toBe(false);
    const fullButOld = [event("open", 1n, NOW - DAY_MS - 10), event("close", 1n, NOW - 5)];
    expect(windowVolume([fullButOld], NOW, 2)).toEqual({ volume: 1n, trades: 1, complete: true });
  });
});
