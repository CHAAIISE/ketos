//! Action-scoped oracle pulls and prepaid NEAR for vault transfer callbacks.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::{
    assert_one_yocto, env, log, near, require, AccountId, Gas, GasWeight, NearToken,
    Promise, PromiseError, PromiseOrValue,
};

use crate::cross::MarginMode;
use crate::market::{MarketId, PriceSource, VaultId, MAX_OPEN_PRICE_AGE_MS};
use crate::oracle::ORACLE_CALL_DEPOSIT;
use crate::orders::{Brackets, OrderRequest};
use crate::position::Side;
use crate::worker_prices::{WORKER_BATCH_SIZE, WORKER_DEPOSIT};
use crate::{Ketos, KetosExt};

pub const ACTION_CACHE_MAX_AGE_MS: u64 = 15_000;
const REQUEST_GAS: Gas = Gas::from_tgas(20);
const WORKER_CALLBACK_GAS: Gas = Gas::from_tgas(20);
const RESULTS_CALLBACK_GAS: Gas = Gas::from_tgas(5);
const ACTION_CALLBACK_GAS: Gas = Gas::from_tgas(80);
const MAX_REQUEST_RESULT_BYTES: usize = 4_096;

/// The original actor travels with the request; callback predecessors are not users.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub enum PullAction {
    MarketPrice {
        market_id: MarketId,
    },
    Open {
        account_id: AccountId,
        market_id: MarketId,
        side: Side,
        margin: U128,
        leverage: u32,
        brackets: Option<Brackets>,
        margin_mode: MarginMode,
    },
    Close {
        account_id: AccountId,
        position_id: u64,
    },
    PlaceOrder {
        account_id: AccountId,
        request: OrderRequest,
    },
    ExecuteOrders {
        executor: AccountId,
        ids: Vec<u64>,
    },
    Liquidate {
        liquidator: AccountId,
        position_id: u64,
    },
    LiquidateCross {
        liquidator: AccountId,
        account_id: AccountId,
    },
    WithdrawVault {
        account_id: AccountId,
        vault_id: VaultId,
        shares: U128,
    },
    DepositVault {
        account_id: AccountId,
        vault_id: VaultId,
        amount: U128,
    },
}

impl PullAction {
    fn cancelled_value(&self) -> Value {
        match self {
            Self::DepositVault { amount, .. } => json!(amount),
            _ => Value::Null,
        }
    }

    fn permits_failed_pull_exit(&self) -> bool {
        matches!(self, Self::Close { .. } | Self::ExecuteOrders { .. })
    }
}

impl Ketos {
    /// `None` leaves execution to the synchronous caller after refunding unused NEAR.
    pub(crate) fn pull_for_action(
        &mut self,
        action: PullAction,
        market_ids: Vec<MarketId>,
    ) -> Option<Promise> {
        let requests = self.stale_action_markets(market_ids);
        let required = self.action_request_cost(requests.iter().map(|(id, _)| id));
        let caller = env::predecessor_account_id();
        let attached = env::attached_deposit().as_yoctonear();
        let attached = if matches!(&action, PullAction::WithdrawVault { .. }) {
            require!(attached >= 1, "ERR_ONE_YOCTO_REQUIRED");
            attached - 1
        } else {
            attached
        };
        require!(
            caller == self.keeper_id || attached >= required,
            "ERR_ORACLE_DEPOSIT_REQUIRED"
        );
        let refund = attached.saturating_sub(required);
        self.require_price_request_balance(required, refund);
        Self::refund_price_near(caller, refund);
        self.schedule_action_prices(action, requests)
    }

    /// NEP-141 forwards no NEAR, so its sender prepays in a separate wallet action.
    pub(crate) fn pull_for_vault_deposit(
        &mut self,
        account_id: AccountId,
        vault_id: VaultId,
        amount: U128,
    ) -> Option<Promise> {
        let market_ids = self.vault_price_market_ids(vault_id);
        let requests = self.stale_action_markets(market_ids);
        let required = self.action_request_cost(requests.iter().map(|(id, _)| id));
        let credit = self.price_deposits.get(&account_id).copied().unwrap_or(0);
        // A receiver failure lets the FT resolver return all USDC; credit stays intact.
        require!(credit >= required, "ERR_ORACLE_DEPOSIT_REQUIRED");
        self.take_price_deposit(&account_id, credit);
        let refund = credit - required;
        self.require_price_request_balance(required, refund);
        Self::refund_price_near(account_id.clone(), refund);
        self.schedule_action_prices(
            PullAction::DepositVault {
                account_id,
                vault_id,
                amount,
            },
            requests,
        )
    }

