//! First-market spot hedge. External capital never increases trading admission, and
//! uncertain execution never sells LP shares against an unconfirmed external balance.
use ketos_hedge_common::{*, policy::{plan_spot, PolicyInput, SpotPlan, MIN_TRADE}};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise, PromiseOrValue,
    json_types::U128, serde_json::{self, json, Value}, store::Vector};
use crate::{Ketos, KetosExt, StorageKey, emit_event, market::VaultId};

const MARKET: &str = "NEAR";
const HISTORY_LEN: u64 = 32;

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HedgeConfig {
    pub custody_id: AccountId,
    pub exchange_id: AccountId,
    pub wrapped_near_id: AccountId,
    pub pool_id: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct HedgeRequest {
    pub nonce: u64,
    pub kind: OperationKind,
    pub amount: U128,
    pub command: Option<TradeCommand>,
    pub call_complete: bool,
    pub funding_transferred: Option<bool>,
    pub return_received: U128,
    pub started_at_ms: u64,
    pub observed: Option<CustodySnapshot>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct HedgeRecord {
    pub fill: HedgeFill,
    /// A locator supplied by the keeper; clients must verify the referenced receipt.
    pub reported_transaction_hash: Option<String>,
}

#[near(serializers = [borsh])]
pub struct HedgeState {
    config: HedgeConfig,
    nonce: u64,
    confirmed: Option<CustodySnapshot>,
    pending: Option<HedgeRequest>,
    last_attempt_ms: Option<u64>,
    observed_at_ms: Option<u64>,
    fills: Vector<HedgeRecord>,
    fill_count: u64,
}

impl HedgeState {
    pub(crate) fn new(config: HedgeConfig) -> Self {
        Self { config, nonce: 0, confirmed: None, pending: None, last_attempt_ms: None,
            observed_at_ms: None, fills: Vector::new(StorageKey::HedgeFills), fill_count: 0 }
    }
}

#[near(serializers = [json])]
pub struct HedgeView {
    pub market_id: String,
    pub vault_id: VaultId,
    pub config: HedgeConfig,
    pub next_nonce: u64,
    pub confirmed: Option<CustodySnapshot>,
    pub pending: Option<HedgeRequest>,
    pub observed_at_ms: Option<u64>,
    pub plan: SpotPlan,
    pub recognized_value: U128,
    pub valuation_ready: bool,
    pub capital_limit: U128,
    pub per_trade_limit: U128,
    pub shortfall_limit_bps: u128,
    pub cooldown_ms: u64,
}

fn call(account: AccountId, method: &str, args: Value, gas: u64, deposit: u128) -> Promise {
    Promise::new(account).function_call(method.to_owned(), serde_json::to_vec(&args).unwrap(),
        NearToken::from_yoctonear(deposit), Gas::from_tgas(gas))
}
fn completed(nonce: u64) -> Promise {
    call(env::current_account_id(), "on_hedge_completed", json!({"nonce":nonce}), 20, 0)
}
fn same_book(a: &CustodySnapshot, b: &CustodySnapshot) -> bool {
    a.cash == b.cash && a.inventory == b.inventory && a.cost_basis == b.cost_basis
        && a.total_funded == b.total_funded && a.total_returned == b.total_returned
        && a.realized_pnl == b.realized_pnl && a.execution_cost == b.execution_cost
}
fn conserved(snapshot: &CustodySnapshot) -> bool {
    let assets = snapshot.cash.0.checked_add(snapshot.cost_basis.0)
        .and_then(|v| v.checked_add(snapshot.total_returned.0)).and_then(|v| i128::try_from(v).ok());
    let capital = i128::try_from(snapshot.total_funded.0).ok()
        .and_then(|v| v.checked_add(snapshot.realized_pnl.0));
    assets.is_some() && assets == capital
}

#[near]
impl Ketos {
    pub fn get_hedge(&self) -> Option<HedgeView> {
        let hedge = self.hedge.as_ref()?;
        let vault_id = self.hedge_vault_id();
        let (value, ready) = self.hedge_valuation(vault_id);
        Some(HedgeView { market_id: MARKET.into(), vault_id, config: hedge.config.clone(),
            next_nonce: hedge.nonce.checked_add(1).expect("ERR_HEDGE_NONCE"),
            confirmed: hedge.confirmed.clone(), pending: hedge.pending.clone(),
            observed_at_ms: hedge.observed_at_ms, plan: self.hedge_plan(),
            recognized_value: U128(value), valuation_ready: ready, capital_limit: U128(MAX_CAPITAL),
            per_trade_limit: U128(MAX_TRADE), shortfall_limit_bps: MAX_SHORTFALL_BPS,
            cooldown_ms: policy::COOLDOWN_MS })
    }

    pub fn get_hedge_fills(&self, limit: Option<u32>) -> Vec<HedgeRecord> {
        let Some(hedge) = &self.hedge else { return Vec::new(); };
        let count = u64::from(limit.unwrap_or(10)).min(u64::from(hedge.fills.len()));
        (1..=count).filter_map(|back| hedge.fills.get(((hedge.fill_count - back) % HISTORY_LEN) as u32).cloned()).collect()
    }

    pub fn fund_hedge(&mut self, nonce: u64, amount: U128) -> Promise {
        self.require_hedge_keeper();
        let plan = self.hedge_plan();
        let market = self.markets.get(MARKET).expect("ERR_HEDGE_MARKET");
        let price = market.price.0;
        require!(market.price_timestamp_ms <= env::block_timestamp_ms()
            && env::block_timestamp_ms() - market.price_timestamp_ms <= MAX_PRICE_AGE_MS && price > 0, "ERR_HEDGE_PRICE");
        let hedge = self.hedge.as_ref().expect("ERR_HEDGE_DISABLED");
        let book = hedge.confirmed.as_ref().expect("ERR_HEDGE_UNINITIALIZED");
        let committed = book.cash.0 + book.cost_basis.0;
        let budget = cash_value(plan.target_inventory.0, price).min(MAX_CAPITAL).saturating_sub(committed);
        let vault_id = self.hedge_vault_id();
        require!(amount.0 > 0 && amount.0 <= budget && amount.0 <= self.get_vault(vault_id).available.0, "ERR_HEDGE_CAPITAL");
        let custody_id = hedge.config.custody_id.clone();
        self.begin_hedge(nonce, OperationKind::Fund, amount, None);
        self.vaults.get_mut(&vault_id).unwrap().balance -= amount.0;
        call(self.usdc_id.clone(), "ft_transfer", json!({"receiver_id":custody_id,"amount":amount,
            "memo":format!("hedge funding {nonce}")}), 15, 1)
            .then(call(env::current_account_id(), "on_hedge_funded_transfer", json!({"nonce":nonce}), 150, 0))
            .then(completed(nonce))
    }

    pub fn rebalance_hedge(&mut self, nonce: u64, side: HedgeSide, amount_in: U128, min_out: U128, expires_at_ms: u64) -> Promise {
        self.require_hedge_keeper();
        let plan = self.hedge_plan();
        require!(plan.side == Some(side) && amount_in.0 > 0 && amount_in.0 <= plan.amount_in.0, "ERR_HEDGE_TARGET");
        let market = self.markets.get(MARKET).unwrap();
        let now = env::block_timestamp_ms();
        require!(expires_at_ms >= now && expires_at_ms - now <= MAX_DEADLINE_MS, "ERR_HEDGE_DEADLINE");
        let expected = match side {
            HedgeSide::Buy => { require!(amount_in.0 >= MIN_TRADE, "ERR_HEDGE_DUST"); token_quantity(amount_in.0, market.price.0) }
            HedgeSide::Sell => { let value = cash_value(amount_in.0, market.price.0); require!(value >= MIN_TRADE, "ERR_HEDGE_DUST"); value }
        };
        require!(min_out.0 > 0 && min_out.0 >= ratio(expected, BPS - MAX_SHORTFALL_BPS, BPS, true), "ERR_HEDGE_PRICE_BOUND");
        let command = TradeCommand { nonce, side, amount_in, min_out, price: market.price,
            price_timestamp_ms: market.price_timestamp_ms, deadline_ms: expires_at_ms };
        self.begin_hedge(nonce, OperationKind::Trade, amount_in, Some(command.clone()));
        let hedge = self.hedge.as_mut().unwrap();
        hedge.last_attempt_ms = Some(now);
        call(hedge.config.custody_id.clone(), "trade", json!({"command":command}), 245, 0).then(completed(nonce))
    }

    pub fn return_hedge_cash(&mut self, nonce: u64, amount: U128) -> Promise {
        self.require_hedge_keeper();
        let hedge = self.hedge.as_ref().expect("ERR_HEDGE_DISABLED");
        require!(amount.0 > 0 && amount.0 <= hedge.confirmed.as_ref().expect("ERR_HEDGE_UNINITIALIZED").cash.0, "ERR_HEDGE_CASH");
        let custody_id = hedge.config.custody_id.clone();
        self.begin_hedge(nonce, OperationKind::Return, amount, None);
        call(custody_id, "return_cash", json!({"nonce":nonce,"amount":amount}), 100, 0).then(completed(nonce))
    }

    /// Reads only. This cannot replace an unknown order with another order.
    pub fn sync_hedge(&self, reported_transaction_hash: Option<String>) -> Promise {
        self.require_hedge_keeper();
        let hedge = self.hedge.as_ref().expect("ERR_HEDGE_DISABLED");
        require!(hedge.pending.as_ref().is_none_or(|p| p.call_complete), "ERR_HEDGE_IN_FLIGHT");
        if let Some(hash) = &reported_transaction_hash {
            require!((32..=44).contains(&hash.len()) && hash.bytes().all(|b| b.is_ascii_alphanumeric()), "ERR_HEDGE_HASH");
        }
        call(hedge.config.custody_id.clone(), "get_state", json!({}), 10, 0)
            .then(call(env::current_account_id(), "on_hedge_snapshot", json!({
                "nonce":hedge.nonce,"reported_transaction_hash":reported_transaction_hash}), 60, 0))
    }

    pub fn recover_hedge(&mut self, nonce: u64) -> Promise {
        self.require_hedge_keeper();
        let hedge = self.hedge.as_mut().expect("ERR_HEDGE_DISABLED");
        let request = hedge.pending.as_mut().expect("ERR_NO_HEDGE_PENDING");
        require!(request.nonce == nonce && request.call_complete, "ERR_HEDGE_IN_FLIGHT");
        let observed = request.observed.as_ref().expect("ERR_SYNC_HEDGE_FIRST");
        let promise = if request.kind == OperationKind::Fund && observed.nonce < nonce {
            require!(request.funding_transferred == Some(true), "ERR_HEDGE_UNCERTAIN_TRANSFER");
            call(hedge.config.custody_id.clone(), "accept_funding", json!({"nonce":nonce,"amount":request.amount}), 100, 0)
        } else {
            require!(observed.pending.as_ref().is_some_and(|p| p.nonce == nonce), "ERR_NO_CUSTODY_PENDING");
            call(hedge.config.custody_id.clone(), "recover", json!({"nonce":nonce,
                "return_received":request.return_received}), 200, 0)
        };
        request.call_complete = false;
        promise.then(completed(nonce))
    }

    #[private]
    pub fn on_hedge_funded_transfer(&mut self, nonce: u64) -> PromiseOrValue<bool> {
        let Some(hedge) = self.hedge.as_mut() else { return PromiseOrValue::Value(false); };
        let Some(request) = hedge.pending.as_mut().filter(|p| p.nonce == nonce && p.kind == OperationKind::Fund) else { return PromiseOrValue::Value(false); };
        let transferred = match env::promise_result_checked(0, 128) {
            Ok(_) => true,
            Err(near_sdk::PromiseError::Failed) => false,
            Err(_) => return PromiseOrValue::Value(false),
        };
        request.funding_transferred = Some(transferred);
        if transferred {
            PromiseOrValue::Promise(call(hedge.config.custody_id.clone(), "accept_funding",
                json!({"nonce":nonce,"amount":request.amount}), 100, 0))
        } else { PromiseOrValue::Value(false) }
    }

    #[private]
    pub fn on_hedge_completed(&mut self, nonce: u64) -> bool {
        // Keep this callback constant-cost: it records completion, not success or a fill.
        if let Some(pending) = self.hedge.as_mut().and_then(|h| h.pending.as_mut()).filter(|p| p.nonce == nonce) {
            pending.call_complete = true;
            true
        } else { false }
    }

    #[private]
    pub fn on_hedge_snapshot(&mut self, nonce: u64, reported_transaction_hash: Option<String>) -> bool {
        let Ok(bytes) = env::promise_result_checked(0, 8192) else { return false; };
        let Ok(snapshot) = serde_json::from_slice::<CustodySnapshot>(&bytes) else { return false; };
        let vault_id = self.hedge_vault_id();
        let Some(hedge) = self.hedge.as_mut().filter(|h| h.nonce == nonce) else { return false; };
        let expected_config = CustodyConfig { controller: env::current_account_id(), usdc: self.usdc_id.clone(),
            wrapped_near: hedge.config.wrapped_near_id.clone(), exchange: hedge.config.exchange_id.clone(), pool_id: hedge.config.pool_id };
        if snapshot.config != expected_config || !conserved(&snapshot) { return false; }
        hedge.observed_at_ms = Some(env::block_timestamp_ms());
        let Some(before) = &hedge.confirmed else {
            if hedge.pending.is_none() && snapshot.pending.is_none() && snapshot.nonce == 0
                && snapshot.cash.0 == 0 && snapshot.inventory.0 == 0 && snapshot.cost_basis.0 == 0
                && snapshot.total_funded.0 == 0 && snapshot.total_returned.0 == 0
            { hedge.confirmed = Some(snapshot); return true; }
            return false;
        };
        let Some(request) = &mut hedge.pending else {
            // No new action was authorized: refuse unsolicited accounting changes.
            return snapshot.pending.is_none() && snapshot.nonce == before.nonce && same_book(before, &snapshot);
        };
        if !request.call_complete || snapshot.nonce > request.nonce || snapshot.nonce < before.nonce { return false; }
        request.observed = Some(snapshot.clone());
        if snapshot.pending.is_some() { return false; }
        let aborted = snapshot.nonce < request.nonce && same_book(before, &snapshot);
        let valid = match request.kind {
            OperationKind::Fund => {
                if aborted && request.funding_transferred == Some(false) {
                    self.vaults.get_mut(&vault_id).unwrap().balance += request.amount.0;
                    true
                } else {
                    request.funding_transferred == Some(true) && snapshot.nonce == request.nonce
                        && snapshot.total_funded.0.checked_sub(before.total_funded.0) == Some(request.amount.0)
                        && snapshot.cash.0.checked_sub(before.cash.0) == Some(request.amount.0)
                        && snapshot.inventory == before.inventory && snapshot.cost_basis == before.cost_basis
                        && snapshot.total_returned == before.total_returned && snapshot.realized_pnl == before.realized_pnl
                }
            }
            OperationKind::Return => {
                let used = request.return_received.0;
                (snapshot.nonce == request.nonce || aborted) && (used == 0 || used == request.amount.0)
                    && before.cash.0.checked_sub(snapshot.cash.0) == Some(used)
                    && snapshot.total_returned.0.checked_sub(before.total_returned.0) == Some(used)
                    && snapshot.inventory == before.inventory && snapshot.cost_basis == before.cost_basis
                    && snapshot.total_funded == before.total_funded && snapshot.realized_pnl == before.realized_pnl
            }
            OperationKind::Trade => {
                if snapshot.last_fill.as_ref().is_some_and(|f| f.nonce == request.nonce) {
                    let fill = snapshot.last_fill.as_ref().unwrap();
                    let command = request.command.as_ref().unwrap();
                    let quantities_match = match command.side {
                        HedgeSide::Buy => before.cash.0.checked_sub(snapshot.cash.0) == Some(command.amount_in.0)
                            && snapshot.inventory.0.checked_sub(before.inventory.0) == Some(fill.amount_out.0),
                        HedgeSide::Sell => before.inventory.0.checked_sub(snapshot.inventory.0) == Some(command.amount_in.0)
                            && snapshot.cash.0.checked_sub(before.cash.0) == Some(fill.amount_out.0),
                    };
                    snapshot.nonce == request.nonce && fill.side == command.side && fill.amount_in == command.amount_in
                        && fill.amount_out.0 >= command.min_out.0 && fill.reference_price == command.price
                        && fill.reference_timestamp_ms == command.price_timestamp_ms && quantities_match
                        && snapshot.total_funded == before.total_funded && snapshot.total_returned == before.total_returned
                } else { same_book(before, &snapshot) }
            }
        };
        if !valid { return false; }
        if request.kind == OperationKind::Trade {
            if let Some(fill) = snapshot.last_fill.as_ref().filter(|f| f.nonce == request.nonce) {
                let record = HedgeRecord { fill: fill.clone(), reported_transaction_hash };
                let slot = hedge.fill_count % HISTORY_LEN;
                if slot < u64::from(hedge.fills.len()) { hedge.fills.set(slot as u32, record); }
                else { hedge.fills.push(record); }
                hedge.fill_count += 1;
            }
        }
        emit_event("hedge_reconciled", json!({"nonce":request.nonce,"kind":request.kind,
            "cash":snapshot.cash,"inventory":snapshot.inventory,"realized_pnl":snapshot.realized_pnl}));
        hedge.confirmed = Some(snapshot);
        hedge.pending = None;
        true
    }
}

impl Ketos {
    fn require_hedge_keeper(&self) { require!(env::predecessor_account_id() == self.keeper_id, "ERR_NOT_KEEPER"); }
    fn hedge_vault_id(&self) -> VaultId { self.markets.get(MARKET).expect("ERR_HEDGE_MARKET").vault_id }
    fn begin_hedge(&mut self, nonce: u64, kind: OperationKind, amount: U128, command: Option<TradeCommand>) {
        let hedge = self.hedge.as_mut().expect("ERR_HEDGE_DISABLED");
        require!(hedge.confirmed.is_some() && hedge.pending.is_none(), "ERR_HEDGE_NOT_READY");
        require!(hedge.nonce.checked_add(1) == Some(nonce), "ERR_HEDGE_NONCE");
        hedge.nonce = nonce;
        hedge.pending = Some(HedgeRequest { nonce, kind, amount, command, call_complete: false,
            funding_transferred: None, return_received: U128(0), started_at_ms: env::block_timestamp_ms(), observed: None });
    }
    pub(crate) fn receive_hedge_return(&mut self, sender: &AccountId, amount: U128, nonce: u64) -> U128 {
        let vault_id = self.hedge_vault_id();
        let Some(hedge) = self.hedge.as_mut() else { return amount; };
        if *sender != hedge.config.custody_id { return amount; }
        let Some(pending) = hedge.pending.as_mut().filter(|p| p.nonce == nonce && p.kind == OperationKind::Return
            && p.amount == amount && p.return_received.0 == 0) else { return amount; };
        pending.return_received = amount;
        self.vaults.get_mut(&vault_id).unwrap().balance += amount.0;
        U128(0)
    }
    pub(crate) fn hedge_valuation(&self, vault_id: VaultId) -> (u128, bool) {
        let Some(hedge) = &self.hedge else { return (0, true); };
        if vault_id != self.hedge_vault_id() { return (0, true); }
        if hedge.pending.is_some() { return (0, false); }
        let Some(book) = &hedge.confirmed else { return (0, true); };
        if book.inventory.0 == 0 { return (book.cash.0, true); }
        let market = self.markets.get(MARKET).unwrap();
        let now = env::block_timestamp_ms();
        if market.price.0 == 0 || market.price_timestamp_ms > now || now - market.price_timestamp_ms > MAX_PRICE_AGE_MS {
            return (book.cash.0, false);
        }
        (book.cash.0 + ratio(cash_value(book.inventory.0, market.price.0), BPS - MAX_SHORTFALL_BPS, BPS, false), true)
    }
    fn hedge_plan(&self) -> SpotPlan {
        let market = self.markets.get(MARKET).expect("ERR_HEDGE_MARKET");
        let now = env::block_timestamp_ms();
        let mut trader_delta = 0i128;
        for position in self.positions.values().filter(|p| p.market_id == MARKET) {
            let marked = position.mark(market, market.price.0, now);
            if marked.pnl >= crate::math::to_i128(position.size) { continue; }
            let uncollectible = if marked.pnl >= 0 { false } else if position.margin_mode == crate::cross::MarginMode::Cross {
                // Shared cash and other legs can still back this leg after its own margin is exhausted.
                self.accounts.get(&position.account_id).is_some_and(|account| {
                    let equity = account.cross_positions.iter().fold(account.cross_cash, |equity, id| {
                        let leg = self.positions.get(id).unwrap();
                        let leg_market = self.markets.get(&leg.market_id).unwrap();
                        equity.checked_add(leg.mark(leg_market, leg_market.price.0, now).equity).expect("ERR_OVERFLOW")
                    });
                    equity <= 0
                })
            } else { marked.equity <= 0 };
            if marked.pnl < 0 && uncollectible { continue; }
            let quantity = signed(token_quantity(position.size, position.entry_price));
            trader_delta = trader_delta.checked_add(if position.is_long() { quantity } else { -quantity }).expect("ERR_OVERFLOW");
        }
        let hedge = self.hedge.as_ref();
        let book = hedge.and_then(|h| h.confirmed.as_ref());
        plan_spot(PolicyInput { trader_delta, inventory: book.map_or(0, |b| b.inventory.0),
            cash: book.map_or(0, |b| b.cash.0), price: market.price.0, price_timestamp_ms: market.price_timestamp_ms,
            now_ms: now, last_attempt_ms: hedge.and_then(|h| h.last_attempt_ms),
            pending: hedge.is_none_or(|h| h.pending.is_some() || h.confirmed.is_none()) })
    }
}

#[cfg(test)]
#[path = "tests/hedge.rs"]
mod tests;
