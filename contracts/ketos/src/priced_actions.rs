use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, PromiseOrValue};

use crate::cross::MarginMode;
use crate::market::{MarketId, MAX_PRICE_AGE_MS};
use crate::math::{mul_div_floor, to_i128};
use crate::pull_prices::PullAction;
use crate::Ketos;

impl Ketos {
    fn action_prices_fresh(&self, ids: &[MarketId]) -> Result<(), String> {
        let now = env::block_timestamp_ms();
        for id in ids {
            let market = self.markets.get(id).ok_or("ERR_UNKNOWN_MARKET")?;
            if market.price.0 == 0 { return Err("ERR_NO_PRICE".into()); }
            if now.saturating_sub(market.price_timestamp_ms) > MAX_PRICE_AGE_MS {
                return Err("ERR_STALE_PRICE".into());
            }
        }
        Ok(())
    }

    pub(crate) fn execute_priced_action(
        &mut self, action: PullAction, allow_fallback: bool,
    ) -> Result<PromiseOrValue<Value>, String> {
        let now = env::block_timestamp_ms();
        let value = match action {
            PullAction::MarketPrice { market_id } => {
                if allow_fallback { return Err("ERR_ACTION_PRICE_UNAVAILABLE".into()); }
                self.action_prices_fresh(std::slice::from_ref(&market_id))?;
                json!(self.markets.get(&market_id).unwrap().price)
            }
            PullAction::Open { account_id, market_id, side, margin, leverage, brackets, margin_mode, execution, bracket_bounds } => {
                if allow_fallback { return Err("ERR_ACTION_PRICE_UNAVAILABLE".into()); }
                json!(self.try_open_position_for(account_id, market_id, side, margin, leverage, brackets, margin_mode, execution, bracket_bounds)?)
            }
            PullAction::WalletOpen { account_id, amount, request } => {
                if allow_fallback { return Err("ERR_ACTION_PRICE_UNAVAILABLE".into()); }
                json!(self.execute_wallet_open(account_id, amount, request)?)
            }
            PullAction::Close { account_id, position_id, to_wallet, execution } => {
                let position = self.positions.get(&position_id).ok_or("ERR_NO_POSITION")?;
                if position.account_id != account_id { return Err("ERR_NOT_OWNER".into()); }
                let market = self.markets.get(&position.market_id).ok_or("ERR_UNKNOWN_MARKET")?;
                if market.price.0 == 0 { return Err("ERR_NO_PRICE".into()); }
                let price = if allow_fallback { market.failed_pull_close_price(position.side, now) }
                    else { market.closing_price(now).map_err(str::to_string)? };
                return Ok(match self.close_position_for(account_id, position_id, price, now, to_wallet, execution)? {
                    PromiseOrValue::Value(value) => PromiseOrValue::Value(json!(value)),
                    PromiseOrValue::Promise(promise) => PromiseOrValue::Promise(promise),
                });
            }
            PullAction::Reduce { account_id, request, to_wallet, execution } => {
                if allow_fallback { return Err("ERR_ACTION_PRICE_UNAVAILABLE".into()); }
                return Ok(match self.reduce_position_for(account_id, request, to_wallet, execution)? {
                    PromiseOrValue::Value(value) => PromiseOrValue::Value(json!(value)),
                    PromiseOrValue::Promise(promise) => PromiseOrValue::Promise(promise),
                });
            }
            PullAction::PlaceOrder { account_id, request, execution, bracket_bounds } => {
                if allow_fallback { return Err("ERR_ACTION_PRICE_UNAVAILABLE".into()); }
                json!(self.try_place_order_for(account_id, request, execution, bracket_bounds)?)
            }
            PullAction::AmendBrackets { account_id, request, to_wallet } => {
                if allow_fallback { return Err("ERR_ACTION_PRICE_UNAVAILABLE".into()); }
                return Ok(match self.try_amend_brackets_for(account_id, request, to_wallet)? {
                    PromiseOrValue::Value(value) => PromiseOrValue::Value(json!(value)),
                    PromiseOrValue::Promise(promise) => PromiseOrValue::Promise(promise),
                });
            }
            PullAction::ExecuteOrders { executor, ids } => {
                if ids.len() > crate::orders::MAX_EXECUTE_ORDERS { return Err("ERR_ORDER_BATCH_TOO_LARGE".into()); }
                json!(self.execute_orders_for(executor, ids, allow_fallback))
            }
            PullAction::Liquidate { liquidator, position_id } => {
                if allow_fallback { return Err("ERR_ACTION_PRICE_UNAVAILABLE".into()); }
                let position = self.positions.get(&position_id).ok_or("ERR_NO_POSITION")?;
                if position.margin_mode == MarginMode::Cross { return Err("ERR_USE_CROSS_LIQUIDATION".into()); }
                self.action_prices_fresh(std::slice::from_ref(&position.market_id))?;
                let market = self.markets.get(&position.market_id).unwrap();
                let marked = position.mark(market, market.price.0, now);
                if marked.equity > to_i128(marked.maintenance) { return Err("ERR_POSITION_HEALTHY".into()); }
                json!(self.liquidate_for(liquidator, position_id))
            }
            PullAction::LiquidateCross { liquidator, account_id } => {
                if allow_fallback { return Err("ERR_ACTION_PRICE_UNAVAILABLE".into()); }
                let health = self.get_cross_account(account_id.clone());
                if !health.prices_fresh { return Err("ERR_STALE_CROSS_PRICE".into()); }
                if !health.liquidatable { return Err("ERR_CROSS_HEALTHY".into()); }
                json!(self.liquidate_cross_for(liquidator, account_id))
            }
            PullAction::WithdrawVault { account_id, vault_id, shares } => {
                if allow_fallback { return Err("ERR_ACTION_PRICE_UNAVAILABLE".into()); }
                if shares.0 == 0 { return Err("ERR_ZERO_SHARES".into()); }
                self.action_prices_fresh(&self.vault_price_market_ids(vault_id))?;
                if self.vault_shares_held(vault_id, &account_id) < shares.0 { return Err("ERR_INSUFFICIENT_SHARES".into()); }
                let view = self.get_vault(vault_id);
                if view.total_shares.0 == 0 { return Err("ERR_INSUFFICIENT_SHARES".into()); }
                let amount = mul_div_floor(shares.0, view.nav.0, view.total_shares.0);
                if amount == 0 { return Err("ERR_ZERO_AMOUNT".into()); }
                if amount > view.available.0 { return Err(format!("ERR_VAULT_RESERVED: available {}", view.available.0)); }
                return Ok(PromiseOrValue::Promise(self.withdraw_vault_for(account_id, vault_id, shares)));
            }
            PullAction::DepositVault { account_id, vault_id, amount } => {
                if allow_fallback { return Err("ERR_ACTION_PRICE_UNAVAILABLE".into()); }
                if amount.0 < crate::vault::MIN_VAULT_DEPOSIT { return Err("ERR_MIN_VAULT_DEPOSIT: 1 USDC".into()); }
                self.action_prices_fresh(&self.vault_price_market_ids(vault_id))?;
                let view = self.get_vault(vault_id);
                if view.nav.0 > 0 && view.total_shares.0 > 0 && mul_div_floor(amount.0, view.total_shares.0, view.nav.0) == 0 {
                    return Err("ERR_ZERO_SHARES".into());
                }
                self.deposit_vault(vault_id, &account_id, amount.0);
                json!(U128(0))
            }
        };
        Ok(PromiseOrValue::Value(value))
    }
}