    pub(crate) fn vault_price_market_ids(&self, vault_id: VaultId) -> Vec<MarketId> {
        self.markets
            .values()
            .filter(|market| market.vault_id == vault_id)
            .map(|market| market.id.clone())
            .collect()
    }

    pub(crate) fn open_price_market_ids(
        &self,
        market: &MarketId,
        account: &AccountId,
        mode: MarginMode,
    ) -> Vec<MarketId> {
        let mut ids = vec![market.clone()];
        if mode == MarginMode::Cross {
            ids.extend(self.cross_price_market_ids(account));
        }
        ids
    }

    pub(crate) fn position_price_market_ids(&self, position_id: u64) -> Vec<MarketId> {
        self.positions
            .get(&position_id)
            .map(|position| vec![position.market_id.clone()])
            .unwrap_or_default()
    }

    pub(crate) fn orders_price_market_ids(&self, ids: &[u64]) -> Vec<MarketId> {
        let mut markets = Vec::new();
        for id in ids {
            let Some(order) = self.orders.get(id) else {
                continue;
            };
            match &order.request {
                OrderRequest::Limit(entry) | OrderRequest::StopMarket(entry) => {
                    markets.extend(self.open_price_market_ids(
                        &entry.market_id,
                        &order.account_id,
                        entry.margin_mode,
                    ));
                }
                OrderRequest::TakeProfit { position_id, .. }
                | OrderRequest::StopLoss { position_id, .. } => {
                    markets.extend(self.position_price_market_ids(*position_id));
                }
            }
        }
        markets
    }

    pub(crate) fn cross_price_market_ids(&self, account_id: &AccountId) -> Vec<MarketId> {
        self.accounts
            .get(account_id)
            .into_iter()
            .flat_map(|account| account.cross_positions.iter())
            .filter_map(|id| self.positions.get(id))
            .map(|position| position.market_id.clone())
            .collect()
    }

    fn stale_action_markets(&self, mut market_ids: Vec<MarketId>) -> Vec<(MarketId, u64)> {
        market_ids.sort_unstable();
        market_ids.dedup();
        let now_ms = env::block_timestamp_ms();
        market_ids
            .into_iter()
            .filter_map(|id| {
                let market = self.markets.get(&id).expect("ERR_UNKNOWN_MARKET");
                if market.price.0 > 0
                    && market.price_timestamp_ms <= now_ms
                    && now_ms - market.price_timestamp_ms <= ACTION_CACHE_MAX_AGE_MS
                {
                    None
                } else {
                    Some((id, market.price_timestamp_ms))
                }
            })
            .collect()
    }

