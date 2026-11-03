//! Ketos perpetual futures: isolated-margin markets against an LP vault, with open interest
//! and leverage capped by exit liquidity measured on NEAR Intents.
//!
//! There is no admin method that can pause markets or move user funds: the only privileged
//! account is the keeper, limited to publishing depth samples and refreshing prices.

pub mod account;
pub mod market;

use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault, PromiseOrValue};

use account::Account;
use market::{default_markets, Market, MarketId};

pub const MSG_DEPOSIT_MARGIN: &str = "deposit_margin";

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Markets,
    Accounts,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub usdc_id: AccountId,
    pub oracle_id: AccountId,
    pub keeper_id: AccountId,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Perps {
    usdc_id: AccountId,
    oracle_id: AccountId,
    keeper_id: AccountId,
    markets: IterableMap<MarketId, Market>,
    accounts: LookupMap<AccountId, Account>,
}

#[near]
impl Perps {
    #[init]
    pub fn new(usdc_id: AccountId, oracle_id: AccountId, keeper_id: AccountId) -> Self {
        let mut markets = IterableMap::new(StorageKey::Markets);
        for market in default_markets() {
            markets.insert(market.id.clone(), market);
        }
        Self {
            usdc_id,
            oracle_id,
            keeper_id,
            markets,
            accounts: LookupMap::new(StorageKey::Accounts),
        }
    }

    pub fn get_config(&self) -> Config {
        Config {
            usdc_id: self.usdc_id.clone(),
            oracle_id: self.oracle_id.clone(),
            keeper_id: self.keeper_id.clone(),
        }
    }

    pub fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }
}

#[near]
impl FungibleTokenReceiver for Perps {
    /// Entry point for all USDC deposits (`ft_transfer_call`). Any panic refunds the sender.
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(
            env::predecessor_account_id() == self.usdc_id,
            "ERR_WRONG_TOKEN"
        );
        require!(amount.0 > 0, "ERR_ZERO_AMOUNT");
        match msg.as_str() {
            MSG_DEPOSIT_MARGIN => self.deposit_margin(&sender_id, amount.0),
            _ => env::panic_str("ERR_INVALID_MSG"),
        }
        PromiseOrValue::Value(U128(0))
    }
}

#[cfg(test)]
mod tests;
