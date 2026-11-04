//! LP vault: the counterparty of every trader. LPs hold internal, non-transferable shares of
//! the vault's net asset value; withdrawals are limited to USDC not reserved for open positions.

use near_sdk::json_types::{I128, U128};
use near_sdk::serde_json::json;
use near_sdk::{
    assert_one_yocto, env, log, near, require, AccountId, Gas, NearToken, Promise, PromiseError,
};

use crate::market::USD;
use crate::math::{mul_div_floor, to_i128, BPS};
use crate::{emit_event, Perps, PerpsExt};

pub const MIN_VAULT_DEPOSIT: u128 = USD;

const MS_PER_DAY: u64 = 86_400_000;
const APR_WINDOW_DAYS: u64 = 7;

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_WITHDRAW_CALLBACK: Gas = Gas::from_tgas(10);

/// Fee income (trading, borrow, liquidation penalties) per UTC day, oldest first.
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

    /// Fees earned over the trailing 7 days, today included.
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
    /// USDC held by the vault (deposits, fees, trader losses, minus gains paid).
    pub balance: U128,
    /// balance − traders' unrealized PnL + borrow fees + net funding due.
    pub nav: U128,
    pub total_shares: U128,
    /// NAV per 1 share (1e6 share units), in USDC units; 1.000000 before the first deposit.
    pub share_price: U128,
    /// Maximum price gains plus gross funding credits, capped at the balance.
    pub reserved: U128,
    /// Balance LPs can withdraw right now.
    pub available: U128,
    pub traders_unrealized_pnl: I128,
    pub borrow_fees_due: U128,
    pub funding_net_due: I128,
    pub fees_7d: U128,
    /// Trailing 7-day fee income annualized over NAV, in basis points.
    pub fee_apr_bps: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultAccountView {
    pub account_id: AccountId,
    pub shares: U128,
    /// Shares valued at the current NAV.
    pub value: U128,
}

impl Perps {
    pub(crate) fn record_fee(&mut self, now_ms: u64, amount: u128) {
        self.fee_log.record(now_ms, amount);
    }

    fn set_vault_shares(&mut self, account_id: &AccountId, shares: u128) {
        if shares == 0 {
            self.vault_shares.remove(account_id);
        } else {
            self.vault_shares.insert(account_id.clone(), shares);
        }
    }

    fn traders_pnl(&self) -> i128 {
        self.markets.values().map(|m| m.traders_pnl()).sum()
    }

    fn borrow_fees_due(&self, now_ms: u64) -> u128 {
        self.markets.values().map(|m| m.borrow_fees_due(now_ms)).sum()
    }

    fn funding_net_due(&self, now_ms: u64) -> i128 {
        self.markets.values().map(|m| m.funding_net_due(now_ms)).sum()
    }

    pub(crate) fn vault_nav(&self, now_ms: u64) -> u128 {
        let nav = to_i128(self.vault_usdc) + to_i128(self.borrow_fees_due(now_ms))
            + self.funding_net_due(now_ms) - self.traders_pnl();
        u128::try_from(nav.max(0)).unwrap_or(0)
    }

    pub(crate) fn vault_reserved(&self) -> u128 {
        let now_ms = env::block_timestamp_ms();
        let open_interest: u128 = self
            .markets
            .values()
            .map(|m| m.oi_long.0 + m.oi_short.0
                + m.funding_at(now_ms).received_due([m.oi_long.0, m.oi_short.0]))
            .sum();
        open_interest.min(self.vault_usdc)
    }

    /// Mints shares at the current NAV, rounded down for the depositor.
    pub(crate) fn deposit_vault(&mut self, account_id: &AccountId, amount: u128) {
        require!(amount >= MIN_VAULT_DEPOSIT, "ERR_MIN_VAULT_DEPOSIT: 1 USDC");
        let now_ms = env::block_timestamp_ms();
        let shares = if self.vault_total_shares == 0 {
            amount
        } else {
            let nav = self.vault_nav(now_ms);
            require!(nav > 0, "ERR_VAULT_EMPTY");
            mul_div_floor(amount, self.vault_total_shares, nav)
        };
        require!(shares > 0, "ERR_ZERO_SHARES");
        let held = self.vault_shares.get(account_id).copied().unwrap_or(0);
        self.vault_shares.insert(account_id.clone(), held + shares);
        self.vault_total_shares += shares;
        self.vault_usdc += amount;
        emit_event(
            "vault_deposit",
            json!({ "account_id": account_id, "amount": U128(amount), "shares": U128(shares) }),
        );
    }
}

