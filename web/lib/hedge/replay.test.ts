import { expect, it } from "vitest";
import { replayHedge, REPLAY_SCENARIOS, REPLAY_ASSUMPTIONS as a } from "./replay";

it("flat prices lose only execution rounding and declared costs, not transferred principal", () => {
  const result = replayHedge(REPLAY_SCENARIOS[0]);
  expect(result.hedgePnl).toBeLessThanOrEqual(-result.tradingCosts);
  expect(result.hedgePnl).toBeGreaterThanOrEqual(-result.tradingCosts - BigInt(result.fills));
  expect(result.netPnlAfterOperatingCosts).toBe(result.unhedgedPnl + result.hedgePnl - result.operatorGasUsd - result.extraDataCost);
});
it("shows both protection on a rise and the loss of upside on a fall", () => {
  const up = replayHedge(REPLAY_SCENARIOS[1]);
  const down = replayHedge(REPLAY_SCENARIOS[2]);
  expect(up.netPnlAfterOperatingCosts).toBeGreaterThan(up.unhedgedPnl);
  expect(down.netPnlAfterOperatingCosts).toBeLessThan(down.unhedgedPnl);
});
it("exposes gap over-hedging when trader losses stop at posted margin", () => {
  const result = replayHedge(REPLAY_SCENARIOS[3]);
  expect(result.unhedgedPnl).toBe(a.traderMargin);
  expect(result.fundingCollected).toBe(0n);
  expect(result.netPnlAfterOperatingCosts).toBeLessThan(-5_000_000n);
});
it("excludes all pending custody capital and never schedules a replacement order", () => {
  const result = replayHedge(REPLAY_SCENARIOS[6]);
  expect(result.pending).toBe(true);
  expect(result.conservativeNav).toBe(a.vaultCash + result.unhedgedPnl - a.capital);
  const first = result.points.findIndex((point) => point.pending);
  expect(result.points.slice(first + 1).every((point) => point.action === "held")).toBe(true);
  expect(result.residualInventory).toBeGreaterThan(0n);
});
it("charges failed attempts and respects cash, inventory and per-order bounds", () => {
  for (const scenario of REPLAY_SCENARIOS) {
    const result = replayHedge(scenario);
    let cash = a.capital;
    let inventory = 0n;
    for (const point of result.points) {
      expect(point.cash).toBeGreaterThanOrEqual(0n);
      expect(point.inventory).toBeGreaterThanOrEqual(0n);
      if (point.action === "buy") expect(cash - point.cash).toBeLessThanOrEqual(a.maxOrder);
      if (point.action === "sell") expect((inventory - point.inventory) * point.price / (10n ** 26n)).toBeLessThanOrEqual(a.maxOrder);
      if (point.action === "missed") { expect(point.cash).toBe(cash); expect(point.inventory).toBe(inventory); }
      cash = point.cash; inventory = point.inventory;
    }
    const attempts = result.points.filter((point) => point.action !== "held").length;
    expect(result.operatorGasYocto).toBeGreaterThanOrEqual(BigInt(attempts + 1) * a.gasPerCycleYocto);
  }
});
