//! Vault-local capital, claims and history. Existing shared pools retain their identities;
//! each new market owns an independent isolated-margin vault.

use near_sdk::json_types::{I128, U128};
use near_sdk::serde_json::json;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    env, log, near, require, AccountId, Gas, NearToken, Promise, PromiseError,
};

use crate::market::{MarketId, VaultId, USD};
use crate::math::{mul_div_ceil, mul_div_floor, to_i128, BPS};
use crate::{emit_event, Ketos, KetosExt, StorageKey};

pub const MIN_VAULT_DEPOSIT: u128 = USD;
pub const SNAPSHOT_INTERVAL_MS: u64 = 3_600_000;
pub const VAULT_HISTORY_LEN: u64 = 168;
const MS_PER_DAY: u64 = 86_400_000;
const APR_WINDOW_DAYS: u64 = 7;
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_WITHDRAW_CALLBACK: Gas = Gas::from_tgas(10);

pub const SHARED_VAULT_IDS: [VaultId; 2] = [VaultId::Core, VaultId::LongTail];

impl VaultId {
    pub(crate) fn shared_index(self) -> usize {
        match self {
            Self::Core => 0,
            Self::LongTail => 1,
            Self::Market(_) => env::panic_str("ERR_ISOLATED_MARKET_CROSS"),
        }
    }

    pub(crate) fn is_market(self) -> bool {
        matches!(self, Self::Market(_))
    }

    pub(crate) fn oi_multiplier(self) -> u128 {
        match self {
            Self::Core => 2,
            Self::LongTail | Self::Market(_) => 1,
        }
    }
}

/// Settlement revenue in USDC units, including cross claims. Deposits and withdrawals are not revenue.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Revenue {
    pub fees: U128,
    pub funding: I128,
    /// Net counterparty price result, including unpaid losses and capped payouts.
    pub trader_pnl: I128,
    pub liquidations: U128,
    pub listing: U128,
}

#[near(serializers = [borsh])]
pub(crate) struct Vault {
    pub balance: u128,
    /// Cross settlement claims are included in balance but cannot fund withdrawals or gains.
    pub cross_receivable: u128,
    pub total_shares: u128,
    pub share_epoch: u64,
    pub revenue: Revenue,
    pub fee_log: FeeLog,
    pub market_id: Option<MarketId>,
    pub created_at_ms: Option<u64>,
    /// Epoch tagging prevents wiped-out claims from reviving after recapitalization.
    pub shares: LookupMap<AccountId, (u64, u128)>,
    pub history: Vector<VaultSnapshot>,
    pub snapshot_count: u64,
    pub last_snapshot_at_ms: Option<u64>,
}

impl Vault {
    pub(crate) fn new(vault_id: VaultId, market_id: Option<MarketId>) -> Self {
        Self {
            balance: 0,
            cross_receivable: 0,
            total_shares: 0,
            share_epoch: 0,
            revenue: Revenue::default(),
            fee_log: FeeLog::default(),
            created_at_ms: market_id.as_ref().map(|_| env::block_timestamp_ms()),
            market_id,
            shares: LookupMap::new(StorageKey::VaultShares { vault_id }),
            history: Vector::new(StorageKey::VaultHistory { vault_id }),
            snapshot_count: 0,
            last_snapshot_at_ms: None,
        }
    }
}

/// Fee income (trading, borrow, liquidation penalties, listing) per UTC day, oldest first.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct FeeLog {
    days: Vec<(u64, u128)>,
}

impl FeeLog {
    pub fn record(&mut self, now_ms: u64, amount: u128) {
        if amount == 0 {
            return;
        }
        let day = now_ms / MS_PER_DAY;
        match self.days.last_mut() {
            Some((d, total)) if *d == day => *total += amount,
            _ => self.days.push((day, amount)),
        }
        self.days.retain(|(d, _)| d + APR_WINDOW_DAYS > day);
    }

