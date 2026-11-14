use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, AccountId, PromiseOrValue};

use crate::cross::MarginMode;
use crate::history::{HistoryEvent, HistoryKind};
use crate::market::MAX_PRICE_AGE_MS;
use crate::math::{mul_div_floor, to_i128};
use crate::position::{fees_covered, realized_funding, ExecutionBounds, PositionId, MIN_POSITION_MARGIN};
use crate::pull_prices::PullAction;
use crate::{emit_event, Ketos, KetosExt};

/// The reviewed size is bound across the oracle callback, not silently reinterpreted as a percentage.
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug)]
pub struct ReductionRequest {
    pub position_id: PositionId,
    pub expected_size: U128,
    pub size: U128,
}

impl Ketos {
    fn validate_reduction(&self, account_id: &AccountId, request: ReductionRequest) -> Result<(), String> {
        let position = self.positions.get(&request.position_id).ok_or("ERR_NO_POSITION")?;
        if &position.account_id != account_id { return Err("ERR_NOT_OWNER".into()); }
        if position.size != request.expected_size.0 { return Err("ERR_POSITION_CHANGED".into()); }
        if request.size.0 == 0 || request.size.0 > position.size { return Err("ERR_REDUCTION_SIZE".into()); }
        Ok(())
    }

    pub(crate) fn reduce_position_for(
        &mut self, account_id: AccountId, request: ReductionRequest, to_wallet: bool,
        execution: ExecutionBounds,
    ) -> Result<PromiseOrValue<U128>, String> {
        self.validate_reduction(&account_id, request)?;
        let now = env::block_timestamp_ms();
        let position = self.positions.get(&request.position_id).unwrap();
        let market = self.markets.get(&position.market_id).ok_or("ERR_UNKNOWN_MARKET")?;
        if market.price.0 == 0 { return Err("ERR_NO_PRICE".into()); }
        if market.price_timestamp_ms > now || now - market.price_timestamp_ms > MAX_PRICE_AGE_MS {
            return Err("ERR_STALE_PRICE".into());
        }
        let price = market.price.0;
        execution.check(position.side, true, price, now)?;
        if request.size.0 == position.size {
            return self.close_position_for(account_id, request.position_id, price, now, to_wallet, execution);
        }

        let remaining_size = position.size - request.size.0;
        let released_margin = mul_div_floor(position.margin, request.size.0, position.size);
        let remaining_margin = position.margin - released_margin;
        let cross = position.margin_mode == MarginMode::Cross;
        if (cross && remaining_size < MIN_POSITION_MARGIN)
            || (!cross && remaining_margin < MIN_POSITION_MARGIN) {
            return Err("ERR_REDUCTION_DUST".into());
        }
        let remaining = position.mark_slice(remaining_size, remaining_margin, market, price, now);
        let mut marked = position.mark_slice(request.size.0, released_margin, market, price, now);
        marked.close_fee += self.impact_fee(&position.market_id, request.size.0);
        let vault_id = market.vault_id;
        let vault = self.vaults.get(&vault_id).unwrap();
        let available = vault.balance.saturating_sub(vault.cross_receivable) + released_margin;
        let signed_payout = if cross {
            let own_claim = self.accounts.get(&account_id).unwrap().cross_debt[vault_id.shared_index()];
            (marked.equity - to_i128(marked.close_fee)).min(to_i128(available + own_claim))
        } else {
            (marked.equity - to_i128(marked.close_fee)).max(0).min(to_i128(available))
        };
        if cross {
            let health = self.get_cross_account(account_id.clone());
            if !health.prices_fresh { return Err("ERR_STALE_CROSS_PRICE".into()); }
            let original = position.mark(market, price, now);
            let equity = health.equity.0 - original.equity + remaining.equity + signed_payout;
            let maintenance = health.maintenance_margin.0 - original.maintenance + remaining.maintenance;
            if equity <= to_i128(maintenance) { return Err("ERR_CROSS_UNDERMARGINED".into()); }
        } else if remaining.equity <= to_i128(remaining.maintenance) {
            return Err("ERR_REDUCTION_UNDERMARGINED".into());
        }

        // Preserve entry prices and accrual indexes for the surviving notional. Replacing the
        // full aggregate contribution avoids a rounding residue from subtracting only a slice.
        let mut closed = position.clone();
        let original_size = position.size;
        let before = self.accounts.get(&account_id).unwrap().margin;
        let market = self.market_mut(&closed.market_id);
        market.accrue(now);
        market.track(closed.side, original_size, closed.entry_price, closed.entry_borrow_index, false);
        market.funding.track(closed.side, original_size, closed.entry_funding_paid_index, closed.entry_funding_received_index, false);
        *market.oi_mut(closed.side) -= request.size.0;
        market.track(closed.side, remaining_size, closed.entry_price, closed.entry_borrow_index, true);
        market.funding.track(closed.side, remaining_size, closed.entry_funding_paid_index, closed.entry_funding_received_index, true);
        let position = self.positions.get_mut(&request.position_id).unwrap();
        position.size = remaining_size;
        position.margin = remaining_margin;
        self.resize_position_orders(request.position_id);
        closed.size = request.size.0;
        closed.margin = released_margin;
        self.emit_position_funding(request.position_id, &account_id, &closed.market_id,
            marked.funding_paid, marked.funding_received, now);
        let fees = if cross { marked.borrow_fee + marked.close_fee }
            else { fees_covered(&closed, &marked, marked.borrow_fee + marked.close_fee) };
        let event = HistoryEvent::position(HistoryKind::Reduce, request.position_id, &closed, price, now);
        if cross {
            let funding = to_i128(marked.funding_paid) - to_i128(marked.funding_received);
            self.record_signed_settlement(vault_id.shared_index(), released_margin, signed_payout, fees, funding, 0);
            self.credit_cross_cash(&account_id, signed_payout, vault_id.shared_index());
            self.record_signed_exit(event, &closed, &marked, signed_payout, fees);
        } else {
            let payout = signed_payout as u128;
            self.record_settlement(vault_id, released_margin, payout, fees, realized_funding(&closed, &marked), 0);
            self.accounts.get_mut(&account_id).unwrap().margin += payout;
            self.record_exit(event, &closed, &marked, payout, fees);
        }
        let released = U128(self.accounts.get(&account_id).unwrap().margin - before);
        emit_event("position_reduced", json!({
            "position_id": request.position_id, "account_id": account_id,
            "market_id": closed.market_id, "size": request.size, "remaining_size": U128(remaining_size),
            "price": U128(price), "released_margin": U128(released_margin),
            "settlement": near_sdk::json_types::I128(signed_payout), "released": released,
        }));
        Ok(if to_wallet && released.0 > 0 {
            PromiseOrValue::Promise(self.send_margin_to_wallet(account_id, released))
        } else {
            PromiseOrValue::Value(released)
        })
    }
}

#[near]
impl Ketos {
    #[payable]
    pub fn reduce_position(
        &mut self, request: ReductionRequest, execution: ExecutionBounds, to_wallet: Option<bool>,
        signed_prices: Option<crate::signed_prices::SignedPrices>,
    ) -> PromiseOrValue<U128> {
        let account_id = env::predecessor_account_id();
        self.validate_reduction(&account_id, request).unwrap_or_else(|reason| env::panic_str(&reason));
        execution.validate(env::block_timestamp_ms()).unwrap_or_else(|reason| env::panic_str(&reason));
        let position = self.positions.get(&request.position_id).unwrap();
        let ids = if position.margin_mode == MarginMode::Cross { self.cross_price_market_ids(&account_id) }
            else { vec![position.market_id.clone()] };
        let to_wallet = to_wallet.unwrap_or(true);
        let action = PullAction::Reduce { account_id: account_id.clone(), request, to_wallet, execution };
        if let Some(promise) = self.pull_for_action(action, ids, signed_prices) {
            return PromiseOrValue::Promise(promise);
        }
        self.reduce_position_for(account_id, request, to_wallet, execution)
            .unwrap_or_else(|reason| env::panic_str(&reason))
    }
}