#[near]
impl Perps {
    /// Burns `shares` for USDC at the current NAV (rounded down) and sends it to the caller.
    /// Fails when the amount exceeds what is not reserved for open positions.
    #[payable]
    pub fn withdraw_vault(&mut self, shares: U128) -> Promise {
        assert_one_yocto();
        let account_id = env::predecessor_account_id();
        let shares = shares.0;
        require!(shares > 0, "ERR_ZERO_SHARES");
        let held = self.vault_shares.get(&account_id).copied().unwrap_or(0);
        require!(held >= shares, "ERR_INSUFFICIENT_SHARES");

        let nav = self.vault_nav(env::block_timestamp_ms());
        let amount = mul_div_floor(shares, nav, self.vault_total_shares);
        require!(amount > 0, "ERR_ZERO_AMOUNT");
        let available = self.vault_usdc - self.vault_reserved();
        if amount > available {
            env::panic_str(&format!("ERR_VAULT_RESERVED: available {available}"));
        }

        self.set_vault_shares(&account_id, held - shares);
        self.vault_total_shares -= shares;
        self.vault_usdc -= amount;
        emit_event(
            "vault_withdraw",
            json!({ "account_id": account_id, "amount": U128(amount), "shares": U128(shares) }),
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
                    .on_vault_withdrawn(account_id, U128(shares), U128(amount)),
            )
    }

    /// Restores the burned shares and the USDC if the token transfer failed.
    #[private]
    pub fn on_vault_withdrawn(
        &mut self,
        account_id: AccountId,
        shares: U128,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> U128 {
        if result.is_ok() {
            return amount;
        }
        let held = self.vault_shares.get(&account_id).copied().unwrap_or(0);
        self.vault_shares.insert(account_id.clone(), held + shares.0);
        self.vault_total_shares += shares.0;
        self.vault_usdc += amount.0;
        log!(
            "vault withdrawal of {} to {} failed, shares restored",
            amount.0,
            account_id
        );
        U128(0)
    }

    pub fn get_vault(&self) -> VaultView {
        let now_ms = env::block_timestamp_ms();
        let nav = self.vault_nav(now_ms);
        let reserved = self.vault_reserved();
        let fees_7d = self.fee_log.trailing(now_ms);
        let share_price = if self.vault_total_shares == 0 {
            USD
        } else {
            mul_div_floor(nav, USD, self.vault_total_shares)
        };
        let fee_apr_bps = if nav == 0 {
            0
        } else {
            let annual = mul_div_floor(fees_7d, 365, APR_WINDOW_DAYS as u128);
            u32::try_from(mul_div_floor(annual, BPS, nav)).unwrap_or(u32::MAX)
        };
        VaultView {
            balance: U128(self.vault_usdc),
            nav: U128(nav),
            total_shares: U128(self.vault_total_shares),
            share_price: U128(share_price),
            reserved: U128(reserved),
            available: U128(self.vault_usdc - reserved),
            traders_unrealized_pnl: I128(self.traders_pnl()),
            borrow_fees_due: U128(self.borrow_fees_due(now_ms)),
            funding_net_due: I128(self.funding_net_due(now_ms)),
            fees_7d: U128(fees_7d),
            fee_apr_bps,
        }
    }

    pub fn get_vault_account(&self, account_id: AccountId) -> VaultAccountView {
        let shares = self.vault_shares.get(&account_id).copied().unwrap_or(0);
        let value = if shares == 0 {
            0
        } else {
            let nav = self.vault_nav(env::block_timestamp_ms());
            mul_div_floor(shares, nav, self.vault_total_shares)
        };
        VaultAccountView {
            account_id,
            shares: U128(shares),
            value: U128(value),
        }
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
        // Day 10 is still inside the window on day 16, gone on day 17.
        assert_eq!(log.trailing(day(16)), 13);
        assert_eq!(log.trailing(day(17)), 1);
        log.record(day(17), 2);
        assert_eq!(log.days, vec![(12, 1), (17, 2)]);
    }
}
