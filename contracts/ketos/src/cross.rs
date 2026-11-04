use near_sdk::json_types::{I128, U128};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId};

use crate::history::{HistoryEvent, HistoryKind};
use crate::liquidation::{split_equity, LiquidationRecord};
use crate::market::MAX_PRICE_AGE_MS;
use crate::math::{mul_div_floor, to_i128};
use crate::position::{PositionId, PositionView};
use crate::{emit_event, Ketos, KetosExt};

pub const MAX_CROSS_POSITIONS: u32 = 16;

#[near(serializers = [json, borsh])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MarginMode {
    #[default]
    Isolated,
    Cross,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq, Eq)]
pub struct CrossAccountView {
    pub account_id: AccountId,
    pub cash: I128,
    pub equity: I128,
    pub maintenance_margin: U128,
    /// None when no cross positions remain. 10,000 is the maintenance threshold.
    pub health_bps: Option<I128>,
    pub position_count: u32,
    pub prices_fresh: bool,
    pub liquidatable: bool,
    pub debt_by_vault: [U128; 2],
}

fn ratio_bps(equity: i128, maintenance: u128) -> i128 {
    let magnitude = to_i128(mul_div_floor(equity.unsigned_abs(), 10_000, maintenance));
    if equity < 0 {
        -magnitude
    } else {
        magnitude
    }
}

impl Ketos {
    pub(crate) fn cross_admission(
        &self,
        account_id: &AccountId,
        equity_added: i128,
        maintenance_added: u128,
        count_added: u32,
    ) -> Result<(), String> {
        let health = self.get_cross_account(account_id.clone());
        if !health.prices_fresh {
            return Err("ERR_STALE_CROSS_PRICE".into());
        }
        if health.position_count + count_added > MAX_CROSS_POSITIONS {
            return Err("ERR_TOO_MANY_CROSS_POSITIONS".into());
        }
        if health.equity.0 + equity_added
            <= to_i128(health.maintenance_margin.0 + maintenance_added)
        {
            return Err("ERR_CROSS_UNDERMARGINED".into());
        }
        Ok(())
    }

    /// Receivables preserve the original vault's claim without treating borrowed cash as liquidity.
    fn credit_cross_cash(&mut self, account_id: &AccountId, amount: i128, vault_index: usize) {
        let account = self.accounts.get_mut(account_id).unwrap();
        let old_debt = account.cross_cash.min(0).unsigned_abs();
        account.cross_cash += amount;
        let new_debt = account.cross_cash.min(0).unsigned_abs();
        if new_debt > old_debt {
            let added = new_debt - old_debt;
            account.cross_debt[vault_index] += added;
            self.vaults[vault_index].cross_receivable += added;
        } else {
            let mut repaid = old_debt - new_debt;
            for index in [vault_index, 1 - vault_index] {
                let debt = &mut account.cross_debt[index];
                let paid = repaid.min(*debt);
                *debt -= paid;
                self.vaults[index].cross_receivable -= paid;
                repaid -= paid;
            }
            debug_assert_eq!(repaid, 0);
        }
    }

    /// Default only after the last cross position exits; unrealized gains cannot erase a debt early.
    fn finish_cross_account(&mut self, account_id: &AccountId) -> u128 {
        let account = self.accounts.get_mut(account_id).unwrap();
        if !account.cross_positions.is_empty() {
            return 0;
        }
        let forgiven = account.cross_cash.min(0).unsigned_abs();
        for (index, debt) in account.cross_debt.iter_mut().enumerate() {
            let vault = &mut self.vaults[index];
            vault.balance -= *debt;
            vault.cross_receivable -= *debt;
            vault.revenue.trader_pnl.0 -= to_i128(*debt);
            *debt = 0;
        }
        account.margin += account.cross_cash.max(0) as u128;
        account.cross_cash = 0;
        if forgiven > 0 {
            emit_event(
                "cross_bad_debt",
                json!({ "account_id": account_id, "amount": U128(forgiven) }),
            );
        }
        forgiven
    }

