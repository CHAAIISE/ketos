const USD = 1_000_000n;
const VALUE_SCALE = 10n ** 26n;
const BPS = 10_000n;
const min = (a: bigint, b: bigint) => a < b ? a : b;
const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Synthetic scenarios anchored to the separately retained signed observation, never live fills. */
export const REPLAY_ANCHOR = {
  timestampMs: 1_794_483_415_000,
  price: 344_864_500n,
  source: "out/deployments/ref-spike/seed-price.json",
  signer: "ed25519:3XbNrUzS7TFJbDn94weVDnJNubGSTkEYUdqu4f67JGDD",
};
export const REPLAY_ASSUMPTIONS = {
  vaultCash: 100n * USD, traderSize: 10n * USD, traderMargin: 2n * USD,
  capital: 10n * USD, maxOrder: USD, intervalMs: 60_000,
  venueFeeBps: 25n, slippageBps: 25n, basisBps: 15n,
  traderFundingBpsPerHour: 5n,
  // Explicit scenario parameters, not measurements of the deployed custody or paid oracle.
  gasPerCycleYocto: 10n ** 21n, extraDataCostPerCycle: 1_000n,
  maxShortfallBps: 200n, valuationHaircutBps: 200n,
};
export type ReplayScenario = { id: string; label: string; finalPriceBps: bigint; missEvery?: number;
  fillFractionBps?: bigint; delayLastReceipt?: boolean };
export const REPLAY_SCENARIOS: readonly ReplayScenario[] = [
  { id: "flat", label: "Flat", finalPriceBps: 10_000n },
  { id: "up", label: "Up 20%", finalPriceBps: 12_000n },
  { id: "down", label: "Down 15%", finalPriceBps: 8_500n },
  { id: "gap", label: "Gap down 80%", finalPriceBps: 2_000n },
  { id: "missed", label: "Up 20% · missed orders", finalPriceBps: 12_000n, missEvery: 2 },
  { id: "partial", label: "Up 20% · half-size liquidity", finalPriceBps: 12_000n, fillFractionBps: 5_000n },
  { id: "delayed", label: "Up 20% · last receipt delayed", finalPriceBps: 12_000n, delayLastReceipt: true },
];
export type ReplayPoint = { timestampMs: number; price: bigint; inventory: bigint; cash: bigint;
  action: "buy" | "sell" | "missed" | "held"; pending: boolean; unhedgedNav: bigint; hedgedNav: bigint };
export type ReplayResult = { id: string; label: string; unhedgedPnl: bigint; hedgePnl: bigint;
  netPnlAfterOperatingCosts: bigint; conservativeNav: bigint; tradingCosts: bigint;
  operatorGasYocto: bigint; operatorGasUsd: bigint; extraDataCost: bigint; fundingCollected: bigint;
  residualInventory: bigint; pending: boolean; fills: number; points: ReplayPoint[] };

/** Mark-to-market ledger with capped trader settlement and bounded spot orders; no liquidation forecast. */
export function replayHedge(scenario: ReplayScenario): ReplayResult {
  const a = REPLAY_ASSUMPTIONS;
  if (scenario.finalPriceBps <= 0n || (scenario.fillFractionBps !== undefined &&
      (scenario.fillFractionBps <= 0n || scenario.fillFractionBps > BPS))) throw new Error("Invalid scenario");
  const entry = REPLAY_ANCHOR.price;
  const finalPrice = entry * scenario.finalPriceBps / BPS;
  const rawPnl = a.traderSize * (finalPrice - entry) / entry;
  const fundingDue = a.traderSize * a.traderFundingBpsPerHour * 12n / (BPS * 60n);
  const cappedGain = rawPnl > a.traderSize ? a.traderSize : rawPnl;
  const netTrader = cappedGain - fundingDue < -a.traderMargin ? -a.traderMargin : cappedGain - fundingDue;
  const fundingCollected = min(fundingDue, a.traderMargin + cappedGain > 0n ? a.traderMargin + cappedGain : 0n);
  const unhedgedPnl = -netTrader;
  let cash = a.capital;
  let inventory = 0n;
  let tradingCosts = 0n;
  let operatorGasYocto = a.gasPerCycleYocto; // Capital allocation and reconciliation cycle.
  let operatorGasUsd = ceil(a.gasPerCycleYocto * entry, VALUE_SCALE);
  let extraDataCost = a.extraDataCostPerCycle;
  let fills = 0;
  let attempts = 0;
  let pending = false;
  const points: ReplayPoint[] = [];
  const shortfall = a.venueFeeBps + a.slippageBps + a.basisBps;
  if (shortfall > a.maxShortfallBps) throw new Error("Scenario violates the execution bound");
  // Ten build-up cycles; a price jump and trader settlement at minute 12; bounded unwinds afterward.
  for (let step = 1; step <= 30; step++) {
    const price = step < 12 ? entry : finalPrice;
    const buying = step <= 10;
    let action: ReplayPoint["action"] = "held";
    if (!pending && (buying ? cash > 0n : step >= 12 && inventory * price / VALUE_SCALE >= 10_000n)) {
      const capacity = a.maxOrder * (scenario.fillFractionBps ?? BPS) / BPS;
      const input = buying ? min(cash, capacity) : min(inventory, capacity * VALUE_SCALE / price);
      if (input > 0n) {
        attempts++;
        operatorGasYocto += a.gasPerCycleYocto;
        operatorGasUsd += ceil(a.gasPerCycleYocto * price, VALUE_SCALE);
        extraDataCost += a.extraDataCostPerCycle;
        if (scenario.missEvery && attempts % scenario.missEvery === 0) action = "missed";
        else {
          const gross = buying ? input : input * price / VALUE_SCALE;
          const cost = ceil(gross * shortfall, BPS);
          tradingCosts += cost;
          if (buying) { cash -= input; inventory += (input - cost) * VALUE_SCALE / price; action = "buy"; }
          else { inventory -= input; cash += gross - cost; action = "sell"; }
          fills++;
          // Venue execution happened, but custody confirmation is deliberately absent through the horizon.
          if (scenario.delayLastReceipt && step === 10) pending = true;
        }
      }
    }
    const baseline = a.vaultCash + (step >= 12 ? unhedgedPnl : 0n);
    const external = pending ? 0n : cash + inventory * price / VALUE_SCALE * (BPS - a.valuationHaircutBps) / BPS;
    points.push({ timestampMs: REPLAY_ANCHOR.timestampMs + step * a.intervalMs, price, inventory, cash,
      action, pending, unhedgedNav: baseline, hedgedNav: baseline - a.capital + external });
  }
  if (!pending && cash > 0n) {
    operatorGasYocto += a.gasPerCycleYocto;
    operatorGasUsd += ceil(a.gasPerCycleYocto * finalPrice, VALUE_SCALE);
    extraDataCost += a.extraDataCostPerCycle;
  }
  const hedgePnl = cash + inventory * finalPrice / VALUE_SCALE - a.capital;
  return { id: scenario.id, label: scenario.label, unhedgedPnl, hedgePnl,
    netPnlAfterOperatingCosts: unhedgedPnl + hedgePnl - operatorGasUsd - extraDataCost,
    conservativeNav: points.at(-1)!.hedgedNav, tradingCosts, operatorGasYocto, operatorGasUsd, extraDataCost,
    fundingCollected, residualInventory: inventory, pending, fills, points };
}
