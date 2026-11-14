//! Dedicated spot custody: only the controller authorizes movement, and only observed
//! token holdings become book assets. Ref's atomic swaps have no venue-side deadline;
//! expiry is checked before dispatch, while min_out remains enforced by the venue.
use std::collections::BTreeMap;
use ketos_hedge_common::*;
use near_sdk::{env, json_types::{I128, U128}, near, require, serde::de::DeserializeOwned,
    serde_json::{self, json, Value}, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue, PromiseError};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Custody { state: CustodySnapshot }

#[near(serializers = [json])]
struct Pool {
    pool_kind: String,
    token_account_ids: Vec<AccountId>,
    amounts: Vec<U128>,
    total_fee: u32,
}

fn result<T: DeserializeOwned>(index: u64) -> Option<T> {
    match env::promise_result_checked(index, 4096) {
        Ok(bytes) => serde_json::from_slice(&bytes).ok(),
        Err(_) => None,
    }
}
fn call(account: AccountId, method: &str, args: Value, gas: u64, yocto: u128) -> Promise {
    Promise::new(account).function_call(method.to_owned(), serde_json::to_vec(&args).unwrap(),
        NearToken::from_yoctonear(yocto), Gas::from_tgas(gas))
}
fn callback(method: &str, nonce: u64, gas: u64) -> Promise {
    call(env::current_account_id(), method, json!({"nonce": nonce}), gas, 0)
}

#[near]
impl Custody {
    #[init]
    #[private]
    pub fn new(config: CustodyConfig) -> Self {
        require!(config.usdc != config.wrapped_near && config.controller != env::current_account_id(), "ERR_CONFIG");
        Self { state: CustodySnapshot {
            config, nonce: 0, cash: U128(0), inventory: U128(0), cost_basis: U128(0),
            total_funded: U128(0), total_returned: U128(0), realized_pnl: I128(0),
            execution_cost: I128(0), pending: None, last_fill: None,
        } }
    }

    pub fn get_state(&self) -> CustodySnapshot { self.state.clone() }

    /// Called only after the controller's atomic NEP-141 transfer succeeds.
    pub fn accept_funding(&mut self, nonce: u64, amount: U128) -> Promise {
        self.authorize(nonce);
        require!(amount.0 > 0 && self.state.cash.0 + self.state.cost_basis.0 + amount.0 <= MAX_CAPITAL, "ERR_CAPITAL_LIMIT");
        self.begin(nonce, OperationKind::Fund, amount, None, CustodyPhase::Funding);
        self.balances().then(callback("on_balances", nonce, 50))
    }

    pub fn trade(&mut self, command: TradeCommand) -> Promise {
        self.authorize(command.nonce);
        self.validate(&command);
        let nonce = command.nonce;
        self.begin(nonce, OperationKind::Trade, command.amount_in, Some(command), CustodyPhase::Preflight);
        self.balances().and(call(self.state.config.exchange.clone(), "get_pool",
            json!({"pool_id": self.state.config.pool_id}), 7, 0))
            .then(callback("on_preflight", nonce, 205))
    }

    pub fn return_cash(&mut self, nonce: u64, amount: U128) -> Promise {
        self.authorize(nonce);
        require!(amount.0 > 0 && amount.0 <= self.state.cash.0, "ERR_CASH");
        self.begin(nonce, OperationKind::Return, amount, None, CustodyPhase::Returning);
        call(self.state.config.usdc.clone(), "ft_transfer_call", json!({
            "receiver_id": self.state.config.controller, "amount": amount,
            "msg": format!("{RETURN_PREFIX}{nonce}")
        }), 45, 1).then(callback("on_return", nonce, 40))
    }

    /// The controller must first observe completion of the entire original promise chain.
    /// Recovery never dispatches a swap; it only retrieves existing venue assets.
    pub fn recover(&mut self, nonce: u64, return_received: U128) -> Promise {
        self.controller();
        let pending = self.state.pending.as_mut().expect("ERR_NO_PENDING");
        require!(pending.nonce == nonce, "ERR_NONCE");
        if pending.kind == OperationKind::Return {
            require!(return_received.0 == 0 || return_received == pending.amount, "ERR_RETURN_AMOUNT");
            pending.deposited = return_received;
        } else {
            require!(return_received.0 == 0, "ERR_RETURN_AMOUNT");
        }
        self.balances().then(callback("on_recovery", nonce, 165))
    }