    fn action_request_cost<'a>(&self, ids: impl Iterator<Item = &'a MarketId>) -> u128 {
        let mut tee = false;
        let mut workers = 0usize;
        for id in ids {
            match self.markets.get(id).expect("ERR_UNKNOWN_MARKET").price_source {
                PriceSource::Tee => tee = true,
                PriceSource::OutlayerWorker => workers += 1,
                PriceSource::Signed => env::panic_str("ERR_UNSUPPORTED_PRICE_SOURCE"),
            }
        }
        u128::from(tee) * ORACLE_CALL_DEPOSIT.as_yoctonear()
            + workers.div_ceil(WORKER_BATCH_SIZE) as u128 * WORKER_DEPOSIT.as_yoctonear()
    }
    fn quoted_action_cost(&self, mut market_ids: Vec<MarketId>) -> U128 {
        market_ids.sort_unstable();
        market_ids.dedup();
        U128(self.action_request_cost(market_ids.iter()))
    }


    fn require_price_request_balance(&self, required: u128, refund: u128) {
        let storage = env::storage_byte_cost()
            .saturating_mul(u128::from(env::storage_usage()))
            .as_yoctonear();
        let reserved = storage
            .checked_add(self.price_deposits_total)
            .and_then(|amount| amount.checked_add(refund))
            .and_then(|amount| amount.checked_add(required));
        require!(
            reserved.is_some_and(|amount| env::account_balance().as_yoctonear() >= amount),
            "ERR_ORACLE_FUNDS_LOW"
        );
    }

    fn take_price_deposit(&mut self, account_id: &AccountId, amount: u128) {
        if amount > 0 {
            self.price_deposits.remove(account_id);
            self.price_deposits_total = self
                .price_deposits_total
                .checked_sub(amount)
                .expect("ERR_PRICE_DEPOSIT_ACCOUNTING");
            self.price_deposits.flush();
        }
    }

    fn refund_price_near(account_id: AccountId, amount: u128) {
        if amount > 0 {
            Promise::new(account_id)
                .transfer(NearToken::from_yoctonear(amount))
                .detach();
        }
    }

    fn schedule_action_prices(
        &self,
        action: PullAction,
        requests: Vec<(MarketId, u64)>,
    ) -> Option<Promise> {
        let requested_at_ms = env::block_timestamp_ms();
        let mut tee = Vec::new();
        let mut workers = Vec::new();
        for (id, _) in &requests {
            let market = self.markets.get(id).expect("ERR_UNKNOWN_MARKET");
            match market.price_source {
                PriceSource::Tee => tee.push(market.oracle_asset_id.as_str()),
                PriceSource::OutlayerWorker => workers.push(market.oracle_asset_id.as_str()),
                PriceSource::Signed => env::panic_str("ERR_UNSUPPORTED_PRICE_SOURCE"),
            }
        }
        let mut expected_counts = Vec::new();
        let mut joint = if tee.is_empty() {
            None
        } else {
            expected_counts.push(tee.len() as u32);
            Some(Promise::new(self.oracle_id.clone()).function_call_weight(
                "oracle_call".to_string(),
                json!({
                    "receiver_id": env::current_account_id(),
                    "asset_ids": tee,
                    "msg": json!({ "requested_at_ms": requested_at_ms }).to_string(),
                }).to_string().into_bytes(),
                ORACLE_CALL_DEPOSIT, REQUEST_GAS, GasWeight(3),
            ))
        };
        for assets in workers.chunks(WORKER_BATCH_SIZE) {
            expected_counts.push(assets.len() as u32);
            let request = self.request_worker_prices_with_gas(
                assets, REQUEST_GAS, WORKER_CALLBACK_GAS, Some(requested_at_ms),
            );
            joint = Some(match joint {
                Some(previous) => previous.and(request),
                None => request,
            });
        }
        joint.map(|request| {
            request
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(RESULTS_CALLBACK_GAS)
                        .with_unused_gas_weight(0)
                        .on_action_price_results(expected_counts),
                )
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(ACTION_CALLBACK_GAS)
                        .with_unused_gas_weight(0)
                        .on_action_prices(action, requests, requested_at_ms),
                )
        })
    }
}

#[near]
impl Ketos {
    /// A joint promise has multiple results; checking only result zero misses failures.
    #[private]
    pub fn on_action_price_results(&self, expected_counts: Vec<u32>) -> bool {
        let count = env::promise_results_count();
        count > 0 && count == expected_counts.len() as u64
            && expected_counts.iter().enumerate().all(|(index, expected)| {
                env::promise_result_checked(index as u64, MAX_REQUEST_RESULT_BYTES)
                    .ok().and_then(|bytes| near_sdk::serde_json::from_slice::<u32>(&bytes).ok())
                    == Some(*expected)
            })
    }

