import { MAX_PRICE_AGE_MS, VAULT_IDS, type CrossAccount, type Market, type Position, type Vault, type VaultId } from "@/lib/near/types";
import { MAX_DEPTH_AGE_MS } from "@/lib/intents/depth";

const BPS = 10_000n;

export interface StressInput {
  markets: readonly Market[];
  /** Complete open-position list, including every leg of affected cross accounts. */
  positions: readonly Position[];
  crossAccounts: readonly CrossAccount[];
  vaults: readonly Vault[];
  marketId: string;
  /** Integer from 10 through 50: a downward shock to this market only. */
  shockPercent: number;
  nowMs: number;
}

export interface StressRow {
  position: Position;
  /** Shocked selected-market price, or unchanged oracle price for a cross peer; 8 decimals. */
  price: bigint;
  /** Margin + contract-rounded PnL - frozen borrow and net funding; USDC, 6 decimals. */
  equity: bigint;
  /** This leg is actually closed by the simulation, not merely unhealthy in isolation. */
  liquidatable: boolean;
  /** Isolated equity shortfall, or final account writeoff on the last cross leg closed. */
  badDebt: bigint;
}

export interface StressResult {
  rows: StressRow[];
  /** Sum of notionals actually closed, including other-market cross contagion. */
  liquidatableNotional: bigint;
  /** Isolated equity shortfalls plus final cross writeoffs, attributed to creditor vaults. */
  badDebtByVault: Record<VaultId, bigint>;
  /** Latest measured exit capacity, unchanged by the shock; null without a fresh measurement. */
  capacity: bigint | null;
  warnings: string[];
}

/** Consumers must display these alongside results; warnings below are snapshot-specific. */
export const STRESS_MODEL_LIMITATIONS = [
  "Snapshot estimate: position, account and vault views are independent reads, not an atomic chain snapshot. Borrow and funding stay frozen at their view values; liquidation has no close fee.",
  "Only the selected oracle price is shocked. Exit capacity stays at its last measured value: future quotes, price impact, new accrual, orders and keeper execution are not forecast.",
  "Settlement order is isolated position id, then cross account id; cross legs follow the contract's signed health-ratio/id order and stop on recovery. Actual transaction order can change vault payout caps.",
  "Bad debt is an estimate: isolated negative equity includes unpaid fees, not a booked receivable writeoff. Cross debt is counted only when the final leg exits, by creditor vault; a row's final account writeoff may belong to other vaults. Unpaid positive payouts under vault caps are not included.",
  "This is trader liquidation stress, not total hedged-vault PnL: external inventory repricing, hedge execution and custody recovery are excluded. Payout caps use vault cash, not external marked assets.",
] as const;

interface VaultState {
  balance: bigint;
  receivable: bigint;
}

const min = (a: bigint, b: bigint) => a < b ? a : b;
const positive = (value: bigint) => value > 0n ? value : 0n;
const ceilDiv = (value: bigint, divisor: bigint) => (value + divisor - 1n) / divisor;

/** math.rs::pnl: gains floor and cap at notional; losses ceil without a cap. */
function positionPnl(position: Position, price: bigint): bigint {
  const difference = price > position.entry_price ? price - position.entry_price : position.entry_price - price;
  const gain = position.side === "long" ? price > position.entry_price : price < position.entry_price;
  return gain
    ? min(position.size * difference / position.entry_price, position.size)
    : -ceilDiv(position.size * difference, position.entry_price);
}

/** liquidation.rs::split_equity, with the caller supplying the pool/vault equity cap. */
function splitEquity(equity: bigint, size: bigint) {
  let left = positive(equity);
  const reward = min(size * 20n / BPS, left);
  left -= reward;
  const penalty = min(ceilDiv(size * 100n, BPS), left);
  return { reward, penalty, returned: left - penalty };
}

/**
 * Read-only, integer simulation of liquidation.rs and cross.rs using frozen view accruals.
 * Missing/inconsistent required state throws rather than inventing cash, prices or vault funds.
 * Stale nonzero prices remain usable only as explicitly warned hypothetical estimates.
 */
