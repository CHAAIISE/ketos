use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{
    assert_one_yocto, env, log, near, require, AccountId, Gas, NearToken, Promise, PromiseError,
};

use crate::market::USD;
use crate::{Perps, PerpsExt};

/// First margin deposit must be at least 1 USDC: the contract pays the account's storage.
pub const MIN_FIRST_DEPOSIT: u128 = USD;

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_WITHDRAW_CALLBACK: Gas = Gas::from_tgas(10);

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct Account {
    /// Free collateral in USDC units, not locked in any position.
    pub margin: u128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountView {
    pub account_id: AccountId,
    pub margin: U128,
}

impl Perps {
    pub(crate) fn deposit_margin(&mut self, account_id: &AccountId, amount: u128) {
        let account = match self.accounts.get_mut(account_id) {
            Some(account) => account,
            None => {
                require!(amount >= MIN_FIRST_DEPOSIT, "ERR_MIN_FIRST_DEPOSIT: 1 USDC");
                self.accounts.insert(account_id.clone(), Account::default());
                self.accounts.get_mut(account_id).unwrap()
            }
        };
        account.margin = account
            .margin
            .checked_add(amount)
            .unwrap_or_else(|| env::panic_str("ERR_OVERFLOW"));
        log!("margin deposit {} by {}", amount, account_id);
    }
}

#[near]
impl Perps {
    /// Sends free margin back to the caller's wallet. Requires 1 yoctoNEAR (full-access key).
    #[payable]
    pub fn withdraw_margin(&mut self, amount: U128) -> Promise {
        assert_one_yocto();
        let account_id = env::predecessor_account_id();
        require!(amount.0 > 0, "ERR_ZERO_AMOUNT");
        let account = self
            .accounts
            .get_mut(&account_id)
            .unwrap_or_else(|| env::panic_str("ERR_NO_ACCOUNT"));
        require!(account.margin >= amount.0, "ERR_INSUFFICIENT_MARGIN");
        account.margin -= amount.0;

        Promise::new(self.usdc_id.clone())
            .function_call(
                "ft_transfer".to_string(),
                json!({ "receiver_id": account_id, "amount": amount })
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_FT_TRANSFER,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_WITHDRAW_CALLBACK)
                    .on_margin_withdrawn(account_id, amount),
            )
    }

    /// Re-credits the margin if the token transfer failed (e.g. receiver not registered).
    #[private]
    pub fn on_margin_withdrawn(
        &mut self,
        account_id: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> U128 {
        if result.is_ok() {
            return amount;
        }
        let account = self.accounts.entry(account_id.clone()).or_default();
        account.margin += amount.0;
        log!(
            "margin withdrawal of {} to {} failed, re-credited",
            amount.0,
            account_id
        );
        U128(0)
    }

    pub fn get_account(&self, account_id: AccountId) -> Option<AccountView> {
        self.accounts.get(&account_id).map(|account| AccountView {
            account_id: account_id.clone(),
            margin: U128(account.margin),
        })
    }
}
