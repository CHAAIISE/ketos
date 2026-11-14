use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, PromiseOrValue};

use crate::cross::MarginMode;
use crate::history::{HistoryEvent, HistoryKind};
use crate::market::{MarketId, MAX_OPEN_PRICE_AGE_MS};
use crate::math::trade_fee;
use crate::position::{ExecutionBounds, Position, PositionId, Side, MIN_POSITION_MARGIN};
use crate::market::USD;
use crate::{emit_event, Ketos, KetosExt};

pub type OrderId = u64;
pub const MAX_OPEN_ORDERS: usize = 50;
pub const MAX_EXECUTE_ORDERS: usize = 50;

pub(crate) fn execution_reward(size: u128) -> u128 {
    trade_fee(size, 5).max(USD / 10)
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Brackets {
    pub take_profit: Option<U128>,
    pub stop_loss: Option<U128>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BracketBounds {
    pub take_profit: Option<ExecutionBounds>,
    pub stop_loss: Option<ExecutionBounds>,
}

impl BracketBounds {
    pub(crate) fn validate_for(brackets: Option<&Brackets>, bounds: Option<&Self>, now_ms: u64) -> Result<(), String> {
        let take_profit = bounds.and_then(|bounds| bounds.take_profit);
        let stop_loss = bounds.and_then(|bounds| bounds.stop_loss);
        if brackets.and_then(|brackets| brackets.take_profit).is_some() != take_profit.is_some()
            || brackets.and_then(|brackets| brackets.stop_loss).is_some() != stop_loss.is_some()
        {
            return Err("ERR_BRACKET_EXECUTION_REQUIRED".into());
        }
        for bound in [take_profit, stop_loss].into_iter().flatten() {
            bound.validate(now_ms)?;
        }
        Ok(())
    }
}

impl Brackets {
    pub(crate) fn count(&self) -> usize {
        usize::from(self.take_profit.is_some()) + usize::from(self.stop_loss.is_some())
    }

    fn validate(&self, side: Side, price: u128) -> Result<(), String> {
        if let Some(tp) = self.take_profit {
            if tp.0 == 0
                || (if side == Side::Long {
                    tp.0 <= price
                } else {
                    tp.0 >= price
                })
            {
                return Err("ERR_INVALID_TAKE_PROFIT".into());
            }
        }
        if let Some(sl) = self.stop_loss {
            if sl.0 == 0
                || (if side == Side::Long {
                    sl.0 >= price
                } else {
                    sl.0 <= price
                })
            {
                return Err("ERR_INVALID_STOP_LOSS".into());
            }
        }
        Ok(())
    }
}

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BracketOrderIds {
    pub take_profit: Option<OrderId>,
    pub stop_loss: Option<OrderId>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct BracketAmendment {
    pub position_id: PositionId,
    /// Both identifiers bind the replacement to the state the owner reviewed.
    pub expected: BracketOrderIds,
    pub brackets: Brackets,
    pub execution: BracketBounds,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntryOrder {
    pub market_id: MarketId,
    pub side: Side,
    pub margin: U128,
    pub leverage: u32,
    pub trigger_price: U128,
    pub brackets: Option<Brackets>,
    #[serde(default)]
    pub margin_mode: MarginMode,
}

#[near(serializers = [json, borsh])]
#[serde(tag = "kind", rename_all = "snake_case")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OrderRequest {
    Limit(EntryOrder),
    StopMarket(EntryOrder),
    TakeProfit {
        position_id: PositionId,
        trigger_price: U128,
    },
    StopLoss {
        position_id: PositionId,
        trigger_price: U128,
    },
}

impl OrderRequest {
    pub(crate) fn entry(&self) -> Option<&EntryOrder> {
        match self {
            Self::Limit(entry) | Self::StopMarket(entry) => Some(entry),
            _ => None,
        }
    }

    fn position_id(&self) -> Option<PositionId> {
        match self {
            Self::TakeProfit { position_id, .. } | Self::StopLoss { position_id, .. } => {
                Some(*position_id)
            }
            _ => None,
        }
    }

    fn is_take_profit(&self) -> bool {
        matches!(self, Self::TakeProfit { .. })
    }

    fn trigger_price(&self) -> u128 {
        match self {
            Self::Limit(entry) | Self::StopMarket(entry) => entry.trigger_price.0,
            Self::TakeProfit { trigger_price, .. } | Self::StopLoss { trigger_price, .. } => {
                trigger_price.0
            }
        }
    }

    fn triggered(&self, side: Side, price: u128) -> bool {
        let above = match self {
            Self::Limit(_) | Self::StopLoss { .. } => side == Side::Short,
            Self::StopMarket(_) | Self::TakeProfit { .. } => side == Side::Long,
        };
        if above {
            price >= self.trigger_price()
        } else {
            price <= self.trigger_price()
        }
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Order {
    pub id: OrderId,
    pub account_id: AccountId,
    pub request: OrderRequest,
    pub created_at_ms: u64,
    /// Separate USDC collateral, refunded on cancellation or paid exactly once on fill.
    pub execution_reward: U128,
    pub wallet_funded: bool,
    /// Future bracket rewards reserved by wallet-funded entry orders.
    pub bracket_reserve: U128,
    /// Migrated orders have no invented authorization: they remain cancellable, never executable.
    pub execution: Option<ExecutionBounds>,
    pub bracket_bounds: Option<BracketBounds>,
}

#[near(serializers = [json])]
#[serde(tag = "status", rename_all = "snake_case")]
#[derive(Debug, PartialEq, Eq)]
pub enum OrderExecution {
    Skipped {
        order_id: OrderId,
    },
    Filled {
        order_id: OrderId,
        position_id: PositionId,
        price: U128,
    },
    Rejected {
        order_id: OrderId,
        reason: String,
    },
}

impl Ketos {
    fn amendable_position(&self, account_id: &AccountId, request: &BracketAmendment) -> Result<&Position, String> {
        let position = self.positions.get(&request.position_id).ok_or("ERR_NO_POSITION")?;
        if position.account_id != *account_id { return Err("ERR_NOT_OWNER".into()); }
        if position.take_profit != request.expected.take_profit || position.stop_loss != request.expected.stop_loss {
            return Err("ERR_BRACKETS_CHANGED".into());
        }
        Ok(position)
    }

    pub(crate) fn try_amend_brackets_for(
        &mut self, account_id: AccountId, request: BracketAmendment, to_wallet: bool,
    ) -> Result<PromiseOrValue<U128>, String> {
        let position = self.amendable_position(&account_id, &request)?;
        let now_ms = env::block_timestamp_ms();
        BracketBounds::validate_for(Some(&request.brackets), Some(&request.execution), now_ms)?;
        let slots = request.brackets.count();
        if slots > 0 {
            let market = self.markets.get(&position.market_id).ok_or("ERR_UNKNOWN_MARKET")?;
            if market.price.0 == 0 { return Err("ERR_NO_PRICE".into()); }
            if market.price_timestamp_ms > now_ms || now_ms - market.price_timestamp_ms > crate::market::MAX_PRICE_AGE_MS {
                return Err("ERR_STALE_PRICE".into());
            }
            request.brackets.validate(position.side, market.price.0)?;
        }
        let previous = [position.take_profit, position.stop_loss];
        let mut released_rewards = 0u128;
        for id in previous.into_iter().flatten() {
            let order = self.orders.get(&id).ok_or("ERR_NO_ORDER")?;
            released_rewards = released_rewards.checked_add(order.execution_reward.0)
                .and_then(|value| value.checked_add(order.bracket_reserve.0)).ok_or("ERR_OVERFLOW")?;
        }
        let account = self.accounts.get(&account_id).ok_or("ERR_NO_ACCOUNT")?;
        let old_slots = previous.iter().flatten().count();
        if account.orders.len() - old_slots + slots > MAX_OPEN_ORDERS {
            return Err("ERR_TOO_MANY_ORDERS".into());
        }
        let required = execution_reward(position.size).checked_mul(slots as u128).ok_or("ERR_OVERFLOW")?;
        let before = account.margin;
        if before.checked_add(released_rewards).ok_or("ERR_OVERFLOW")? < required {
            return Err("ERR_INSUFFICIENT_MARGIN".into());
        }
        // No reservation or linked order changes before every validation succeeds.
        for id in previous.into_iter().flatten() {
            self.remove_order(id);
            emit_event("order_cancelled", json!({ "order_id": id, "reason": "brackets_amended" }));
        }
        self.attach_brackets(request.position_id, Some(request.brackets), Some(request.execution));
        let released = U128(self.accounts.get(&account_id).unwrap().margin.saturating_sub(before));
        let position = self.positions.get(&request.position_id).unwrap();
        emit_event("position_brackets_amended", json!({
            "position_id": request.position_id, "account_id": account_id,
            "previous": request.expected, "take_profit": position.take_profit,
            "stop_loss": position.stop_loss, "released_rewards": released,
        }));
        Ok(if to_wallet && released.0 > 0 {
            PromiseOrValue::Promise(self.send_margin_to_wallet(account_id, released))
        } else {
            PromiseOrValue::Value(released)
        })
    }

    /// Shared, mutation-free admission check for immediate and triggered entries.
    pub(crate) fn opening_terms(
        &self,
        account_id: &AccountId,
        market_id: &MarketId,
        side: Side,
        margin: u128,
        leverage: u32,
        brackets: Option<&Brackets>,
        now_ms: u64,
    ) -> Result<(u128, u128, u128), String> {
        if margin < MIN_POSITION_MARGIN {
            return Err("ERR_MIN_POSITION_MARGIN: 1 USDC".into());
        }
        let market = self.markets.get(market_id).ok_or("ERR_UNKNOWN_MARKET")?;
        if let Some(reason) = market.closed_reason(now_ms) {
            return Err(reason.into());
        }
        if leverage == 0 {
            return Err("ERR_LEVERAGE_TOO_LOW".into());
        }
        if leverage > market.max_leverage {
            return Err(format!(
                "ERR_LEVERAGE_TOO_HIGH: max {}",
                market.max_leverage
            ));
        }
        if market.price.0 == 0 {
            return Err("ERR_NO_PRICE".into());
        }
        if now_ms.saturating_sub(market.price_timestamp_ms) > MAX_OPEN_PRICE_AGE_MS {
            return Err("ERR_STALE_PRICE".into());
        }
        let size = margin.checked_mul(leverage as u128).ok_or("ERR_OVERFLOW")?;
        let room = market.max_oi_per_side().saturating_sub(market.oi(side));
        if size > room {
            return Err(format!("ERR_EXCEEDS_EXIT_LIQUIDITY: cap {room}"));
        }
        let (capital_limit, exposure) = self.vault_capital_limits(market.vault_id);
        let largest_side = market.oi_long.0.max(market.oi_short.0);
        let capital_cap = Self::vault_backed_cap(market, (capital_limit, exposure));
        let capital_room = if exposure > capital_limit {
            0
        } else {
            capital_cap.saturating_sub(market.oi(side))
        };
        let post_side = market.oi(side).checked_add(size).ok_or("ERR_OVERFLOW")?;
        let post_largest = post_side.max(market.oi_long.0).max(market.oi_short.0);
        let post_exposure = exposure.saturating_sub(largest_side).saturating_add(post_largest);
        if size > capital_room || post_exposure > capital_limit {
            return Err(format!("ERR_EXCEEDS_VAULT_CAPITAL: cap {capital_room}"));
        }
        let account = self.accounts.get(account_id).ok_or("ERR_NO_ACCOUNT")?;
        if account.margin < margin {
            return Err("ERR_INSUFFICIENT_MARGIN".into());
        }
        let slots = brackets.map_or(0, Brackets::count);
        if account.orders.len() + slots > MAX_OPEN_ORDERS {
            return Err("ERR_TOO_MANY_ORDERS".into());
        }
        if let Some(brackets) = brackets {
            let rewards = execution_reward(size).checked_mul(slots as u128).ok_or("ERR_OVERFLOW")?;
            if account.margin < margin.checked_add(rewards).ok_or("ERR_OVERFLOW")? {
                return Err("ERR_INSUFFICIENT_MARGIN".into());
            }
            brackets.validate(side, market.price.0)?;
        }
        let fee = trade_fee(size, market.fee_bps) + self.impact_fee(market_id, size);
        if fee >= margin {
            return Err("ERR_FEES_EXCEED_MARGIN".into());
        }
        Ok((market.price.0, size, fee))
    }

    fn insert_order(&mut self, account_id: AccountId, request: OrderRequest,
        execution: ExecutionBounds, bracket_bounds: Option<BracketBounds>,
    ) -> Order {
        let id = self.next_order_id;
        let size = request.entry().map_or_else(
            || self.positions.get(&request.position_id().unwrap()).unwrap().size,
            |entry| entry.margin.0 * u128::from(entry.leverage),
        );
        let reward = execution_reward(size);
        self.next_order_id += 1;
        let order = Order {
            id,
            account_id: account_id.clone(),
            request,
            created_at_ms: env::block_timestamp_ms(),
            execution_reward: U128(reward),
            wallet_funded: false,
            bracket_reserve: U128(0),
            execution: Some(execution),
            bracket_bounds,
        };
        let account = self.accounts.get_mut(&account_id).unwrap();
        require!(account.margin >= reward, "ERR_INSUFFICIENT_MARGIN");
        account.margin -= reward;
        account.reserved_margin += reward;
        if let Some(entry) = order.request.entry() {
            account.margin -= entry.margin.0;
            account.reserved_margin += entry.margin.0;
        }
        account.orders.push(id);
        if let Some(position_id) = order.request.position_id() {
            let position = self.positions.get_mut(&position_id).unwrap();
            if order.request.is_take_profit() {
                position.take_profit = Some(id);
            } else {
                position.stop_loss = Some(id);
            }
        }
        emit_event("order_placed", json!(order));
        self.orders.insert(id, order.clone());
        order
    }

    /// Removal releases entry collateral and all reserved rewards exactly once.
    fn remove_order(&mut self, id: OrderId) -> Option<Order> {
        let order = self.orders.remove(&id)?;
        let account = self.accounts.get_mut(&order.account_id).unwrap();
        account.orders.retain(|order_id| *order_id != id);
        let rewards = order.execution_reward.0 + order.bracket_reserve.0;
        account.reserved_margin -= rewards;
        account.margin += rewards;
        if let Some(entry) = order.request.entry() {
            account.reserved_margin -= entry.margin.0;
            account.margin += entry.margin.0;
        }
        if let Some(position_id) = order.request.position_id() {
            if let Some(position) = self.positions.get_mut(&position_id) {
                if order.request.is_take_profit() {
                    position.take_profit = None;
                } else {
                    position.stop_loss = None;
                }
            }
        }
        Some(order)
    }

    pub(crate) fn cancel_position_orders(&mut self, position: &Position) {
        for id in [position.take_profit, position.stop_loss]
            .into_iter()
            .flatten()
        {
            if self.remove_order(id).is_some() {
                emit_event(
                    "order_cancelled",
                    json!({ "order_id": id, "reason": "position_closed" }),
                );
            }
        }
    }

    /// A smaller position cannot increase its reserved rewards. New IDs invalidate stale reviews.
    pub(crate) fn resize_position_orders(&mut self, position_id: PositionId) {
        let position = self.positions.get(&position_id).unwrap();
        let ids = [position.take_profit, position.stop_loss];
        let reward = execution_reward(position.size);
        for previous_id in ids.into_iter().flatten() {
            let mut order = self.remove_order(previous_id).expect("linked exit order");
            order.id = self.next_order_id;
            self.next_order_id += 1;
            order.created_at_ms = env::block_timestamp_ms();
            order.execution_reward.0 = order.execution_reward.0.min(reward);
            let reserved = order.execution_reward.0 + order.bracket_reserve.0;
            let account = self.accounts.get_mut(&order.account_id).unwrap();
            account.margin -= reserved;
            account.reserved_margin += reserved;
            account.orders.push(order.id);
            let position = self.positions.get_mut(&position_id).unwrap();
            if order.request.is_take_profit() {
                position.take_profit = Some(order.id);
            } else {
                position.stop_loss = Some(order.id);
            }
            emit_event("order_cancelled", json!({ "order_id": previous_id, "reason": "position_reduced" }));
            emit_event("order_placed", json!(order));
            self.orders.insert(order.id, order);
        }
    }

    fn refund_rejected_wallet_order(&mut self, order: &Order) {
        if order.wallet_funded {
            let released = order.execution_reward.0 + order.bracket_reserve.0
                + order.request.entry().map_or(0, |entry| entry.margin.0);
            if released > 0 {
                self.send_margin_to_wallet(order.account_id.clone(), U128(released)).detach();
            }
        }
    }

    fn reject_order(&mut self, id: OrderId, reason: String) -> OrderExecution {
        let order = self.remove_order(id).unwrap();
        self.refund_rejected_wallet_order(&order);
        emit_event("order_rejected", json!({ "order_id": id, "reason": reason }));
        OrderExecution::Rejected { order_id: id, reason }
    }

    pub(crate) fn attach_brackets(&mut self, position_id: PositionId, brackets: Option<Brackets>,
        bounds: Option<BracketBounds>,
    ) {
        let Some(brackets) = brackets else {
            return;
        };
        let account_id = self.positions.get(&position_id).unwrap().account_id.clone();
        if let Some(trigger_price) = brackets.take_profit {
            self.insert_order(
                account_id.clone(),
                OrderRequest::TakeProfit {
                    position_id,
                    trigger_price,
                },
                bounds.and_then(|bounds| bounds.take_profit).expect("validated bracket bounds"), None,
            );
        }
        if let Some(trigger_price) = brackets.stop_loss {
            self.insert_order(
                account_id,
                OrderRequest::StopLoss {
                    position_id,
                    trigger_price,
                },
                bounds.and_then(|bounds| bounds.stop_loss).expect("validated bracket bounds"), None,
            );
        }
    }
}

#[near]
impl Ketos {
    #[payable]
    pub fn amend_brackets(
        &mut self, request: BracketAmendment, to_wallet: Option<bool>,
        signed_prices: Option<crate::signed_prices::SignedPrices>,
    ) -> PromiseOrValue<U128> {
        let account_id = env::predecessor_account_id();
        self.amendable_position(&account_id, &request).unwrap_or_else(|reason| env::panic_str(&reason));
        BracketBounds::validate_for(Some(&request.brackets), Some(&request.execution), env::block_timestamp_ms())
            .unwrap_or_else(|reason| env::panic_str(&reason));
        let market_ids = if request.brackets.count() == 0 { Vec::new() }
            else { self.position_price_market_ids(request.position_id) };
        let action = crate::pull_prices::PullAction::AmendBrackets {
            account_id: account_id.clone(), request: request.clone(), to_wallet: to_wallet.unwrap_or(true),
        };
        if let Some(promise) = self.pull_for_action(action, market_ids, signed_prices) {
            return PromiseOrValue::Promise(promise);
        }
        self.try_amend_brackets_for(account_id, request, to_wallet.unwrap_or(true))
            .unwrap_or_else(|reason| env::panic_str(&reason))
    }

    #[payable]
    pub fn place_order(&mut self, request: OrderRequest, signed_prices: Option<crate::signed_prices::SignedPrices>,
        execution: ExecutionBounds, bracket_bounds: Option<BracketBounds>,
    ) -> PromiseOrValue<Order> {
        let account_id = env::predecessor_account_id();
        execution.validate(env::block_timestamp_ms()).unwrap_or_else(|reason| env::panic_str(&reason));
        BracketBounds::validate_for(request.entry().and_then(|entry| entry.brackets.as_ref()),
            bracket_bounds.as_ref(), env::block_timestamp_ms()).unwrap_or_else(|reason| env::panic_str(&reason));
        let ids = request.position_id().map_or_else(Vec::new, |id| self.position_price_market_ids(id));
        let action = crate::pull_prices::PullAction::PlaceOrder { account_id, request: request.clone(), execution, bracket_bounds };
        if let Some(promise) = self.pull_for_action(action, ids, signed_prices) {
            return PromiseOrValue::Promise(promise);
        }
        PromiseOrValue::Value(self.try_place_order_for(env::predecessor_account_id(), request, execution, bracket_bounds)
            .unwrap_or_else(|reason| env::panic_str(&reason)))
    }

    #[cfg(test)]
    pub(crate) fn place_order_now(&mut self, request: OrderRequest) -> Order {
        let (side, closing) = request.entry().map_or_else(
            || (self.positions.get(&request.position_id().unwrap()).unwrap().side, true),
            |entry| (entry.side, false),
        );
        let execution = crate::tests::execution_for_test(side, closing, request.trigger_price());
        let bracket_bounds = crate::tests::bracket_execution(side, request.entry().and_then(|entry| entry.brackets.as_ref()));
        self.try_place_order_for(env::predecessor_account_id(), request, execution, bracket_bounds)
            .unwrap_or_else(|reason| env::panic_str(&reason))
    }

    pub(crate) fn try_place_order_for(&mut self, account_id: AccountId, request: OrderRequest,
        execution: ExecutionBounds, bracket_bounds: Option<BracketBounds>,
    ) -> Result<Order, String> {
        execution.validate(env::block_timestamp_ms())?;
        BracketBounds::validate_for(request.entry().and_then(|entry| entry.brackets.as_ref()),
            bracket_bounds.as_ref(), env::block_timestamp_ms())?;
        let account = self.accounts.get(&account_id).ok_or("ERR_NO_ACCOUNT")?;
        if account.orders.len() >= MAX_OPEN_ORDERS { return Err("ERR_TOO_MANY_ORDERS".into()); }
        if request.trigger_price() == 0 { return Err("ERR_ZERO_TRIGGER_PRICE".into()); }
        if let Some(entry) = request.entry() {
            let market = self.markets.get(&entry.market_id).ok_or("ERR_UNKNOWN_MARKET")?;
            if entry.margin_mode == crate::cross::MarginMode::Cross && market.vault_id.is_market() {
                return Err("ERR_ISOLATED_MARKET_CROSS".into());
            }
            if entry.margin.0 < MIN_POSITION_MARGIN { return Err("ERR_MIN_POSITION_MARGIN: 1 USDC".into()); }
            if !(1..=market.max_leverage_cap).contains(&entry.leverage) { return Err("ERR_INVALID_LEVERAGE".into()); }
            let size = entry.margin.0.checked_mul(u128::from(entry.leverage)).ok_or("ERR_OVERFLOW")?;
            let required = entry.margin.0.checked_add(execution_reward(size)).ok_or("ERR_OVERFLOW")?;
            if account.margin < required { return Err("ERR_INSUFFICIENT_MARGIN".into()); }
            if let Some(brackets) = &entry.brackets {
                brackets.validate(entry.side, entry.trigger_price.0)?;
            }
        } else {
            let position = self.positions.get(&request.position_id().unwrap()).ok_or("ERR_NO_POSITION")?;
            if position.account_id != account_id { return Err("ERR_NOT_OWNER".into()); }
            let existing = if request.is_take_profit() { position.take_profit } else { position.stop_loss };
            if existing.is_some() { return Err("ERR_EXIT_ORDER_EXISTS".into()); }
            if account.margin < execution_reward(position.size) { return Err("ERR_INSUFFICIENT_MARGIN".into()); }
            let market = self.markets.get(&position.market_id).unwrap();
            if market.price.0 == 0 { return Err("ERR_NO_PRICE".into()); }
            if env::block_timestamp_ms().saturating_sub(market.price_timestamp_ms) > crate::market::MAX_PRICE_AGE_MS {
                return Err("ERR_STALE_PRICE".into());
            }
            let brackets = if request.is_take_profit() {
                Brackets { take_profit: Some(U128(request.trigger_price())), stop_loss: None }
            } else {
                Brackets { take_profit: None, stop_loss: Some(U128(request.trigger_price())) }
            };
            brackets.validate(position.side, market.price.0)?;
        }
        Ok(self.insert_order(account_id, request, execution, bracket_bounds))
    }

    pub fn cancel_order(&mut self, order_id: OrderId, to_wallet: Option<bool>) -> PromiseOrValue<U128> {
        let order = self
            .orders
            .get(&order_id)
            .unwrap_or_else(|| env::panic_str("ERR_NO_ORDER"));
        require!(
            order.account_id == env::predecessor_account_id(),
            "ERR_NOT_OWNER"
        );
        let account_id = order.account_id.clone();
        let before = self.accounts.get(&account_id).unwrap().margin;
        self.remove_order(order_id);
        let released = U128(self.accounts.get(&account_id).unwrap().margin - before);
        emit_event(
            "order_cancelled",
            json!({ "order_id": order_id, "reason": "owner" }),
        );
        if to_wallet.unwrap_or(true) && released.0 > 0 {
            PromiseOrValue::Promise(self.send_margin_to_wallet(account_id, released))
        } else {
            PromiseOrValue::Value(released)
        }
    }

    #[payable]
    pub fn execute_orders(&mut self, ids: Vec<OrderId>, signed_prices: Option<crate::signed_prices::SignedPrices>) -> PromiseOrValue<Vec<OrderExecution>> {
        require!(ids.len() <= MAX_EXECUTE_ORDERS, "ERR_ORDER_BATCH_TOO_LARGE");
        let markets = self.orders_price_market_ids(&ids);
        let action = crate::pull_prices::PullAction::ExecuteOrders { executor: env::predecessor_account_id(), ids: ids.clone() };
        if let Some(promise) = self.pull_for_action(action, markets, signed_prices) {
            return PromiseOrValue::Promise(promise);
        }
        PromiseOrValue::Value(self.execute_orders_now(ids))
    }

    pub(crate) fn execute_orders_now(&mut self, ids: Vec<OrderId>) -> Vec<OrderExecution> {
        self.execute_orders_for(env::predecessor_account_id(), ids, false)
    }

    pub(crate) fn execute_orders_for(&mut self, executor: AccountId, ids: Vec<OrderId>, allow_fallback: bool) -> Vec<OrderExecution> {
        require!(ids.len() <= MAX_EXECUTE_ORDERS, "ERR_ORDER_BATCH_TOO_LARGE");
        let now_ms = env::block_timestamp_ms();
        ids.into_iter().map(|id| {
            let skipped = OrderExecution::Skipped { order_id: id };
            let Some(order) = self.orders.get(&id) else { return skipped; };
            let Some(execution) = order.execution else { return skipped; };
            if let Err(reason) = execution.validate(now_ms) {
                return self.reject_order(id, reason);
            }
            let (market_id, side) = if let Some(entry) = order.request.entry() {
                (&entry.market_id, entry.side)
            } else {
                let Some(position) = self.positions.get(&order.request.position_id().unwrap()) else { return skipped; };
                (&position.market_id, position.side)
            };
            let market = self.markets.get(market_id)
                .filter(|market| order.created_at_ms >= market.created_at_ms);
            let Some(market) = market else {
                return self.reject_order(id, "ERR_MARKET_DELISTED".into());
            };
            if market.price.0 == 0 {
                return skipped;
            }
            let price = if order.request.entry().is_some() {
                if allow_fallback || now_ms.saturating_sub(market.price_timestamp_ms) > MAX_OPEN_PRICE_AGE_MS {
                    return skipped;
                }
                market.price.0
            } else {
                // A stale quote cannot invent a newly crossed trigger.
                if !order.request.triggered(side, market.price.0) { return skipped; }
                let price = if allow_fallback {
                    market.failed_pull_close_price(side, now_ms)
                } else {
                    let Ok(price) = market.closing_price(now_ms) else { return skipped; };
                    price
                };
                price
            };
            if order.request.entry().is_some() && !order.request.triggered(side, price) { return skipped; }
            if let Err(reason) = execution.check(side, order.request.entry().is_none(), price, now_ms) {
                return self.reject_order(id, reason);
            }
            let fill_market = market_id.clone();
            let fill_size = if let Some(entry) = order.request.entry() {
                // Opening admission checks overflow before any fill is recorded.
                entry.margin.0.saturating_mul(entry.leverage as u128)
            } else {
                self.positions.get(&order.request.position_id().unwrap()).unwrap().size
            };
            let order = self.remove_order(id).unwrap();
            let reward = order.execution_reward.0;
            self.accounts.get_mut(&order.account_id).unwrap().margin -= reward;
            let released = order.request.entry().map_or(0, |entry| entry.margin.0)
                + order.bracket_reserve.0 + reward;
            let wallet_funded = order.wallet_funded;
            let position_id = match order.request {
                OrderRequest::Limit(entry) | OrderRequest::StopMarket(entry) => {
                    match self.try_open_position_for(order.account_id.clone(), entry.market_id, entry.side,
                        entry.margin, entry.leverage, entry.brackets, entry.margin_mode, execution, order.bracket_bounds) {
                        Ok(position) => position.id,
                        Err(reason) => {
                            self.accounts.get_mut(&order.account_id).unwrap().margin += reward;
                            if wallet_funded && released > 0 {
                                self.send_margin_to_wallet(order.account_id.clone(), U128(released)).detach();
                            }
                            emit_event("order_rejected", json!({ "order_id": id, "reason": reason, "refunded_margin": entry.margin }));
                            return OrderExecution::Rejected { order_id: id, reason };
                        }
                    }
                }
                OrderRequest::TakeProfit { position_id, .. } | OrderRequest::StopLoss { position_id, .. } => {
                    self.close_position_at(position_id, price, now_ms);
                    position_id
                }
            };
            self.accounts.entry(executor.clone()).or_default().margin += reward;
            self.record_order_fill(&order.account_id, HistoryEvent {
                sequence: 0,
                kind: HistoryKind::OrderFill,
                position_id,
                order_id: Some(id),
                market_id: fill_market,
                side,
                price: U128(price),
                size: U128(fill_size),
                pnl: near_sdk::json_types::I128(0),
                realized_pnl: near_sdk::json_types::I128(-crate::math::to_i128(reward)),
                fees: U128(reward),
                funding_paid: U128(0),
                funding_received: U128(0),
                funding_payment: near_sdk::json_types::I128(0),
                timestamp_ms: now_ms,
            });
            emit_event("order_filled", json!({ "order_id": id, "account_id": order.account_id, "position_id": position_id, "price": U128(price), "executor": executor, "execution_reward": U128(reward) }));
            OrderExecution::Filled { order_id: id, position_id, price: U128(price) }
        }).collect()
    }

    pub fn get_orders(&self, account_id: AccountId) -> Vec<Order> {
        self.accounts
            .get(&account_id)
            .map_or_else(Vec::new, |account| {
                account
                    .orders
                    .iter()
                    .filter_map(|id| self.orders.get(id).cloned())
                    .collect()
            })
    }

    /// Active order pagination for permissionless executors.
    pub fn get_open_orders(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Order> {
        self.orders
            .values()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .cloned()
            .collect()
    }
}