    pub(crate) fn close_cross_position_at(
        &mut self,
        position_id: PositionId,
        price: u128,
        now_ms: u64,
    ) -> U128 {
        let (position, marked) = self.remove_position(position_id, price, now_ms);
        let index = self
            .markets
            .get(&position.market_id)
            .unwrap()
            .vault_id
            .index();
        let own_claim = self.accounts.get(&position.account_id).unwrap().cross_debt[index];
        let cash_available = self.vaults[index].balance - self.vaults[index].cross_receivable
            + position.margin
            + own_claim;
        let payout = (marked.equity - to_i128(marked.close_fee)).min(to_i128(cash_available));
        let fees = marked.borrow_fee + marked.close_fee;
        self.record_signed_settlement(
            index,
            position.margin,
            payout,
            fees,
            to_i128(marked.funding_paid) - to_i128(marked.funding_received),
            0,
        );
        self.credit_cross_cash(&position.account_id, payout, index);
        let forgiven = self.finish_cross_account(&position.account_id);
        let event =
            HistoryEvent::position(HistoryKind::Close, position_id, &position, price, now_ms);
        self.record_signed_exit(event, &position, &marked, payout + to_i128(forgiven), fees);
        emit_event(
            "position_closed",
            json!({
                "id": position_id, "account_id": position.account_id, "market_id": position.market_id,
                "margin_mode": MarginMode::Cross, "payout": I128(payout), "bad_debt": U128(forgiven),
                "exit_price": U128(price), "pnl": I128(marked.pnl),
            }),
        );
        U128(payout.max(0) as u128)
    }

    fn record_signed_settlement(
        &mut self,
        index: usize,
        collateral: u128,
        payout: i128,
        fees: u128,
        funding: i128,
        penalty: u128,
    ) {
        let vault = &mut self.vaults[index];
        let delta = to_i128(collateral) - payout;
        vault.balance = u128::try_from(to_i128(vault.balance) + delta).unwrap();
        vault.revenue.fees.0 += fees;
        vault.revenue.funding.0 += funding;
        vault.revenue.liquidations.0 += penalty;
        vault.revenue.trader_pnl.0 += delta - to_i128(fees) - funding - to_i128(penalty);
        vault
            .fee_log
            .record(env::block_timestamp_ms(), fees + penalty);
    }

    fn liquidate_cross_position(
        &mut self,
        position_id: PositionId,
        equity: i128,
        liquidator: &AccountId,
        now_ms: u64,
    ) -> LiquidationRecord {
        let market_id = &self.positions.get(&position_id).unwrap().market_id;
        let price = self.markets.get(market_id).unwrap().fresh_price(now_ms);
        let (position, marked) = self.remove_position(position_id, price, now_ms);
        let index = self
            .markets
            .get(&position.market_id)
            .unwrap()
            .vault_id
            .index();
        let available =
            self.vaults[index].balance - self.vaults[index].cross_receivable + position.margin;
        let (reward, penalty, _) = split_equity(equity.min(to_i128(available)), position.size);
        let own_claim = self.accounts.get(&position.account_id).unwrap().cross_debt[index];
        let payout = (marked.equity - to_i128(reward + penalty))
            .min(to_i128(available - reward + own_claim));
        self.record_signed_settlement(
            index,
            position.margin,
            payout + to_i128(reward),
            marked.borrow_fee,
            to_i128(marked.funding_paid) - to_i128(marked.funding_received),
            penalty,
        );
        self.credit_cross_cash(&position.account_id, payout, index);
        // Liquidator rewards are free collateral, never recycled into the liquidated pool.
        self.accounts.entry(liquidator.clone()).or_default().margin += reward;
        let forgiven = self.finish_cross_account(&position.account_id);
        let event = HistoryEvent::position(
            HistoryKind::Liquidation,
            position_id,
            &position,
            price,
            now_ms,
        );
        self.record_signed_exit(
            event,
            &position,
            &marked,
            payout + to_i128(forgiven),
            marked.borrow_fee + reward + penalty,
        );
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
            funding_payment: I128(to_i128(marked.funding_paid) - to_i128(marked.funding_received)),
            penalty: U128(penalty),
            reward: U128(reward),
            returned: U128(payout.max(0) as u128),
            liquidator: liquidator.clone(),
            timestamp_ms: now_ms,
        };
        self.record_liquidation(record.clone());
        record
    }
}

#[near]
impl Ketos {
    pub fn get_cross_account(&self, account_id: AccountId) -> CrossAccountView {
        let account = self.accounts.get(&account_id);
        let cash = account.map_or(0, |a| a.cross_cash);
        let mut equity = cash;
        let mut maintenance = 0;
        let mut count = 0;
        let mut fresh = true;
        let now_ms = env::block_timestamp_ms();
        if let Some(account) = account {
            for id in &account.cross_positions {
                let position = self.positions.get(id).unwrap();
                let market = self.markets.get(&position.market_id).unwrap();
                fresh &= market.price.0 > 0
                    && now_ms.saturating_sub(market.price_timestamp_ms) <= MAX_PRICE_AGE_MS;
                let marked = position.mark(market, market.price.0, now_ms);
                equity += marked.equity;
                maintenance += marked.maintenance;
                count += 1;
            }
        }
        CrossAccountView {
            account_id,
            cash: I128(cash),
            equity: I128(equity),
            maintenance_margin: U128(maintenance),
            health_bps: (maintenance > 0).then(|| I128(ratio_bps(equity, maintenance))),
            position_count: count,
            prices_fresh: fresh,
            liquidatable: fresh && count > 0 && equity <= to_i128(maintenance),
            debt_by_vault: account.map_or([U128(0); 2], |a| a.cross_debt.map(U128)),
        }
    }

