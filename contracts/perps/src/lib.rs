//! Ketos perpetual futures: isolated-margin markets against an LP vault, with open interest
//! and leverage capped by exit liquidity measured on NEAR Intents.
//!
//! There is no admin method that can pause markets or move user funds: the only privileged
//! account is the keeper, limited to publishing depth samples and refreshing prices.

pub mod account;
pub mod depth;
pub mod market;
pub mod math;
pub mod position;

use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, PanicOnDefault, PromiseOrValue,
};

use account::Account;
use depth::DepthRecord;
use market::{default_markets, Market, MarketId};
use position::{Position, PositionId};

pub const MSG_DEPOSIT_MARGIN: &str = "deposit_margin";

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Markets,
    Accounts,
    Positions,
    Depth,
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
    positions: IterableMap<PositionId, Position>,
    next_position_id: PositionId,
    /// Depth history per market, oldest first.
    depth: LookupMap<MarketId, Vec<DepthRecord>>,
    /// USDC owned by the LP vault: fees, trader losses, minus trader gains paid out.
    vault_usdc: u128,
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
            positions: IterableMap::new(StorageKey::Positions),
            next_position_id: 0,
            depth: LookupMap::new(StorageKey::Depth),
            vault_usdc: 0,
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

/// Logs a NEP-297 event.
pub(crate) fn emit_event(event: &str, data: Value) {
    log!(
        "EVENT_JSON:{}",
        json!({ "standard": "ketos", "version": "1.0.0", "event": event, "data": [data] })
    );
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