    #[private]
    pub fn on_action_prices(
        &mut self,
        action: PullAction,
        requests: Vec<(MarketId, u64)>,
        requested_at_ms: u64,
        #[callback_result] result: Result<Value, PromiseError>,
    ) -> PromiseOrValue<Value> {
        let now_ms = env::block_timestamp_ms();
        let prices_received = matches!(result, Ok(Value::Bool(true)))
            && !requests.is_empty()
            && requests.iter().all(|(id, previous_timestamp)| {
                self.markets.get(id).is_some_and(|market| {
                    market.price.0 > 0
                        && market.price_timestamp_ms > *previous_timestamp
                        && market.price_timestamp_ms >= requested_at_ms
                        && market.price_timestamp_ms <= now_ms
                        && now_ms - market.price_timestamp_ms <= MAX_OPEN_PRICE_AGE_MS
                })
            });
        let cancelled = action.cancelled_value();
        let refunds_tokens = matches!(&action, PullAction::DepositVault { .. });
        if !prices_received && !action.permits_failed_pull_exit() {
            log!("price action cancelled: ERR_ACTION_PRICE_UNAVAILABLE");
            return PromiseOrValue::Value(cancelled);
        }
        match self.execute_priced_action(action, !prices_received) {
            Ok(result) => result,
            Err(error) => {
                if !refunds_tokens {
                    env::panic_str(&error);
                }
                log!("price action cancelled: {}", error);
                PromiseOrValue::Value(cancelled)
            }
        }
    }

    /// Funds only the caller's next vault transfer price requests; no pull is scheduled.
    #[payable]
    pub fn fund_price_requests(&mut self) -> U128 {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "ERR_ZERO_AMOUNT");
        let account_id = env::predecessor_account_id();
        let credit = self
            .price_deposits
            .get(&account_id)
            .copied()
            .unwrap_or(0)
            .checked_add(amount)
            .expect("ERR_OVERFLOW");
        self.price_deposits_total = self
            .price_deposits_total
            .checked_add(amount)
            .expect("ERR_OVERFLOW");
        self.price_deposits.insert(account_id, credit);
        self.price_deposits.flush();
        self.require_price_request_balance(0, 0);
        U128(credit)
    }

    #[payable]
    pub fn withdraw_price_deposit(&mut self) -> U128 {
        assert_one_yocto();
        let account_id = env::predecessor_account_id();
        let credit = self.price_deposits.get(&account_id).copied().unwrap_or(0);
        self.take_price_deposit(&account_id, credit);
        self.require_price_request_balance(0, credit);
        Self::refund_price_near(account_id, credit);
        U128(credit)
    }

    pub fn get_price_deposit(&self, account_id: AccountId) -> U128 {
        U128(self.price_deposits.get(&account_id).copied().unwrap_or(0))
    }
    /// Funded single-market pull, also used to price a newly registered market.
    #[payable]
    pub fn pull_market_price(&mut self, market_id: MarketId) -> PromiseOrValue<U128> {
        let action = PullAction::MarketPrice { market_id: market_id.clone() };
        if let Some(promise) = self.pull_for_action(action, vec![market_id.clone()]) {
            return PromiseOrValue::Promise(promise);
        }
        PromiseOrValue::Value(U128(
            self.markets.get(&market_id).expect("ERR_UNKNOWN_MARKET")
                .fresh_price(env::block_timestamp_ms()),
        ))
    }


    /// Upper bound independent of cache age: wallet approval can outlive a cache hit.
    /// Execution refunds all unused adapter funding.
    pub fn get_price_request_deposit(&self, market: MarketId) -> U128 {
        self.quoted_action_cost(vec![market])
    }

    pub fn get_open_price_request_deposit(
        &self,
        market: MarketId,
        account_id: AccountId,
        margin_mode: Option<MarginMode>,
    ) -> U128 {
        let ids = self.open_price_market_ids(
            &market,
            &account_id,
            margin_mode.unwrap_or_default(),
        );
        self.quoted_action_cost(ids)
    }

    pub fn get_vault_price_request_deposit(&self, vault_id: VaultId) -> U128 {
        self.quoted_action_cost(self.vault_price_market_ids(vault_id))
    }

    pub fn get_position_price_request_deposit(&self, position_id: u64) -> U128 {
        self.quoted_action_cost(self.position_price_market_ids(position_id))
    }

    pub fn get_orders_price_request_deposit(&self, ids: Vec<u64>) -> U128 {
        self.quoted_action_cost(self.orders_price_market_ids(&ids))
    }

    pub fn get_cross_price_request_deposit(&self, account_id: AccountId) -> U128 {
        self.quoted_action_cost(self.cross_price_market_ids(&account_id))
    }
}
