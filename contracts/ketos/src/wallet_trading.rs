//! USDC receiver entries keep pending transfer funds out of spendable margin until execution.

use near_sdk::json_types::U128;
use near_sdk::{env, log, near, AccountId, PromiseOrValue};

use crate::cross::MarginMode;
use crate::history::{HistoryEvent, HistoryKind};
use crate::market::MarketId;
use crate::math::mul_div_floor;
use crate::orders::{execution_reward, BracketBounds, Brackets, EntryOrder, OrderRequest};
use crate::position::{ExecutionBounds, Side, MIN_POSITION_MARGIN};
use crate::pull_prices::PullAction;
use crate::signed_prices::SignedPrices;
use crate::Ketos;

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct WalletOpenRequest {
    #[serde(alias = "market")]
    pub market_id: MarketId,
    pub side: Side,
    /// Omit to use the transfer, less executor reservations, as position collateral.
    pub margin: Option<U128>,
    pub leverage: u32,
    #[serde(default)]
    pub margin_mode: MarginMode,
    pub brackets: Option<Brackets>,
    pub signed_prices: Option<SignedPrices>,
    pub execution: ExecutionBounds,
    pub bracket_bounds: Option<BracketBounds>,
}

#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug)]
pub enum WalletOrderKind {
    Limit,
    StopMarket,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct WalletOrderRequest {
    pub kind: WalletOrderKind,
    #[serde(flatten)]
    pub entry: WalletOpenRequest,
    pub trigger_price: U128,
}

impl WalletOpenRequest {
    fn collateral(&self, amount: u128, entry_order: bool) -> Result<(u128, u128), String> {
        self.execution.validate(env::block_timestamp_ms())?;
        BracketBounds::validate_for(self.brackets.as_ref(), self.bracket_bounds.as_ref(), env::block_timestamp_ms())?;
        let slots = self.brackets.as_ref().map_or(0, Brackets::count) + usize::from(entry_order);
        let margin = if let Some(margin) = self.margin {
            margin.0
        } else if slots == 0 {
            amount
        } else {
            let minimum_rewards = (slots as u128) * execution_reward(0);
            let minimum_bound = amount.checked_sub(minimum_rewards).ok_or("ERR_INSUFFICIENT_MARGIN")?;
            let denominator = 2_000 + slots as u128 * u128::from(self.leverage);
            let mut candidate = minimum_bound.min(mul_div_floor(amount, 2_000, denominator))
                .min(u128::MAX / u128::from(self.leverage.max(1)));
            // Independent reward rounding can leave a few micro-USDC above the rational bound.
            while candidate.checked_mul(u128::from(self.leverage))
                .and_then(|size| candidate.checked_add(execution_reward(size) * slots as u128))
                .is_none_or(|required| required > amount)
            {
                candidate = candidate.checked_sub(1).ok_or("ERR_INSUFFICIENT_MARGIN")?;
            }
            candidate
        };
        if margin < MIN_POSITION_MARGIN { return Err("ERR_MIN_POSITION_MARGIN: 1 USDC".into()); }
        let size = margin.checked_mul(u128::from(self.leverage)).ok_or("ERR_OVERFLOW")?;
        let rewards = execution_reward(size).checked_mul(slots as u128).ok_or("ERR_OVERFLOW")?;
        let required = margin.checked_add(rewards).ok_or("ERR_OVERFLOW")?;
        if required > amount { return Err("ERR_INSUFFICIENT_MARGIN".into()); }
        Ok((margin, rewards))
    }
}

impl Ketos {
    pub(crate) fn receive_wallet_open(
        &mut self, account_id: AccountId, amount: U128, mut request: WalletOpenRequest,
    ) -> PromiseOrValue<U128> {
        // Validate transfer coverage before scheduling an oracle or touching the account.
        if let Err(reason) = request.collateral(amount.0, false) {
            log!("wallet entry rejected: {}", reason);
            return PromiseOrValue::Value(amount);
        }
        let ids = self.open_price_market_ids(&request.market_id, &account_id, request.margin_mode);
        let signed_prices = request.signed_prices.take();
        let action = PullAction::WalletOpen { account_id: account_id.clone(), amount, request: request.clone() };
        if let Some(promise) = self.pull_for_token_action(account_id.clone(), action, ids, signed_prices) {
            return PromiseOrValue::Promise(promise);
        }
        PromiseOrValue::Value(self.execute_wallet_open(account_id, amount, request).unwrap_or_else(|reason| {
            log!("wallet entry rejected: {}", reason);
            amount
        }))
    }