    /// Moves free collateral into the shared pool, repaying outstanding vault claims first.
    pub fn add_cross_margin(&mut self, amount: U128) {
        let account_id = env::predecessor_account_id();
        require!(amount.0 > 0, "ERR_ZERO_AMOUNT");
        let account = self
            .accounts
            .get_mut(&account_id)
            .unwrap_or_else(|| env::panic_str("ERR_NO_ACCOUNT"));
        require!(account.margin >= amount.0, "ERR_INSUFFICIENT_MARGIN");
        account.margin -= amount.0;
        self.credit_cross_cash(&account_id, to_i128(amount.0), 0);
        emit_event(
            "cross_margin_added",
            json!({ "account_id": account_id, "amount": amount }),
        );
    }

    /// Moves settled cash back to free margin only while every remaining cross position is healthy in aggregate.
    pub fn remove_cross_margin(&mut self, amount: U128) {
        let account_id = env::predecessor_account_id();
        require!(amount.0 > 0, "ERR_ZERO_AMOUNT");
        let health = self.get_cross_account(account_id.clone());
        require!(health.prices_fresh, "ERR_STALE_CROSS_PRICE");
        require!(
            health.cash.0 >= to_i128(amount.0),
            "ERR_INSUFFICIENT_CROSS_CASH"
        );
        require!(
            health.position_count == 0
                || health.equity.0 - to_i128(amount.0) > to_i128(health.maintenance_margin.0),
            "ERR_CROSS_UNDERMARGINED"
        );
        let account = self.accounts.get_mut(&account_id).unwrap();
        account.cross_cash -= to_i128(amount.0);
        account.margin += amount.0;
        emit_event(
            "cross_margin_removed",
            json!({ "account_id": account_id, "amount": amount }),
        );
    }

    pub fn switch_to_cross(&mut self, position_id: PositionId) -> PositionView {
        let position = self
            .positions
            .get(&position_id)
            .unwrap_or_else(|| env::panic_str("ERR_NO_POSITION"));
        require!(
            position.account_id == env::predecessor_account_id(),
            "ERR_NOT_OWNER"
        );
        require!(
            position.margin_mode == MarginMode::Isolated,
            "ERR_ALREADY_CROSS"
        );
        let market = self.markets.get(&position.market_id).unwrap();
        let now_ms = env::block_timestamp_ms();
        let marked = position.mark(market, market.fresh_price(now_ms), now_ms);
        self.cross_admission(&position.account_id, marked.equity, marked.maintenance, 1)
            .unwrap_or_else(|reason| env::panic_str(&reason));
        let account_id = position.account_id.clone();
        self.accounts.get_mut(&account_id).unwrap().cross_positions.push(position_id);
        self.positions.get_mut(&position_id).unwrap().margin_mode = MarginMode::Cross;
        emit_event(
            "position_margin_mode",
            json!({ "position_id": position_id, "margin_mode": MarginMode::Cross }),
        );
        self.get_position(position_id).unwrap()
    }

    /// Closes whole positions by increasing equity/maintenance ratio, stopping as soon as health recovers.
    pub fn liquidate_cross(&mut self, account_id: AccountId) -> Vec<LiquidationRecord> {
        let mut health = self.get_cross_account(account_id.clone());
        require!(health.prices_fresh, "ERR_STALE_CROSS_PRICE");
        require!(health.liquidatable, "ERR_CROSS_HEALTHY");
        let now_ms = env::block_timestamp_ms();
        let liquidator = env::predecessor_account_id();
        let mut records = Vec::new();
        while health.liquidatable {
            let account = self.accounts.get(&account_id).unwrap();
            let riskiest = account
                .cross_positions
                .iter()
                .map(|id| {
                    let position = self.positions.get(id).unwrap();
                    let market = self.markets.get(&position.market_id).unwrap();
                    let marked = position.mark(market, market.price.0, now_ms);
                    (ratio_bps(marked.equity, marked.maintenance), *id)
                })
                .min()
                .unwrap()
                .1;
            records.push(self.liquidate_cross_position(
                riskiest,
                health.equity.0,
                &liquidator,
                now_ms,
            ));
            health = self.get_cross_account(account_id.clone());
        }
        emit_event(
            "cross_liquidated",
            json!({ "account_id": account_id, "closed": records.len(), "equity": health.equity, "maintenance_margin": health.maintenance_margin }),
        );
        records
    }
}