export function calculateStress({ markets, positions, crossAccounts, vaults, marketId, shockPercent, nowMs }: StressInput): StressResult {
  if (!Number.isInteger(shockPercent) || shockPercent < 10 || shockPercent > 50) {
    throw new Error("Choose an integer downward shock from 10% through 50%.");
  }
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new Error("A valid snapshot time is required for stress freshness checks.");
  }

  const warnings: string[] = [];
  const marketById = new Map(markets.map((market) => [market.id, market]));
  const selected = marketById.get(marketId);
  if (!selected) throw new Error(`Missing market ${marketId}; refresh the chain snapshot.`);

  const affectedAccounts = new Set(positions.filter((position) => position.market_id === marketId && position.margin_mode === "cross").map((position) => position.account_id));
  const affected = positions.filter((position) => position.margin_mode === "isolated"
    ? position.market_id === marketId
    : affectedAccounts.has(position.account_id)).sort((a, b) => a.id - b.id);
  const requiredMarketIds = new Set([marketId, ...affected.map((position) => position.market_id)]);
  const prices = new Map<string, bigint>();
  for (const id of requiredMarketIds) {
    const market = marketById.get(id);
    if (!market) throw new Error(`Missing market ${id} for an affected position; refresh the chain snapshot.`);
    if (typeof market.price !== "bigint" || market.price <= 0n) {
      throw new Error(`Missing oracle price for ${id}; no stress estimate is available.`);
    }
    if (!Number.isSafeInteger(market.price_timestamp_ms) || market.price_timestamp_ms <= 0) {
      throw new Error(`Missing oracle timestamp for ${id}; price freshness cannot be established.`);
    }
    if (market.price_timestamp_ms > nowMs) {
      warnings.push(`${id} oracle timestamp is in the future; freshness cannot be established and liquidation execution is not implied.`);
    } else if (nowMs - market.price_timestamp_ms > MAX_PRICE_AGE_MS) {
      warnings.push(`${id} oracle price is stale (older than 120 seconds); this is a stale-price estimate, not an executable liquidation.`);
    }
    const price = id === marketId ? market.price * BigInt(100 - shockPercent) / 100n : market.price;
    if (price <= 0n) throw new Error(`The shocked ${id} price rounds to zero; no valid price estimate is available.`);
    prices.set(id, price);
  }

  let capacity: bigint | null = null;
  if (!Number.isSafeInteger(selected.depth_measured_at_ms) || selected.depth_measured_at_ms <= 0 || typeof selected.exit_capacity !== "bigint") {
    warnings.push(`${marketId} exit depth is missing or unmeasured; capacity is unavailable.`);
  } else if (selected.depth_measured_at_ms > nowMs) {
    warnings.push(`${marketId} exit depth has a future timestamp; capacity freshness cannot be established.`);
  } else if (nowMs - selected.depth_measured_at_ms > MAX_DEPTH_AGE_MS) {
    warnings.push(`${marketId} exit depth is stale (older than 30 minutes); capacity is unavailable.`);
  } else {
    capacity = selected.exit_capacity;
  }

  const seenIds = new Set<number>();
  const rows: StressRow[] = affected.map((position) => {
    if (seenIds.has(position.id)) throw new Error(`Duplicate position ${position.id}; refresh the chain snapshot.`);
    seenIds.add(position.id);
    if (position.entry_price <= 0n || position.size <= 0n || position.maintenance_margin <= 0n) {
      throw new Error(`Incomplete position ${position.id}; entry price, size and locked maintenance are required.`);
    }
    const market = marketById.get(position.market_id)!;
    if (position.mark_price !== market.price || position.mark_price_timestamp_ms !== market.price_timestamp_ms) {
      warnings.push(`Position ${position.id} and ${position.market_id} oracle views differ; repricing uses the market view with the position's frozen accruals.`);
    }
    const price = prices.get(position.market_id)!;
    return {
      position,
      price,
      equity: position.margin + positionPnl(position, price) - position.borrow_fee - position.funding_paid + position.funding_received,
      liquidatable: false,
      badDebt: 0n,
    };
  });

  const vaultById = new Map(vaults.map((vault) => [vault.id, { balance: vault.balance, receivable: vault.cross_receivable }]));
  for (const [id, vault] of vaultById) {
    if (vault.balance < 0n || vault.receivable < 0n || vault.receivable > vault.balance) {
      throw new Error(`Inconsistent ${id} vault balance/receivables; refresh the chain snapshot.`);
    }
  }
  function vaultFor(id: VaultId): VaultState {
    const vault = vaultById.get(id);
    if (!vault) throw new Error(`Missing ${id} vault state; liquidation payouts and debt cannot be estimated.`);
    return vault;
  }
  const accountById = new Map(crossAccounts.map((account) => [account.account_id, account]));
  const crossRows = new Map<string, StressRow[]>();
  for (const row of rows) {
    vaultFor(marketById.get(row.position.market_id)!.vault_id);
    if (row.position.margin_mode !== "cross") continue;
    if (marketById.get(row.position.market_id)!.vault_id.startsWith("market-")) {
      throw new Error("An isolated market cannot carry cross-margin debt; refresh the chain snapshot.");
    }
    const legs = crossRows.get(row.position.account_id);
    if (legs) legs.push(row);
    else crossRows.set(row.position.account_id, [row]);
  }

  // Independent view reads may disagree. Reject missing legs or unsupported debt instead of
  // silently treating either as zero; unrelated accounts' receivables remain in each vault.
  const initialClaims: Record<VaultId, bigint> = { core: 0n, "long-tail": 0n };
  for (const [id, legs] of crossRows) {
    const account = accountById.get(id);
    if (!account) throw new Error(`Missing cross account ${id}; shared cash must not be assumed to be zero.`);
    if (account.position_count !== legs.length) {
      throw new Error(`Incomplete cross account ${id}: expected ${account.position_count} legs, received ${legs.length}. Refresh the chain snapshot.`);
    }
    if (account.debt_by_vault.some((debt) => debt < 0n) || account.debt_by_vault[0] + account.debt_by_vault[1] !== positive(-account.cash)) {
      throw new Error(`Inconsistent cash/debt provenance for ${id}; refresh the chain snapshot.`);
    }
    if (!account.prices_fresh) {
      warnings.push(`Cross account ${id} reported stale prices in its independent view; this is a snapshot estimate, not confirmed executable health.`);
    }
    for (const [index, vaultId] of VAULT_IDS.entries()) {
      const claim = account.debt_by_vault[index];
      if (claim > 0n) {
        initialClaims[vaultId] += claim;
        if (initialClaims[vaultId] > vaultFor(vaultId).receivable) {
          throw new Error(`Cross debt exceeds ${vaultId} vault receivables; refresh the chain snapshot.`);
        }
      }
    }
  }

  const badDebtByVault: Record<VaultId, bigint> = { core: 0n, "long-tail": 0n };
  for (const vault of vaults) badDebtByVault[vault.id] = 0n;
  let liquidatableNotional = 0n;
  for (const row of rows) {
    const position = row.position;
    if (position.margin_mode !== "isolated" || row.equity > position.maintenance_margin) continue;
    const vaultId = marketById.get(position.market_id)!.vault_id;
    const vault = vaultFor(vaultId);
    const available = vault.balance - vault.receivable + position.margin;
    const { reward, returned } = splitEquity(min(row.equity, available), position.size);
    vault.balance += position.margin - reward - returned;
    row.liquidatable = true;
    row.badDebt = positive(-row.equity);
    badDebtByVault[vaultId] += row.badDebt;
    liquidatableNotional += position.size;
  }

  for (const id of [...crossRows.keys()].sort()) {
    const account = accountById.get(id)!;
    const legs = crossRows.get(id)!;
    let cash = account.cash;
    const debt: [bigint, bigint] = [...account.debt_by_vault];
    let equity = cash;
    let maintenance = 0n;
    for (const row of legs) {
      equity += row.equity;
      maintenance += row.position.maintenance_margin;
    }
    // bigint division truncates toward zero, matching cross.rs::ratio_bps for negative equity.
    const ordered = [...legs].sort((a, b) => {
      const aRatio = a.equity * BPS / a.position.maintenance_margin;
      const bRatio = b.equity * BPS / b.position.maintenance_margin;
      return aRatio === bRatio ? a.position.id - b.position.id : aRatio < bRatio ? -1 : 1;
    });
    for (let legIndex = 0; legIndex < ordered.length && equity <= maintenance; legIndex++) {
      const row = ordered[legIndex];
      const position = row.position;
      const vaultId = marketById.get(position.market_id)!.vault_id;
      const index = vaultId === "core" ? 0 : 1;
      const vault = vaultFor(vaultId);
      const available = vault.balance - vault.receivable + position.margin;
      const { reward, penalty } = splitEquity(min(equity, available), position.size);
      const payout = min(row.equity - reward - penalty, available - reward + debt[index]);
      vault.balance += position.margin - payout - reward;

      const oldDebt = positive(-cash);
      cash += payout;
      const newDebt = positive(-cash);
      if (newDebt > oldDebt) {
        const added = newDebt - oldDebt;
        debt[index] += added;
        vault.receivable += added;
      } else {
        let repaid = oldDebt - newDebt;
        // Repay the paying vault's claim first, then the other creditor, exactly as cross.rs.
        for (const creditor of [index, index === 0 ? 1 : 0]) {
          const paid = min(repaid, debt[creditor]);
          debt[creditor] -= paid;
          if (paid > 0n) vaultFor(VAULT_IDS[creditor]).receivable -= paid;
          repaid -= paid;
        }
      }
      equity += payout - row.equity;
      maintenance -= position.maintenance_margin;
      row.liquidatable = true;
      liquidatableNotional += position.size;

      if (legIndex === ordered.length - 1) {
        // finish_cross_account writes off only settled debt, and only after the final leg exits.
        for (const [creditor, creditorId] of VAULT_IDS.entries()) {
          if (debt[creditor] === 0n) continue;
          const creditorVault = vaultFor(creditorId);
          creditorVault.balance -= debt[creditor];
          creditorVault.receivable -= debt[creditor];
          badDebtByVault[creditorId] += debt[creditor];
          row.badDebt += debt[creditor];
        }
      }
    }
  }

  return { rows, liquidatableNotional, badDebtByVault, capacity, warnings };
}