    pub(crate) fn execute_wallet_open(
        &mut self, account_id: AccountId, amount: U128, request: WalletOpenRequest,
    ) -> Result<U128, String> {
        let (margin, _) = request.collateral(amount.0, false)?;
        self.with_transfer_margin(account_id, amount, |this, account_id| {
            this.try_open_position_for(account_id.clone(), request.market_id, request.side, U128(margin),
                request.leverage, request.brackets, request.margin_mode, request.execution, request.bracket_bounds)?;
            Ok(())
        })
    }

    pub(crate) fn receive_wallet_order(
        &mut self, account_id: AccountId, amount: U128, request: WalletOrderRequest,
    ) -> U128 {
        self.execute_wallet_order(account_id, amount, request).unwrap_or_else(|reason| {
            log!("wallet order rejected: {}", reason);
            amount
        })
    }

    fn execute_wallet_order(
        &mut self, account_id: AccountId, amount: U128, request: WalletOrderRequest,
    ) -> Result<U128, String> {
        let (margin, rewards) = request.entry.collateral(amount.0, true)?;
        let size = margin.checked_mul(u128::from(request.entry.leverage)).ok_or("ERR_OVERFLOW")?;
        let bracket_reserve = rewards - execution_reward(size);
        let execution = request.entry.execution;
        let bracket_bounds = request.entry.bracket_bounds;
        let entry = EntryOrder {
            market_id: request.entry.market_id, side: request.entry.side, margin: U128(margin),
            leverage: request.entry.leverage, trigger_price: request.trigger_price,
            brackets: request.entry.brackets, margin_mode: request.entry.margin_mode,
        };
        let request = match request.kind {
            WalletOrderKind::Limit => OrderRequest::Limit(entry),
            WalletOrderKind::StopMarket => OrderRequest::StopMarket(entry),
        };
        // Resting entries reserve funds only; their execution pulls and validates the price.
        self.with_transfer_margin(account_id, amount, |this, account_id| {
            let order = this.try_place_order_for(account_id.clone(), request, execution, bracket_bounds)?;
            let order = this.orders.get_mut(&order.id).unwrap();
            order.wallet_funded = true;
            order.bracket_reserve = U128(bracket_reserve);
            let account = this.accounts.get_mut(account_id).unwrap();
            account.margin -= bracket_reserve;
            account.reserved_margin += bracket_reserve;
            Ok(())
        })
    }

    fn with_transfer_margin(
        &mut self, account_id: AccountId, amount: U128,
        execute: impl FnOnce(&mut Self, &AccountId) -> Result<(), String>,
    ) -> Result<U128, String> {
        let existed = self.accounts.contains_key(&account_id);
        let previous = self.accounts.get(&account_id).map_or(0, |account| account.margin);
        let funded = previous.checked_add(amount.0).ok_or("ERR_OVERFLOW")?;
        self.accounts.entry(account_id.clone()).or_default().margin = funded;
        if let Err(reason) = execute(self, &account_id) {
            if existed { self.accounts.get_mut(&account_id).unwrap().margin = previous; }
            else { self.accounts.remove(&account_id); }
            return Err(reason);
        }
        let account = self.accounts.get_mut(&account_id).unwrap();
        let unused = account.margin.checked_sub(previous).expect("ERR_TRANSFER_MARGIN_ACCOUNTING");
        account.margin = previous;
        self.record_history(&account_id,
            HistoryEvent::transfer(HistoryKind::Deposit, amount.0 - unused, env::block_timestamp_ms()));
        Ok(U128(unused))
    }
}
