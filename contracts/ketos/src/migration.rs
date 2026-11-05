//! One-shot conversion of the deployed V2 Borsh layout. No balance reset or lazy fallback.

use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap, TreeMap, Vector};
use near_sdk::{env, near, require, AccountId};

use crate::account::Account;
use crate::depth::DepthRecord;
use crate::funding::Funding;
use crate::history::{AccountStats, HistoryEvent};
use crate::liquidation::LiquidationRecord;
use crate::market::{Market, MarketId, PriceSource, VaultId, MAX_MARKETS};
use crate::orders::{Order, OrderId, OrderRequest};
use crate::position::{Position, PositionId};
use crate::vault::{FeeLog, Revenue, Vault, VaultSnapshot};
use crate::{emit_event, Ketos, KetosExt, StorageKey};

// Field order and collection prefixes match the deployed FbrFux… V2 contract.
#[near(serializers = [borsh])]
struct LegacyKetos {
    usdc_id: AccountId,
    oracle_id: AccountId,
    outlayer_id: AccountId,
    keeper_id: AccountId,
    markets: IterableMap<MarketId, LegacyMarket>,
    oracle_markets: LookupMap<String, MarketId>,
    accounts: LookupMap<AccountId, Account>,
    positions: IterableMap<PositionId, Position>,
    next_position_id: PositionId,
    orders: IterableMap<OrderId, LegacyOrder>,
    next_order_id: OrderId,
    depth: LookupMap<MarketId, Vec<DepthRecord>>,
    liquidations: Vector<LiquidationRecord>,
    liquidation_count: u64,
    vaults: [LegacyVault; 2],
    vault_shares: [LookupMap<AccountId, u128>; 2],
    vault_history: [Vector<VaultSnapshot>; 2],
    vault_snapshot_count: u64,
    last_snapshot_at_ms: Option<u64>,
    account_stats: LookupMap<AccountId, AccountStats>,
    account_history: LookupMap<(AccountId, u16), HistoryEvent>,
    active_traders: TreeMap<(u64, AccountId), ()>,
    pnl_ranking: TreeMap<(i128, AccountId), ()>,
    volume_ranking: TreeMap<(u128, AccountId), ()>,
    trader_activity_count: u64,
}

#[near(serializers = [borsh])]
struct LegacyMarket {
    id: MarketId,
    oracle_asset_id: String,
    intents_asset_id: String,
    price_source: PriceSource,
    vault_id: VaultId,
    fee_bps: u32,
    max_leverage_cap: u32,
    hard_cap: U128,
    exit_capacity: U128,
    depth_measured_at_ms: u64,
    oi_long: U128,
    oi_short: U128,
    max_leverage: u32,
    price: U128,
    price_timestamp_ms: u64,
    borrow_index_long: U128,
    borrow_index_short: U128,
    last_accrual_ms: u64,
    funding: Funding,
    entry_units: [u128; 2],
    borrow_weight: [u128; 2],
}

impl LegacyMarket {
    fn migrate(self, now_ms: u64) -> Market {
        let ceiling = if self.vault_id == VaultId::LongTail { 5 } else { 20 };
        Market {
            id: self.id,
            oracle_asset_id: self.oracle_asset_id,
            intents_asset_id: self.intents_asset_id,
            price_source: self.price_source,
            vault_id: self.vault_id,
            fee_bps: self.fee_bps,
            max_leverage_cap: self.max_leverage_cap.min(ceiling),
            hard_cap: self.hard_cap,
            exit_capacity: self.exit_capacity,
            depth_measured_at_ms: self.depth_measured_at_ms,
            created_at_ms: now_ms,
            leverage_increased_at_ms: now_ms,
            oi_long: self.oi_long,
            oi_short: self.oi_short,
            max_leverage: self.max_leverage.min(self.max_leverage_cap).min(ceiling),
            price: self.price,
            price_timestamp_ms: self.price_timestamp_ms,
            borrow_index_long: self.borrow_index_long,
            borrow_index_short: self.borrow_index_short,
            last_accrual_ms: self.last_accrual_ms,
            funding: self.funding,
            entry_units: self.entry_units,
            borrow_weight: self.borrow_weight,
        }
    }
}

#[near(serializers = [borsh])]
struct LegacyOrder {
    id: OrderId,
    account_id: AccountId,
    request: OrderRequest,
    created_at_ms: u64,
}