    #[private]
    pub fn on_preflight(&mut self, nonce: u64) -> PromiseOrValue<CustodySnapshot> {
        if !self.matches(nonce, CustodyPhase::Preflight) { return self.value(); }
        let Some((wallet, venue)) = self.observed() else { return self.uncertain(); };
        let Some(pool) = result::<Pool>(3) else { return self.uncertain(); };
        let config = &self.state.config;
        if pool.pool_kind != "SIMPLE_POOL" || pool.total_fee > 30 || pool.amounts.len() != 2
            || pool.amounts.iter().any(|v| v.0 == 0) || pool.token_account_ids.len() != 2
            || !pool.token_account_ids.contains(&config.usdc) || !pool.token_account_ids.contains(&config.wrapped_near)
            || wallet[0].0 < self.state.cash.0 || wallet[1].0 < self.state.inventory.0
        { return self.uncertain(); }
        let pending = self.state.pending.as_mut().unwrap();
        pending.wallet_before = wallet;
        pending.venue_before = venue;
        let command = pending.command.as_ref().unwrap();
        if !Self::fresh(command) { self.state.pending = None; return self.value(); }
        let side = command.side;
        let input = self.token(side, true);
        let amount = self.state.pending.as_ref().unwrap().amount;
        self.state.pending.as_mut().unwrap().phase = CustodyPhase::Depositing;
        PromiseOrValue::Promise(call(input, "ft_transfer_call", json!({
            "receiver_id": self.state.config.exchange, "amount": amount, "msg": ""
        }), 45, 1).then(callback("on_deposit", nonce, 150)))
    }

    #[private]
    pub fn on_deposit(&mut self, nonce: u64) -> PromiseOrValue<CustodySnapshot> {
        if !self.matches(nonce, CustodyPhase::Depositing) { return self.value(); }
        let Some(used) = result::<U128>(0) else { return self.uncertain(); };
        let pending = self.state.pending.as_mut().unwrap();
        if used.0 > pending.amount.0 { return self.uncertain(); }
        pending.deposited = used;
        let command = pending.command.as_ref().unwrap().clone();
        if used != command.amount_in || !Self::fresh(&command) {
            if used.0 == 0 { return PromiseOrValue::Promise(self.check(nonce, 110)); }
            return PromiseOrValue::Promise(self.withdraw(self.token(command.side, true), used, nonce, 100));
        }
        self.state.pending.as_mut().unwrap().phase = CustodyPhase::Swapping;
        PromiseOrValue::Promise(call(self.state.config.exchange.clone(), "swap", json!({
            "actions": [{"pool_id": self.state.config.pool_id, "token_in": self.token(command.side, true),
                "token_out": self.token(command.side, false), "amount_in": command.amount_in,
                "min_amount_out": command.min_out}], "referral_id": null
        }), 20, 1).then(callback("on_swap", nonce, 115)))
    }

    #[private]
    pub fn on_swap(&mut self, nonce: u64) -> PromiseOrValue<CustodySnapshot> {
        if !self.matches(nonce, CustodyPhase::Swapping) { return self.value(); }
        let pending = self.state.pending.as_ref().unwrap();
        let command = pending.command.as_ref().unwrap().clone();
        match env::promise_result_checked(0, 128) {
            Err(PromiseError::Failed) => PromiseOrValue::Promise(self.withdraw(self.token(command.side, true), command.amount_in, nonce, 70)),
            Err(_) => self.uncertain(),
            Ok(bytes) => {
                let Ok(output) = serde_json::from_slice::<U128>(&bytes) else { return self.uncertain(); };
                if output.0 < command.min_out.0 { return self.uncertain(); }
                let pending = self.state.pending.as_mut().unwrap();
                pending.output = output;
                pending.swapped = true;
                PromiseOrValue::Promise(self.withdraw(self.token(command.side, false), output, nonce, 70))
            }
        }
    }

    #[private]
    pub fn on_withdraw(&mut self, nonce: u64) -> PromiseOrValue<CustodySnapshot> {
        if !self.matches(nonce, CustodyPhase::Withdrawing) { return self.value(); }
        // A successful Ref root receipt alone does not prove the FT arrived.
        PromiseOrValue::Promise(self.check(nonce, 35))
    }

    #[private]
    pub fn on_return(&mut self, nonce: u64) -> PromiseOrValue<CustodySnapshot> {
        if !self.matches(nonce, CustodyPhase::Returning) { return self.value(); }
        let Some(used) = result::<U128>(0) else { return self.uncertain(); };
        let amount = self.state.pending.as_ref().unwrap().amount.0;
        if used.0 == amount {
            self.state.cash.0 -= amount;
            self.state.total_returned.0 += amount;
            self.state.pending = None;
        } else if used.0 == 0 {
            self.state.pending = None;
        } else { return self.uncertain(); }
        self.value()
    }

    #[private]
    pub fn on_balances(&mut self, nonce: u64) -> PromiseOrValue<CustodySnapshot> {
        if self.state.pending.as_ref().is_none_or(|p| p.nonce != nonce) { return self.value(); }
        let Some((wallet, _venue)) = self.observed() else { return self.uncertain(); };
        self.settle(wallet)
    }

