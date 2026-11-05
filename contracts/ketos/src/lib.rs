//! Ketos perpetual futures: isolated and cross margin against LP vaults, with open interest
//! capped by conservative vault capital and exit liquidity measured on NEAR Intents.
//!
//! There is no admin method that can pause markets or move user funds: the only privileged
//! account is the keeper, limited to publishing depth samples. Prices come from the oracle.

pub mod account;
pub mod cross;
pub mod depth;
pub mod funding;
pub mod history;
pub mod liquidation;
pub mod listing;
pub mod market;
pub mod math;
pub mod oracle;
pub mod orders;
pub mod position;
pub mod pull_prices;
mod priced_actions;
pub mod signed_prices;
pub mod vault;
pub mod worker_prices;

use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{IterableMap, LookupMap, TreeMap, Vector};
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, PanicOnDefault, PromiseOrValue,
};

use account::Account;
use depth::DepthRecord;
use history::{AccountStats, HistoryEvent};
use liquidation::LiquidationRecord;
use market::{default_markets, Market, MarketId, VaultId};
use orders::{Order, OrderId};
use position::{Position, PositionId};
use vault::{Vault, VaultSnapshot};

pub const MSG_DEPOSIT_MARGIN: &str = "deposit_margin";
pub const MSG_DEPOSIT_VAULT: &str = "deposit_vault:";

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Markets,
    Accounts,
    Positions,
    Depth,
    Liquidations,
    VaultShares { vault_id: VaultId },
    OracleMarkets,
    Orders,
    VaultHistory { vault_id: VaultId },
    AccountStats,
    AccountHistory,
    ActiveTraders,
    PnlRanking,
    VolumeRanking,
    PriceDeposits,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub usdc_id: AccountId,
    pub oracle_id: AccountId,
    pub outlayer_id: AccountId,
    pub keeper_id: AccountId,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Ketos {
    usdc_id: AccountId,
    oracle_id: AccountId,
    outlayer_id: AccountId,
    keeper_id: AccountId,
    markets: IterableMap<MarketId, Market>,
    oracle_markets: LookupMap<String, MarketId>,
    accounts: LookupMap<AccountId, Account>,
    positions: IterableMap<PositionId, Position>,
    next_position_id: PositionId,
    orders: IterableMap<OrderId, Order>,
    next_order_id: OrderId,
    /// Depth history per market, oldest first.
    depth: LookupMap<MarketId, Vec<DepthRecord>>,
    /// Ring of the last `LIQUIDATION_HISTORY_LEN` liquidations.
    liquidations: Vector<LiquidationRecord>,
    liquidation_count: u64,
    vaults: [Vault; 2],
    /// Epoch-tagged balances prevent wiped-out LP shares from reviving after recapitalization.
    vault_shares: [LookupMap<AccountId, (u64, u128)>; 2],
    vault_history: [Vector<VaultSnapshot>; 2],
    vault_snapshot_count: u64,
    last_snapshot_at_ms: Option<u64>,
    account_stats: LookupMap<AccountId, AccountStats>,
    account_history: LookupMap<(AccountId, u16), HistoryEvent>,
    active_traders: TreeMap<(u64, AccountId), ()>,
    pnl_ranking: TreeMap<(i128, AccountId), ()>,
    volume_ranking: TreeMap<(u128, AccountId), ()>,
    trader_activity_count: u64,
    /// Request lease and prepaid oracle credits require migration on existing deployments.
    last_price_request_ms: Option<u64>,
    price_deposits: LookupMap<AccountId, u128>,
    price_deposits_total: u128,
    price_signer: Option<near_sdk::PublicKey>,
}

#[near]
impl Ketos {
    #[init]
    pub fn new(
        usdc_id: AccountId,
        oracle_id: AccountId,
        keeper_id: AccountId,
        outlayer_id: AccountId,
    ) -> Self {
        let mut contract = Self {
            usdc_id,
            oracle_id,
            outlayer_id,
            keeper_id,
            markets: IterableMap::new(StorageKey::Markets),
            oracle_markets: LookupMap::new(StorageKey::OracleMarkets),
            accounts: LookupMap::new(StorageKey::Accounts),
            positions: IterableMap::new(StorageKey::Positions),
            next_position_id: 0,
            orders: IterableMap::new(StorageKey::Orders),
            next_order_id: 0,
            depth: LookupMap::new(StorageKey::Depth),
            liquidations: Vector::new(StorageKey::Liquidations),
            liquidation_count: 0,
            vaults: [Vault::default(), Vault::default()],
            vault_shares: [
                LookupMap::new(StorageKey::VaultShares { vault_id: VaultId::Core }),
                LookupMap::new(StorageKey::VaultShares { vault_id: VaultId::LongTail }),
            ],
            vault_history: [
                Vector::new(StorageKey::VaultHistory { vault_id: VaultId::Core }),
                Vector::new(StorageKey::VaultHistory { vault_id: VaultId::LongTail }),
            ],
            vault_snapshot_count: 0,
            last_snapshot_at_ms: None,
            account_stats: LookupMap::new(StorageKey::AccountStats),
            account_history: LookupMap::new(StorageKey::AccountHistory),
            active_traders: TreeMap::new(StorageKey::ActiveTraders),
            pnl_ranking: TreeMap::new(StorageKey::PnlRanking),
            volume_ranking: TreeMap::new(StorageKey::VolumeRanking),
            trader_activity_count: 0,
            last_price_request_ms: None,
            price_deposits: LookupMap::new(StorageKey::PriceDeposits),
            price_deposits_total: 0,
            price_signer: None,
        };
        for config in default_markets() {
            contract.register_market(config);
        }
        contract
    }

    pub fn get_config(&self) -> Config {
        Config {
            usdc_id: self.usdc_id.clone(),
            oracle_id: self.oracle_id.clone(),
            outlayer_id: self.outlayer_id.clone(),
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
impl FungibleTokenReceiver for Ketos {
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
            _ if msg.starts_with(MSG_DEPOSIT_VAULT) => {
                let (vault_id, signed_prices) = match &msg[MSG_DEPOSIT_VAULT.len()..] {
                    "core" => (VaultId::Core, None),
                    "long-tail" => (VaultId::LongTail, None),
                    encoded => {
                        let request: signed_prices::VaultDepositRequest =
                            near_sdk::serde_json::from_str(encoded)
                                .unwrap_or_else(|_| env::panic_str("ERR_UNKNOWN_VAULT"));
                        (request.vault_id, request.signed_prices)
                    }
                };
                require!(amount.0 >= vault::MIN_VAULT_DEPOSIT, "ERR_MIN_VAULT_DEPOSIT: 1 USDC");
                if let Some(request) = self.pull_for_vault_deposit(sender_id.clone(), vault_id, amount, signed_prices) {
                    return PromiseOrValue::Promise(request);
                }
                self.deposit_vault(vault_id, &sender_id, amount.0);
            }
            _ if msg.starts_with(listing::MSG_LIST_MARKET) => {
                self.list_market(&sender_id, amount.0, &msg[listing::MSG_LIST_MARKET.len()..]);
            }
            _ => env::panic_str("ERR_INVALID_MSG"),
        }
        PromiseOrValue::Value(U128(0))
    }
}

#[cfg(test)]
mod tests;