#[near(serializers = [borsh])]
struct LegacyVault {
    balance: u128,
    cross_receivable: u128,
    total_shares: u128,
    revenue: Revenue,
    fee_log: FeeLog,
}

#[near]
impl Ketos {
    /// Must be in the same transaction as deploy_contract; incomplete LP lists revert both.
    #[private]
    #[init(ignore_state)]
    pub fn migrate(share_holders: Vec<AccountId>) -> Self {
        // Also enforce access in native callers, where the generated wrapper is absent.
        require!(env::predecessor_account_id() == env::current_account_id(), "ERR_PRIVATE_MIGRATION");
        let mut old: LegacyKetos = env::state_read().expect("ERR_INCOMPATIBLE_V2_STATE");
        require!(old.markets.len() <= MAX_MARKETS, "ERR_TOO_MANY_MARKETS");
        let mut share_holders = share_holders;
        share_holders.sort_unstable();
        require!(share_holders.windows(2).all(|pair| pair[0] != pair[1]), "ERR_DUPLICATE_SHARE_HOLDER");
        // LookupMap is not enumerable. Requiring exact supply coverage prevents omitted LPs
        // from silently losing claims, including holders absent from the trader index.
        for (i, held) in old.vault_shares.iter().enumerate() {
            let sum = share_holders.iter().try_fold(0u128, |sum, account| {
                sum.checked_add(held.get(account).copied().unwrap_or(0))
            }).expect("ERR_SHARE_OVERFLOW");
            require!(sum == old.vaults[i].total_shares, "ERR_INCOMPLETE_SHARE_HOLDERS");
        }
        let now_ms = env::block_timestamp_ms();
        let mut markets = IterableMap::new(StorageKey::V3Markets);
        for (id, market) in old.markets.drain() {
            markets.insert(id, market.migrate(now_ms));
        }
        let mut orders = IterableMap::new(StorageKey::V3Orders);
        for (id, order) in old.orders.drain() {
            orders.insert(id, Order {
                id: order.id,
                account_id: order.account_id,
                request: order.request,
                created_at_ms: order.created_at_ms,
                // Existing collateral is not retroactively debited to fund executor rewards.
                execution_reward: U128(0),
                wallet_funded: false,
                bracket_reserve: U128(0),
            });
        }
        let mut vault_shares = [
            LookupMap::new(StorageKey::V3VaultShares { vault_id: VaultId::Core }),
            LookupMap::new(StorageKey::V3VaultShares { vault_id: VaultId::LongTail }),
        ];
        for (i, held) in old.vault_shares.iter_mut().enumerate() {
            for account in &share_holders {
                if let Some(shares) = held.remove(account) {
                    if shares > 0 {
                        vault_shares[i].insert(account.clone(), (0, shares));
                    }
                }
            }
        }
        let contract = Self {
            usdc_id: old.usdc_id,
            oracle_id: old.oracle_id,
            outlayer_id: old.outlayer_id,
            keeper_id: old.keeper_id,
            markets,
            oracle_markets: old.oracle_markets,
            accounts: old.accounts,
            positions: old.positions,
            next_position_id: old.next_position_id,
            orders,
            next_order_id: old.next_order_id,
            depth: old.depth,
            liquidations: old.liquidations,
            liquidation_count: old.liquidation_count,
            vaults: old.vaults.map(|vault| Vault {
                balance: vault.balance,
                cross_receivable: vault.cross_receivable,
                total_shares: vault.total_shares,
                share_epoch: 0,
                revenue: vault.revenue,
                fee_log: vault.fee_log,
            }),
            vault_shares,
            vault_history: old.vault_history,
            vault_snapshot_count: old.vault_snapshot_count,
            last_snapshot_at_ms: old.last_snapshot_at_ms,
            account_stats: old.account_stats,
            account_history: old.account_history,
            active_traders: old.active_traders,
            pnl_ranking: old.pnl_ranking,
            volume_ranking: old.volume_ranking,
            trader_activity_count: old.trader_activity_count,
            last_price_request_ms: None,
            price_deposits: LookupMap::new(StorageKey::PriceDeposits),
            price_deposits_total: 0,
            price_signer: None,
        };
        emit_event("state_migrated", near_sdk::serde_json::json!({
            "from": 2, "to": 3, "markets": contract.markets.len(),
            "orders": contract.orders.len(), "share_holders": share_holders.len(),
        }));
        contract
    }
}

#[cfg(test)]
#[path = "tests/migration.rs"]
mod tests;