    #[private]
    pub fn on_recovery(&mut self, nonce: u64) -> PromiseOrValue<CustodySnapshot> {
        if self.state.pending.as_ref().is_none_or(|p| p.nonce != nonce) { return self.value(); }
        let Some((wallet, venue)) = self.observed() else { return self.uncertain(); };
        let pending = self.state.pending.as_ref().unwrap().clone();
        if pending.kind != OperationKind::Trade { return self.settle(wallet); }
        if pending.phase == CustodyPhase::Preflight {
            // No deposit can have been dispatched before the preflight callback commits.
            return self.settle(wallet);
        }
        let command = pending.command.as_ref().unwrap();
        let (input, output) = match command.side { HedgeSide::Buy => (0, 1), HedgeSide::Sell => (1, 0) };
        let input_delta = venue[input].0.saturating_sub(pending.venue_before[input].0);
        let output_delta = venue[output].0.saturating_sub(pending.venue_before[output].0);
        if pending.swapped {
            if output_delta >= pending.output.0 {
                return PromiseOrValue::Promise(self.withdraw(self.token(command.side, false), pending.output, nonce, 110));
            }
            return self.settle(wallet);
        }
        if input_delta > 0 && input_delta <= pending.amount.0 {
            // A partial NEP-141 deposit is refunded; it never becomes a partial swap.
            return PromiseOrValue::Promise(self.withdraw(self.token(command.side, true), U128(input_delta), nonce, 110));
        }
        if input_delta == 0 && output_delta >= command.min_out.0
            && pending.deposited == pending.amount
        {
            let pending = self.state.pending.as_mut().unwrap();
            pending.swapped = true;
            pending.output = U128(output_delta);
            pending.recovered = true;
            return PromiseOrValue::Promise(self.withdraw(self.token(command.side, false), U128(output_delta), nonce, 110));
        }
        self.settle(wallet)
    }
}

