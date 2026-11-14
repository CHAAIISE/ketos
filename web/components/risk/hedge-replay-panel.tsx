import { formatUnits, formatUsd } from "@/lib/near/format";
import { replayHedge, REPLAY_ANCHOR, REPLAY_ASSUMPTIONS as a, REPLAY_SCENARIOS } from "@/lib/hedge/replay";
import { PanelHeading } from "@/components/vault/panel-heading";

const rows = REPLAY_SCENARIOS.map(replayHedge);
const usd = (amount: bigint) => formatUsd(amount, { maxFractionDigits: 4, signed: true });
export function HedgeReplayPanel() {
  return <section aria-labelledby="hedge-replay-title" className="min-w-0 rounded-md border border-border bg-card">
    <PanelHeading id="hedge-replay-title" aside={<span className="text-label text-warning">Synthetic scenarios · not live fills</span>}>What protection costs</PanelHeading>
    <div className="space-y-3 p-3 text-label">
      <p className="text-muted-foreground">Same trader and price path, with and without spot hedging. A hedge can reduce an upward-price loss and still perform worse in a sharp downward gap.</p>
      <div className="overflow-x-auto"><table className="w-full whitespace-nowrap text-left">
        <thead className="border-b border-border text-tertiary"><tr>{["Scenario", "Without hedge", "Hedge PnL", "With hedge, all costs", "Conservative NAV", "Residual spot"].map((label) => <th key={label} className="px-2 py-2 font-normal">{label}</th>)}</tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id} className="border-b border-border/60">
          <td className="px-2 py-3">{row.label}</td>
          <td className="px-2 py-3 font-mono">{usd(row.unhedgedPnl)}</td>
          <td className="px-2 py-3 font-mono">{usd(row.hedgePnl)}</td>
          <td className="px-2 py-3 font-mono">{usd(row.netPnlAfterOperatingCosts)}</td>
          <td className="px-2 py-3 font-mono">{formatUsd(row.conservativeNav)}{row.pending ? " · pending excluded" : ""}</td>
          <td className="px-2 py-3 font-mono">{formatUnits(row.residualInventory, 24, { maxFractionDigits: 8 })} NEAR</td>
        </tr>)}</tbody>
      </table></div>
      <details className="text-muted-foreground"><summary className="cursor-pointer">Reproduce and inspect every assumption</summary>
        <div className="mt-3 space-y-2">
          <p>Run <code className="text-foreground">pnpm exec tsx scripts/hedge-replay.ts</code>. Output includes every timestamp, execution attempt, cash balance, inventory and both NAV paths.</p>
          <p>Anchor: {new Date(REPLAY_ANCHOR.timestampMs).toISOString()}, NEAR {formatUnits(REPLAY_ANCHOR.price, 8, { maxFractionDigits: 8 })} USD, retained signed observation in <code>{REPLAY_ANCHOR.source}</code>. All subsequent prices and execution outcomes are synthetic.</p>
          <p>Initial vault {formatUsd(a.vaultCash)}, one {formatUsd(a.traderSize)} long with {formatUsd(a.traderMargin)} collateral, {formatUsd(a.capital)} hedge budget. Ten one-minute build-up cycles; trader settlement at minute 12, then bounded {formatUsd(a.maxOrder)} unwinds through minute 30. Gains cap at notional; losses at collateral. No intervening liquidator or cross-margin positions are simulated.</p>
          <p>Each fill assumes {String(a.venueFeeBps)} bps fee + {String(a.slippageBps)} bps slippage + {String(a.basisBps)} bps adverse basis. Spot funding is zero; trader funding is {String(a.traderFundingBpsPerHour)} bps/hour for 12 minutes, collectibility capped by collateral. Common trading/borrow fees are omitted from both paths.</p>
          <p>Each attempted cycle assumes {formatUnits(a.gasPerCycleYocto, 24, { maxFractionDigits: 6 })} NEAR gas, converted at that scenario’s price, and {formatUsd(a.extraDataCostPerCycle, { maxFractionDigits: 6 })} incremental data cost. These are explicit assumptions, not observed custody costs. They are deducted in “all costs”, even when paid by the operator; conservative vault NAV excludes those external operating costs.</p>
          <p>Missed orders spend operating costs but change no inventory. “Half-size” is reduced executable spot quantity, not a partial Ref swap: Ref swaps are atomic. Delayed receipt executes at the venue but remains unknown to custody, freezes replacement orders and excludes all external capital from recognized NAV. Its economic mark is counterfactual, not spendable funds.</p>
          <p>Recognized inventory uses a 2% haircut; trade PnL uses the actual scenario mark. This is a bounded sensitivity model, not historical performance, APR, an AMM liquidity forecast or proof of guaranteed neutrality.</p>
        </div>
      </details>
    </div>
  </section>;
}
