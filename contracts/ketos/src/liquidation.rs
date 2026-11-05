//! Permissionless liquidations. Anyone may close a position whose equity has fallen to its
//! maintenance margin; the penalty goes to the vault and a small reward to the caller.

use near_sdk::json_types::{I128, U128};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, PromiseOrValue};

use crate::history::{HistoryEvent, HistoryKind};
use crate::market::MarketId;
use crate::math::{mul_div_ceil, mul_div_floor, BPS};
use crate::position::{fees_covered, realized_funding, PositionId, Side};
use crate::{emit_event, Ketos, KetosExt};

/// Liquidation penalty paid to the vault: 1% of notional.
pub const LIQUIDATION_PENALTY_BPS: u128 = 100;

/// Reward paid to the account that triggers the liquidation: 0.2% of notional.
pub const LIQUIDATOR_REWARD_BPS: u128 = 20;

/// Liquidations kept for `get_liquidations`.
pub const LIQUIDATION_HISTORY_LEN: u64 = 20;

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiquidationRecord {
    pub position_id: PositionId,
    pub account_id: AccountId,
    pub market_id: MarketId,
    pub side: Side,
    pub size: U128,
    pub entry_price: U128,
    pub price: U128,
    /// Equity at liquidation: margin + PnL − borrow fee − net funding. Negative for a
    /// loss beyond the margin.
    pub equity: I128,
    pub funding_paid: U128,
    pub funding_received: U128,
    pub funding_payment: I128,
    pub penalty: U128,
    pub reward: U128,
    /// Positive settlement credit: free margin for isolated, shared cash for cross.
    pub returned: U128,
    pub liquidator: AccountId,
    pub timestamp_ms: u64,
}

/// Splits liquidation equity into (liquidator reward, vault penalty, trader remainder).
/// The reward is paid first so liquidating stays worthwhile; both are capped by equity.
pub fn split_equity(equity: i128, size: u128) -> (u128, u128, u128) {
    let mut left = u128::try_from(equity.max(0)).unwrap_or(0);
    let reward = mul_div_floor(size, LIQUIDATOR_REWARD_BPS, BPS).min(left);
    left -= reward;
    let penalty = mul_div_ceil(size, LIQUIDATION_PENALTY_BPS, BPS).min(left);
    left -= penalty;
    (reward, penalty, left)
}

#[near]
impl Ketos {
    #[payable]
    pub fn liquidate(&mut self, position_id: PositionId) -> PromiseOrValue<LiquidationRecord> {
        let ids = self.position_price_market_ids(position_id);
        let action = crate::pull_prices::PullAction::Liquidate { liquidator: env::predecessor_account_id(), position_id };
        if let Some(promise) = self.pull_for_action(action, ids) {
            return PromiseOrValue::Promise(promise);
        }
        PromiseOrValue::Value(self.liquidate_now(position_id))
    }

    pub(crate) fn liquidate_now(&mut self, position_id: PositionId) -> LiquidationRecord {
        self.liquidate_for(env::predecessor_account_id(), position_id)
    }

    pub(crate) fn liquidate_for(&mut self, liquidator: AccountId, position_id: PositionId) -> LiquidationRecord {
        require!(
            self.positions.get(&position_id).map(|p| p.margin_mode) != Some(crate::cross::MarginMode::Cross),
            "ERR_USE_CROSS_LIQUIDATION"
        );
        let now_ms = env::block_timestamp_ms();
        let position = self
            .positions
            .get(&position_id)
            .unwrap_or_else(|| env::panic_str("ERR_NO_POSITION"));
        let market = self
            .markets
            .get(&position.market_id)
            .unwrap_or_else(|| env::panic_str("ERR_UNKNOWN_MARKET"));
        let price = market.fresh_price(now_ms);
        let marked = position.mark(market, price, now_ms);
        require!(
            marked.equity <= marked.maintenance as i128,
            "ERR_POSITION_HEALTHY"
        );

        let (position, marked) = self.remove_position(position_id, price, now_ms);
        let vault_id = self.markets.get(&position.market_id).unwrap().vault_id;
        let vault = &self.vaults[vault_id.index()];
        let available = vault.balance - vault.cross_receivable + position.margin;
        let (reward, penalty, returned) = split_equity(marked.equity.min(crate::math::to_i128(available)), position.size);
        let borrow_paid = fees_covered(&position, &marked, marked.borrow_fee);
        self.record_settlement(
            vault_id, position.margin, reward + returned, borrow_paid,
            realized_funding(&position, &marked), penalty,
        );
        if returned > 0 {
            self.accounts
                .get_mut(&position.account_id)
                .unwrap_or_else(|| env::panic_str("ERR_NO_ACCOUNT"))
                .margin += returned;
        }
        if reward > 0 {
            self.accounts
                .entry(liquidator.clone())
                .or_default()
                .margin += reward;
        }
        let event = HistoryEvent::position(
            HistoryKind::Liquidation, position_id, &position, price, now_ms,
        );
        self.record_exit(event, &position, &marked, returned, borrow_paid + penalty + reward);

        let record = LiquidationRecord {
            position_id,
            account_id: position.account_id,
            market_id: position.market_id,
            side: position.side,
            size: U128(position.size),
            entry_price: U128(position.entry_price),
            price: U128(price),
            equity: I128(marked.equity),
            funding_paid: U128(marked.funding_paid),
            funding_received: U128(marked.funding_received),
            funding_payment: I128(crate::math::to_i128(marked.funding_paid)
                - crate::math::to_i128(marked.funding_received)),
            penalty: U128(penalty),
            reward: U128(reward),
            returned: U128(returned),
            liquidator,
            timestamp_ms: now_ms,
        };
        self.record_liquidation(record.clone());
        record
    }

    /// Most recent liquidations first, at most 20.
    pub fn get_liquidations(&self, limit: Option<u32>) -> Vec<LiquidationRecord> {
        let kept = self.liquidations.len() as u64;
        let limit = limit.map_or(kept, |l| (l as u64).min(kept));
        (1..=limit)
            .filter_map(|back| {
                let slot = (self.liquidation_count - back) % LIQUIDATION_HISTORY_LEN;
                self.liquidations.get(slot as u32).cloned()
            })
            .collect()
    }
}

impl Ketos {
    pub(crate) fn record_liquidation(&mut self, record: LiquidationRecord) {
        emit_event("liquidation", json!(record));
        let slot = self.liquidation_count % LIQUIDATION_HISTORY_LEN;
        if slot < self.liquidations.len() as u64 {
            self.liquidations.set(slot as u32, record);
        } else {
            self.liquidations.push(record);
        }
        self.liquidation_count += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const USD: u128 = 1_000_000;

    #[test]
    fn reward_first_then_penalty_capped_by_equity() {
        // 500 USDC notional: reward 1, penalty 5.
        assert_eq!(split_equity(50 * USD as i128, 500 * USD), (USD, 5 * USD, 44 * USD));
        assert_eq!(split_equity(3 * USD as i128, 500 * USD), (USD, 2 * USD, 0));
        assert_eq!(split_equity(USD as i128 / 2, 500 * USD), (USD / 2, 0, 0));
        assert_eq!(split_equity(-7, 500 * USD), (0, 0, 0));
    }
}