    pub fn trailing(&self, now_ms: u64) -> u128 {
        let day = now_ms / MS_PER_DAY;
        self.days
            .iter()
            .filter(|(d, _)| d + APR_WINDOW_DAYS > day)
            .map(|(_, fees)| fees)
            .sum()
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultView {
    pub id: VaultId,
    /// None identifies an existing shared pool; market vaults retain their original symbol.
    pub market_id: Option<MarketId>,
    pub created_at_ms: Option<u64>,
    pub last_snapshot_at_ms: Option<u64>,
    /// Accounting assets, including cross receivables; cash is balance minus cross_receivable.
    pub balance: U128,
    /// NAV includes confirmed external assets, conservatively marked; these are not local cash.
    pub nav: U128,
    pub hedge_assets: U128,
    pub hedge_valuation_ready: bool,
    pub total_shares: U128,
    pub share_price: U128,
    pub reserved: U128,
    pub available: U128,
    pub available_to_withdraw: U128,
    pub cross_receivable: U128,
    pub traders_unrealized_pnl: I128,
    pub borrow_fees_due: U128,
    pub funding_net_due: I128,
    pub fees_7d: U128,
    pub fee_apr_bps: u32,
    pub revenue: Revenue,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultAccountView {
    pub vault_id: VaultId,
    pub account_id: AccountId,
    pub shares: U128,
    pub value: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultSnapshot {
    pub timestamp_ms: u64,
    pub nav: U128,
    pub share_price: U128,
    /// Accounting assets, including cross receivables and excluding trader collateral.
    pub tvl: U128,
    pub revenue: Revenue,
}

impl Ketos {
    pub(crate) fn record_opening_fee(&mut self, vault_id: VaultId, now_ms: u64, amount: u128) {
        let vault = self.vaults.get_mut(&vault_id).unwrap();
        vault.balance += amount;
        vault.revenue.fees.0 += amount;
        vault.fee_log.record(now_ms, amount);
    }

    /// Attributes the exact balance change. Counterparty PnL absorbs uncollectible debt
    /// and payout caps, so the revenue components always reconcile to actual USDC.
    pub(crate) fn record_settlement(
        &mut self,
        vault_id: VaultId,
        collateral: u128,
        paid_out: u128,
        fees: u128,
        funding: i128,
        penalty: u128,
    ) {
        let vault = self.vaults.get_mut(&vault_id).unwrap();
        vault.balance = vault.balance + collateral - paid_out;
        let delta = to_i128(collateral) - to_i128(paid_out);
        vault.revenue.fees.0 += fees;
        vault.revenue.funding.0 += funding;
        vault.revenue.liquidations.0 += penalty;
        vault.revenue.trader_pnl.0 += delta - to_i128(fees) - funding - to_i128(penalty);
        vault
            .fee_log
            .record(env::block_timestamp_ms(), fees + penalty);
    }

    pub(crate) fn vault_exposure(&self, vault_id: VaultId) -> u128 {
        self.markets
            .values()
            .filter(|market| market.vault_id == vault_id)
            .map(|market| market.oi_long.0.max(market.oi_short.0))
            .sum()
    }

    pub(crate) fn require_fresh_vault_prices(&self, vault_id: VaultId) {
        require!(self.vaults.contains_key(&vault_id), "ERR_UNKNOWN_VAULT");
        require!(self.hedge_valuation(vault_id).1, "ERR_HEDGE_VALUATION_UNCERTAIN");
        let now_ms = env::block_timestamp_ms();
        for market in self.markets.values().filter(|market| market.vault_id == vault_id) {
            if matches!(vault_id, VaultId::Market(_)) && market.oi_long.0 == 0 && market.oi_short.0 == 0 {
                continue;
            }
            market.fresh_price(now_ms);
        }
    }

    pub(crate) fn vault_shares_held(&self, vault_id: VaultId, account_id: &AccountId) -> u128 {
        let vault = self.vaults.get(&vault_id).expect("ERR_UNKNOWN_VAULT");
        vault.shares.get(account_id)
            .filter(|(epoch, _)| *epoch == vault.share_epoch)
            .map_or(0, |(_, shares)| *shares)
    }

    fn set_vault_shares(&mut self, vault_id: VaultId, account_id: &AccountId, shares: u128) {
        let vault = self.vaults.get_mut(&vault_id).expect("ERR_UNKNOWN_VAULT");
        if shares == 0 {
            vault.shares.remove(account_id);
        } else {
            vault.shares.insert(account_id.clone(), (vault.share_epoch, shares));
        }
    }

    fn reset_vault_shares(&mut self, vault_id: VaultId, nav: u128) {
        let vault = self.vaults.get_mut(&vault_id).unwrap();
        vault.share_epoch = vault.share_epoch.checked_add(1).expect("ERR_SHARE_EPOCH_OVERFLOW");
        vault.total_shares = nav;
        if nav > 0 {
            // Assets with no LP owner belong to the protocol, not the next depositor.
            self.set_vault_shares(vault_id, &env::current_account_id(), nav);
        }
    }

    /// Mints shares at the current NAV, rounded down for the depositor.
    pub(crate) fn deposit_vault(
        &mut self,
        vault_id: VaultId,
        account_id: &AccountId,
        amount: u128,
    ) {
        require!(amount >= MIN_VAULT_DEPOSIT, "ERR_MIN_VAULT_DEPOSIT: 1 USDC");
        if let Some(market_id) = &self.vaults.get(&vault_id).expect("ERR_UNKNOWN_VAULT").market_id {
            require!(self.markets.get(market_id).is_some_and(|market| market.vault_id == vault_id),
                "ERR_MARKET_RETIRED");
        }
        self.require_fresh_vault_prices(vault_id);
        let view = self.get_vault(vault_id);
        if view.nav.0 == 0 || view.total_shares.0 == 0 {
            self.reset_vault_shares(vault_id, view.nav.0);
        }
        let total_shares = self.vaults.get(&vault_id).unwrap().total_shares;
        let shares = if total_shares == 0 {
            amount
        } else {
            mul_div_floor(amount, total_shares, view.nav.0)
        };
        require!(shares > 0, "ERR_ZERO_SHARES");
        let held = self.vault_shares_held(vault_id, account_id);
        self.set_vault_shares(vault_id, account_id, held + shares);
        let vault = self.vaults.get_mut(&vault_id).unwrap();
        vault.total_shares += shares;
        vault.balance += amount;
        emit_event(
            "vault_deposit",
            json!({
                "vault_id": vault_id, "account_id": account_id,
                "amount": U128(amount), "shares": U128(shares),
            }),
        );
    }
}

#[near]
impl Ketos {
    #[payable]
    pub fn withdraw_vault(&mut self, vault_id: VaultId, shares: U128, signed_prices: Option<crate::signed_prices::SignedPrices>) -> Promise {
        require!(env::attached_deposit().as_yoctonear() >= 1, "ERR_ONE_YOCTO_REQUIRED");
        let action = crate::pull_prices::PullAction::WithdrawVault {
            account_id: env::predecessor_account_id(), vault_id, shares,
        };
        let ids = self.vault_price_market_ids(vault_id);
        if let Some(promise) = self.pull_for_action(action, ids, signed_prices) {
            return promise;
        }
        self.withdraw_vault_for(env::predecessor_account_id(), vault_id, shares)
    }

    #[cfg(test)]
    pub(crate) fn withdraw_vault_now(&mut self, vault_id: VaultId, shares: U128) -> Promise {
        near_sdk::assert_one_yocto();
        self.withdraw_vault_for(env::predecessor_account_id(), vault_id, shares)
    }

    pub(crate) fn withdraw_vault_for(&mut self, account_id: AccountId, vault_id: VaultId, shares: U128) -> Promise {
        let shares = shares.0;
        require!(shares > 0, "ERR_ZERO_SHARES");
        self.require_fresh_vault_prices(vault_id);
        let held = self.vault_shares_held(vault_id, &account_id);
        require!(held >= shares, "ERR_INSUFFICIENT_SHARES");
        let view = self.get_vault(vault_id);
        let amount = mul_div_floor(shares, view.nav.0, view.total_shares.0);
        require!(amount > 0, "ERR_ZERO_AMOUNT");
        if amount > view.available.0 {
            env::panic_str(&format!(
                "ERR_VAULT_RESERVED: available {}",
                view.available.0
            ));
        }
        self.set_vault_shares(vault_id, &account_id, held - shares);
        let vault = self.vaults.get_mut(&vault_id).unwrap();
        vault.total_shares -= shares;
        vault.balance -= amount;
        let share_epoch = vault.share_epoch;
        emit_event(
            "vault_withdraw",
            json!({
                "vault_id": vault_id, "account_id": account_id,
                "amount": U128(amount), "shares": U128(shares),
            }),
        );
        Promise::new(self.usdc_id.clone())
            .function_call(
                "ft_transfer".to_string(),
                json!({ "receiver_id": account_id, "amount": U128(amount) })
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_FT_TRANSFER,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_WITHDRAW_CALLBACK)
                    .on_vault_withdrawn(vault_id, account_id, U128(shares), U128(amount), share_epoch),
            )
    }

    #[private]
    pub fn on_vault_withdrawn(
        &mut self,
        vault_id: VaultId,
        account_id: AccountId,
        shares: U128,
        amount: U128,
        share_epoch: u64,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> U128 {
        if result.is_ok() {
            return amount;
        }
        if self.vaults.get(&vault_id).unwrap().share_epoch == share_epoch
            && self.vaults.get(&vault_id).unwrap().total_shares == 0
        {
            let nav = self.get_vault(vault_id).nav.0;
            if nav > 0 {
                // A failed full withdrawal cannot capture surplus earned while no LP
                // shares existed. Its already-debited cash claim remains the LP's.
                self.reset_vault_shares(vault_id, nav);
            }
        }
        if self.vaults.get(&vault_id).unwrap().share_epoch != share_epoch {
            // The transfer was already debited before the wipeout. Return its real cash
            // claim as free margin without reviving a claim on the recapitalized vault.
            self.accounts.entry(account_id.clone()).or_default().margin += amount.0;
            log!(
                "vault {:?} withdrawal of {} to {} failed after share reset, credited margin",
                vault_id,
                amount.0,
                account_id
            );
            return U128(0);
        }
        let held = self.vault_shares_held(vault_id, &account_id);
        self.set_vault_shares(vault_id, &account_id, held + shares.0);
        let vault = self.vaults.get_mut(&vault_id).unwrap();
        vault.total_shares += shares.0;
        vault.balance += amount.0;
        log!(
            "vault {:?} withdrawal of {} to {} failed, shares restored",
            vault_id,
            amount.0,
            account_id
        );
        U128(0)
    }

    pub fn get_vault(&self, vault_id: VaultId) -> VaultView {
        let now_ms = env::block_timestamp_ms();
        let vault = self.vaults.get(&vault_id).unwrap();
        let mut traders_pnl = 0i128;
        let mut borrow = 0u128;
        let mut funding = 0i128;
        let mut exposure = 0u128;
        let mut reserve = vault.cross_receivable;
        for market in self.markets.values().filter(|market| market.vault_id == vault_id) {
            let largest_side = market.oi_long.0.max(market.oi_short.0);
            exposure += largest_side;
            reserve = reserve
                .saturating_add(mul_div_ceil(largest_side, BPS + 1_000, BPS))
                .saturating_add(
                    market.funding_at(now_ms).received_due([market.oi_long.0, market.oi_short.0]),
                );
        }
        // Aggregates cannot distinguish a collectible loss from an underwater trader's
        // bad debt. Mark in place, without allocating, and retain all winner liabilities.
        for position in self.positions.values() {
            let market = self.markets.get(&position.market_id).unwrap();
            if market.vault_id != vault_id {
                continue;
            }
            let marked = position.mark(market, market.price.0, now_ms);
            let price_loss = marked.pnl.min(0).unsigned_abs().min(position.margin);
            traders_pnl += if marked.pnl < 0 { -to_i128(price_loss) } else { marked.pnl };
            let mut collectible = position.margin - price_loss;
            let net_funding = to_i128(marked.funding_paid) - to_i128(marked.funding_received);
            if net_funding > 0 {
                let paid = net_funding.unsigned_abs().min(collectible);
                funding += to_i128(paid);
                collectible -= paid;
            } else {
                funding += net_funding;
            }
            borrow += marked.borrow_fee.min(collectible);
        }
        // Settled cross debt is not cash and is not guaranteed collectible, even while
        // another cross position remains open. Never sell LP shares against that debt.
        let cash = vault.balance.saturating_sub(vault.cross_receivable);
        let (hedge_assets, hedge_valuation_ready) = self.hedge_valuation(vault_id);
        let nav = u128::try_from(
            (to_i128(cash) + to_i128(hedge_assets) + to_i128(borrow) + funding - traders_pnl).max(0),
        )
        .unwrap();
        let reserved = reserve.min(vault.balance);
        let capital_floor = exposure.div_ceil(vault_id.oi_multiplier());
        let available = if hedge_valuation_ready {
            (vault.balance - reserved).min(nav.saturating_sub(capital_floor))
        } else { 0 };
        let fees_7d = vault.fee_log.trailing(now_ms);
        let share_price = if vault.total_shares == 0 {
            USD
        } else {
            mul_div_floor(nav, USD, vault.total_shares)
        };
        let fee_apr_bps = if nav == 0 {
            0
        } else {
            let annual = mul_div_floor(fees_7d, 365, APR_WINDOW_DAYS as u128);
            u32::try_from(mul_div_floor(annual, BPS, nav)).unwrap_or(u32::MAX)
        };
        VaultView {
            id: vault_id,
            market_id: vault.market_id.clone(),
            created_at_ms: vault.created_at_ms,
            last_snapshot_at_ms: vault.last_snapshot_at_ms,
            balance: U128(vault.balance),
            nav: U128(nav),
            hedge_assets: U128(hedge_assets),
            hedge_valuation_ready,
            total_shares: U128(vault.total_shares),
            share_price: U128(share_price),
            reserved: U128(reserved),
            available: U128(available),
            available_to_withdraw: U128(available),
            cross_receivable: U128(vault.cross_receivable),
            traders_unrealized_pnl: I128(traders_pnl),
            borrow_fees_due: U128(borrow),
            funding_net_due: I128(funding),
            fees_7d: U128(fees_7d),
            fee_apr_bps,
            revenue: vault.revenue.clone(),
        }
    }

    /// Stable listing order, including retired market vaults whose LP claims still exist.
    pub fn get_vaults(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<VaultView> {
        self.vaults.keys()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .map(|id| self.get_vault(*id))
            .collect()
    }

    pub fn get_vault_account(&self, vault_id: VaultId, account_id: AccountId) -> VaultAccountView {
        let shares = self.vault_shares_held(vault_id, &account_id);
        let view = self.get_vault(vault_id);
        let value = if view.total_shares.0 == 0 {
            0
        } else {
            mul_div_floor(shares, view.nav.0, view.total_shares.0)
        };
        VaultAccountView {
            vault_id,
            account_id,
            shares: U128(shares),
            value: U128(value),
        }
    }

    /// Independent hourly clocks; callers select at most eight due vaults per transaction.
    pub fn snapshot_vaults(&mut self, vault_ids: Vec<VaultId>) -> Vec<VaultSnapshot> {
        require!(!vault_ids.is_empty() && vault_ids.len() <= 8, "ERR_SNAPSHOT_BATCH");
        let now_ms = env::block_timestamp_ms();
        for (index, vault_id) in vault_ids.iter().enumerate() {
            require!(!vault_ids[..index].contains(vault_id), "ERR_DUPLICATE_VAULT");
            let vault = self.vaults.get(vault_id).expect("ERR_UNKNOWN_VAULT");
            require!(vault.last_snapshot_at_ms
                .is_none_or(|last| now_ms.saturating_sub(last) >= SNAPSHOT_INTERVAL_MS),
                "ERR_SNAPSHOT_TOO_SOON");
        }
        let mut snapshots = Vec::with_capacity(vault_ids.len());
        for vault_id in vault_ids {
            let view = self.get_vault(vault_id);
            let snapshot = VaultSnapshot {
                timestamp_ms: now_ms,
                nav: view.nav,
                share_price: view.share_price,
                tvl: view.balance,
                revenue: view.revenue,
            };
            let vault = self.vaults.get_mut(&vault_id).unwrap();
            let slot = (vault.snapshot_count % VAULT_HISTORY_LEN) as u32;
            if slot < vault.history.len() {
                vault.history.set(slot, snapshot.clone());
            } else {
                vault.history.push(snapshot.clone());
            }
            vault.snapshot_count += 1;
            vault.last_snapshot_at_ms = Some(now_ms);
            emit_event("vault_snapshot", json!({ "vault_id": vault_id, "snapshot": snapshot }));
            snapshots.push(snapshot);
        }
        snapshots
    }

    /// Oldest first, at most 168 hourly observations.
    pub fn get_vault_history(&self, vault_id: VaultId) -> Vec<VaultSnapshot> {
        let vault = self.vaults.get(&vault_id).expect("ERR_UNKNOWN_VAULT");
        let history = &vault.history;
        let kept = u64::from(history.len());
        (vault.snapshot_count - kept..vault.snapshot_count)
            .map(|index| {
                history
                    .get((index % VAULT_HISTORY_LEN) as u32)
                    .unwrap()
                    .clone()
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fee_log_keeps_a_trailing_week() {
        let mut log = FeeLog::default();
        let day = |d: u64| d * MS_PER_DAY + 1_000;
        log.record(day(10), 5);
        log.record(day(10), 7);
        log.record(day(12), 1);
        assert_eq!(log.trailing(day(12)), 13);
        assert_eq!(log.trailing(day(16)), 13);
        assert_eq!(log.trailing(day(17)), 1);
        log.record(day(17), 2);
        assert_eq!(log.days, vec![(12, 1), (17, 2)]);
    }
}