impl Custody {
    fn controller(&self) { require!(env::predecessor_account_id() == self.state.config.controller, "ERR_CONTROLLER"); }
    fn authorize(&self, nonce: u64) {
        self.controller();
        require!(self.state.pending.is_none(), "ERR_PENDING");
        require!(nonce > self.state.nonce, "ERR_NONCE");
    }
    fn fresh(command: &TradeCommand) -> bool {
        let now = env::block_timestamp_ms();
        command.price.0 > 0 && command.price_timestamp_ms <= now
            && now - command.price_timestamp_ms <= MAX_PRICE_AGE_MS && now <= command.deadline_ms
    }
    fn validate(&self, command: &TradeCommand) {
        require!(Self::fresh(command) && command.deadline_ms - env::block_timestamp_ms() <= MAX_DEADLINE_MS, "ERR_PRICE_EXPIRED");
        require!(command.amount_in.0 > 0 && command.min_out.0 > 0, "ERR_AMOUNT");
        let expected = match command.side {
            HedgeSide::Buy => {
                require!(command.amount_in.0 <= self.state.cash.0 && command.amount_in.0 <= MAX_TRADE, "ERR_CASH");
                token_quantity(command.amount_in.0, command.price.0)
            }
            HedgeSide::Sell => {
                require!(command.amount_in.0 <= self.state.inventory.0, "ERR_INVENTORY");
                let value = cash_value(command.amount_in.0, command.price.0);
                require!(value <= MAX_TRADE, "ERR_TRADE_LIMIT");
                value
            }
        };
        require!(command.min_out.0 >= ratio(expected, BPS - MAX_SHORTFALL_BPS, BPS, true), "ERR_PRICE_BOUND");
    }
    fn begin(&mut self, nonce: u64, kind: OperationKind, amount: U128, command: Option<TradeCommand>, phase: CustodyPhase) {
        self.state.nonce = nonce;
        self.state.pending = Some(PendingOperation { nonce, kind, command, amount, output: U128(0),
            deposited: U128(0), phase, started_at_ms: env::block_timestamp_ms(), swapped: false,
            wallet_before: [self.state.cash, self.state.inventory], venue_before: [U128(0); 2], recovered: false });
    }
    fn matches(&self, nonce: u64, phase: CustodyPhase) -> bool {
        self.state.pending.as_ref().is_some_and(|p| p.nonce == nonce && p.phase == phase)
    }
    fn token(&self, side: HedgeSide, input: bool) -> AccountId {
        if (side == HedgeSide::Buy) == input { self.state.config.usdc.clone() }
        else { self.state.config.wrapped_near.clone() }
    }
    fn value(&self) -> PromiseOrValue<CustodySnapshot> { PromiseOrValue::Value(self.get_state()) }
    fn uncertain(&mut self) -> PromiseOrValue<CustodySnapshot> {
        if let Some(pending) = &mut self.state.pending { pending.phase = CustodyPhase::Uncertain; }
        self.value()
    }
    fn balances(&self) -> Promise {
        let args = json!({"account_id": env::current_account_id()});
        call(self.state.config.usdc.clone(), "ft_balance_of", args.clone(), 7, 0)
            .and(call(self.state.config.wrapped_near.clone(), "ft_balance_of", args.clone(), 7, 0))
            .and(call(self.state.config.exchange.clone(), "get_deposits", args, 7, 0))
    }
    fn observed(&self) -> Option<([U128; 2], [U128; 2])> {
        let cash = result::<U128>(0)?;
        let inventory = result::<U128>(1)?;
        let deposits = result::<BTreeMap<AccountId, U128>>(2)?;
        Some(([cash, inventory], [*deposits.get(&self.state.config.usdc).unwrap_or(&U128(0)),
            *deposits.get(&self.state.config.wrapped_near).unwrap_or(&U128(0))]))
    }
    fn check(&mut self, nonce: u64, gas: u64) -> Promise {
        self.state.pending.as_mut().unwrap().phase = CustodyPhase::Checking;
        self.balances().then(callback("on_balances", nonce, gas))
    }
    fn withdraw(&mut self, token: AccountId, amount: U128, nonce: u64, callback_gas: u64) -> Promise {
        self.state.pending.as_mut().unwrap().phase = CustodyPhase::Withdrawing;
        call(self.state.config.exchange.clone(), "withdraw", json!({"token_id": token,
            "amount": amount, "unregister": false}), 35, 1)
            .then(callback("on_withdraw", nonce, callback_gas))
    }
    fn settle(&mut self, wallet: [U128; 2]) -> PromiseOrValue<CustodySnapshot> {
        let pending = self.state.pending.as_ref().unwrap().clone();
        match pending.kind {
            OperationKind::Fund => {
                if wallet[0].0 < self.state.cash.0 + pending.amount.0 || wallet[1].0 < self.state.inventory.0 { return self.uncertain(); }
                self.state.cash.0 += pending.amount.0;
                self.state.total_funded.0 += pending.amount.0;
            }
            OperationKind::Return => {
                let used = pending.deposited.0;
                if wallet[0].0 < self.state.cash.0 - used || wallet[1].0 < self.state.inventory.0 { return self.uncertain(); }
                self.state.cash.0 -= used;
                self.state.total_returned.0 += used;
            }
            OperationKind::Trade => {
                let command = pending.command.as_ref().unwrap();
                let mut expected = pending.wallet_before;
                if !pending.swapped {
                    if wallet[0].0 < expected[0].0 || wallet[1].0 < expected[1].0 { return self.uncertain(); }
                    self.state.pending = None;
                    return self.value();
                }
                let (input, output) = match command.side { HedgeSide::Buy => (0, 1), HedgeSide::Sell => (1, 0) };
                expected[input].0 -= command.amount_in.0;
                let Some(out_balance) = expected[output].0.checked_add(pending.output.0) else { return self.uncertain(); };
                expected[output].0 = out_balance;
                if wallet[0].0 < expected[0].0 || wallet[1].0 < expected[1].0 { return self.uncertain(); }
                let (cost, realized) = match command.side {
                    HedgeSide::Buy => {
                        self.state.cash.0 -= command.amount_in.0;
                        self.state.inventory.0 += pending.output.0;
                        self.state.cost_basis.0 += command.amount_in.0;
                        (signed(command.amount_in.0) - signed(cash_value(pending.output.0, command.price.0)), 0)
                    }
                    HedgeSide::Sell => {
                        let basis = ratio(self.state.cost_basis.0, command.amount_in.0, self.state.inventory.0, false);
                        self.state.inventory.0 -= command.amount_in.0;
                        self.state.cost_basis.0 -= basis;
                        self.state.cash.0 += pending.output.0;
                        (signed(cash_value(command.amount_in.0, command.price.0)) - signed(pending.output.0), signed(pending.output.0) - signed(basis))
                    }
                };
                self.state.realized_pnl.0 += realized;
                self.state.execution_cost.0 += cost;
                let fill = HedgeFill { nonce: pending.nonce, side: command.side, amount_in: command.amount_in,
                    amount_out: pending.output, reference_price: command.price, reference_timestamp_ms: command.price_timestamp_ms,
                    started_at_ms: pending.started_at_ms, confirmed_at_ms: env::block_timestamp_ms(),
                    execution_cost: I128(cost), realized_pnl: I128(realized), recovered: pending.recovered };
                env::log_str(&format!("EVENT_JSON:{}", json!({"standard":"ketos_hedge", "version":"1.0.0", "event":"fill", "data":[&fill]})));
                self.state.last_fill = Some(fill);
            }
        }
        self.state.pending = None;
        self.value()
    }
}

#[cfg(test)]
mod tests;
