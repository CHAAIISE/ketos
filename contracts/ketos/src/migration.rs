//! Atomic schema-5 to schema-6 upgrade. Existing collection handles and claims retain identity.
use near_sdk::store::{IterableMap, LookupMap, LookupSet, TreeMap, Vector};
use near_sdk::{env, near, require, AccountId, PublicKey};
use crate::account::Account;
use crate::depth::DepthRecord;
use crate::hedge::{HedgeConfig, HedgeState};
use crate::history::{AccountStats, HistoryEvent};
use crate::liquidation::LiquidationRecord;
use crate::market::{Market, MarketId, VaultId};
use crate::orders::{Order, OrderId};
use crate::position::{Position, PositionId};
use crate::vault::Vault;
use crate::{emit_event, Ketos, KetosExt};

// Exact deployed schema-5 order, including live isolated vaults and callback leases.
#[near(serializers = [borsh])]
struct LegacyKetos {
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
    depth: LookupMap<MarketId, Vec<DepthRecord>>,
    liquidations: Vector<LiquidationRecord>,
    liquidation_count: u64,
    vaults: IterableMap<VaultId, Vault>,
    account_stats: LookupMap<AccountId, AccountStats>,
    account_history: LookupMap<(AccountId, u16), HistoryEvent>,
    active_traders: TreeMap<(u64, AccountId), ()>,
    pnl_ranking: TreeMap<(i128, AccountId), ()>,
    volume_ranking: TreeMap<(u128, AccountId), ()>,
    trader_activity_count: u64,
    last_price_request_ms: Option<u64>,
    price_deposits: LookupMap<AccountId, u128>,
    price_deposits_total: u128,
    price_signer: Option<PublicKey>,
    pending_price_actions: LookupSet<u64>,
    next_price_action_id: u64,
    schema_version: u32,
}

#[near]
impl Ketos {
    #[private]
    #[init(ignore_state)]
    pub fn migrate(hedge_config: HedgeConfig) -> Self {
        require!(env::predecessor_account_id() == env::current_account_id(), "ERR_PRIVATE_MIGRATION");
        let old = env::storage_read(b"STATE")
            .and_then(|state| near_sdk::borsh::from_slice::<LegacyKetos>(&state).ok())
            .expect("ERR_INCOMPATIBLE_V5_STATE");
        require!(old.schema_version == 5, "ERR_INCOMPATIBLE_V5_STATE");
        let contract = Self {
            usdc_id: old.usdc_id, oracle_id: old.oracle_id, outlayer_id: old.outlayer_id,
            keeper_id: old.keeper_id, markets: old.markets, oracle_markets: old.oracle_markets,
            accounts: old.accounts, positions: old.positions, next_position_id: old.next_position_id,
            orders: old.orders, next_order_id: old.next_order_id, depth: old.depth,
            liquidations: old.liquidations, liquidation_count: old.liquidation_count, vaults: old.vaults,
            account_stats: old.account_stats, account_history: old.account_history,
            active_traders: old.active_traders, pnl_ranking: old.pnl_ranking, volume_ranking: old.volume_ranking,
            trader_activity_count: old.trader_activity_count, last_price_request_ms: old.last_price_request_ms,
            price_deposits: old.price_deposits, price_deposits_total: old.price_deposits_total,
            price_signer: old.price_signer, pending_price_actions: old.pending_price_actions,
            next_price_action_id: old.next_price_action_id, schema_version: 6,
            hedge: Some(HedgeState::new(hedge_config)),
        };
        emit_event("state_migrated", near_sdk::serde_json::json!({"from":5,"to":6,"external_assets_recognized":"0"}));
        contract
    }
}

#[cfg(test)]
#[path = "tests/migration.rs"]
mod tests;
