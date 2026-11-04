use near_sdk::json_types::{I128, U128};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId};

use crate::funding::side_index;
use crate::history::{HistoryEvent, HistoryKind};
use crate::market::{Market, MarketId, USD};
use crate::math::{borrow_fee, liquidation_price, maintenance_margin, pnl, to_i128, trade_fee};
use crate::orders::{Brackets, OrderId};
use crate::{emit_event, Ketos, KetosExt};

/// Smallest collateral a position can be opened with.
pub const MIN_POSITION_MARGIN: u128 = USD;

pub type PositionId = u64;

#[near(serializers = [json, borsh])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Long,
    Short,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Position {
    pub account_id: AccountId,
    pub market_id: MarketId,
    pub side: Side,
    /// Collateral locked in the position, after the opening fee.
    pub margin: u128,
    /// Notional size in USDC units (margin committed × leverage).
    pub size: u128,
    pub entry_price: u128,
    pub leverage: u32,
    /// Market max leverage when opened: fixes the maintenance margin for the position's life.
    pub max_leverage: u32,
    pub entry_borrow_index: u128,
    pub entry_funding_paid_index: u128,
    pub entry_funding_received_index: u128,
    pub opened_at_ms: u64,
    pub take_profit: Option<OrderId>,
    pub stop_loss: Option<OrderId>,
}

/// Position marked at the current oracle price, with fees accrued so far.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PositionView {
    pub id: PositionId,
    pub account_id: AccountId,
    pub market_id: MarketId,
    pub side: Side,
    pub margin: U128,
    pub size: U128,
    pub entry_price: U128,
    pub leverage: u32,
    pub max_leverage: u32,
    pub opened_at_ms: u64,
    pub mark_price: U128,
    pub mark_price_timestamp_ms: u64,
    pub unrealized_pnl: I128,
    pub borrow_fee: U128,
    pub close_fee: U128,
    /// Accrued USDC debits and credits; realized in free margin when the position exits.
    pub funding_paid: U128,
    pub funding_received: U128,
    /// Positive = paid by this position, negative = received.
    pub funding_payment: I128,
    /// margin + unrealized PnL − borrow fee − net funding payment.
    pub equity: I128,
    pub maintenance_margin: U128,
    pub liquidation_price: U128,
    pub take_profit: Option<OrderId>,
    pub stop_loss: Option<OrderId>,
}

/// Result of marking a position to a price at a given time.
pub(crate) struct Marked {
    pub pnl: i128,
    pub borrow_fee: u128,
    pub close_fee: u128,
    pub funding_paid: u128,
    pub funding_received: u128,
    pub equity: i128,
    pub maintenance: u128,
}

/// Part of `fees` actually paid by a settled position: what is left of its margin after the
/// trading loss. Fees an underwater position could not cover are not income.
pub(crate) fn fees_covered(position: &Position, marked: &Marked, fees: u128) -> u128 {
    let left = to_i128(position.margin) + marked.pnl
        - (to_i128(marked.funding_paid) - to_i128(marked.funding_received));
    u128::try_from(left.max(0)).unwrap_or(0).min(fees)
}

/// A payer cannot contribute funding beyond collateral plus price PnL. Credits are
/// honored by the assigned vault, including when they offset an otherwise unpaid loss.
pub(crate) fn realized_funding(position: &Position, marked: &Marked) -> i128 {
    let net = to_i128(marked.funding_paid) - to_i128(marked.funding_received);
    if net > 0 {
        net.min((to_i128(position.margin) + marked.pnl).max(0))
    } else {
        net
    }
}

impl Position {
    pub fn is_long(&self) -> bool {
        self.side == Side::Long
    }

    pub(crate) fn mark(&self, market: &Market, price: u128, now_ms: u64) -> Marked {
        let pnl = pnl(self.is_long(), self.size, self.entry_price, price);
        let borrow_fee = borrow_fee(
            self.size,
            self.entry_borrow_index,
            market.borrow_index_at(self.side, now_ms),
        );
        let (funding_paid, funding_received) = market.funding_at(now_ms).amounts(
            self.side,
            self.size,
            self.entry_funding_paid_index,
            self.entry_funding_received_index,
        );
        Marked {
            pnl,
            borrow_fee,
            close_fee: trade_fee(self.size, market.fee_bps),
            funding_paid,
            funding_received,
            equity: to_i128(self.margin) + pnl - to_i128(borrow_fee)
                - to_i128(funding_paid) + to_i128(funding_received),
            maintenance: maintenance_margin(self.size, self.max_leverage),
        }
    }

    fn view(&self, id: PositionId, market: &Market, now_ms: u64) -> PositionView {
        let price = market.price.0;
        let marked = self.mark(market, price, now_ms);
        let buffer =
            to_i128(self.margin) - to_i128(marked.borrow_fee) - to_i128(marked.maintenance)
                - to_i128(marked.funding_paid) + to_i128(marked.funding_received);
        PositionView {
            id,
            account_id: self.account_id.clone(),
            market_id: self.market_id.clone(),
            side: self.side,
            margin: U128(self.margin),
            size: U128(self.size),
            entry_price: U128(self.entry_price),
            leverage: self.leverage,
            max_leverage: self.max_leverage,
            opened_at_ms: self.opened_at_ms,
            mark_price: U128(price),
            mark_price_timestamp_ms: market.price_timestamp_ms,
            unrealized_pnl: I128(marked.pnl),
            borrow_fee: U128(marked.borrow_fee),
            close_fee: U128(marked.close_fee),
            funding_paid: U128(marked.funding_paid),
            funding_received: U128(marked.funding_received),
            funding_payment: I128(to_i128(marked.funding_paid) - to_i128(marked.funding_received)),
            equity: I128(marked.equity),
            maintenance_margin: U128(marked.maintenance),
            take_profit: self.take_profit,
            stop_loss: self.stop_loss,
            liquidation_price: U128(liquidation_price(
                self.is_long(),
                self.size,
                self.entry_price,
                buffer,
            )),
        }
    }
}

impl Ketos {
    pub(crate) fn market_mut(&mut self, market_id: &MarketId) -> &mut Market {
        self.markets
            .get_mut(market_id)
            .unwrap_or_else(|| env::panic_str("ERR_UNKNOWN_MARKET"))
    }

    /// Takes a position off the books (open interest, owner's list) and marks it at `price`.
    pub(crate) fn remove_position(
        &mut self,
        id: PositionId,
        price: u128,
        now_ms: u64,
    ) -> (Position, Marked) {
        let position = self
            .positions
            .remove(&id)
            .unwrap_or_else(|| env::panic_str("ERR_NO_POSITION"));
        let market = self.market_mut(&position.market_id);
        market.accrue(now_ms);
        let marked = position.mark(market, price, now_ms);
        let oi = market.oi_mut(position.side);
        *oi = oi.saturating_sub(position.size);
        market.track(
            position.side,
            position.size,
            position.entry_price,
            position.entry_borrow_index,
            false,
        );
        market.funding.track(
            position.side,
            position.size,
            position.entry_funding_paid_index,
            position.entry_funding_received_index,
            false,
        );
        self.emit_position_funding(
            id,
            &position.account_id,
            &position.market_id,
            marked.funding_paid,
            marked.funding_received,
            now_ms,
        );

        let account = self
            .accounts
            .get_mut(&position.account_id)
            .unwrap_or_else(|| env::panic_str("ERR_NO_ACCOUNT"));
        account.positions.retain(|p| *p != id);
        self.cancel_position_orders(&position);
        (position, marked)
    }

    /// Removes a position and returns what is owed to the trader: margin plus PnL minus
    /// borrow and closing fees, floored at zero. The vault takes the other side: it keeps
    /// losses and fees, and pays gains up to its balance.
    pub(crate) fn settle_position(
        &mut self,
        id: PositionId,
        price: u128,
        now_ms: u64,
    ) -> (Position, Marked, u128) {
        let (position, marked) = self.remove_position(id, price, now_ms);
        let owed = marked.equity - to_i128(marked.close_fee);
        let mut payout = u128::try_from(owed.max(0)).unwrap_or(0);
        let vault_id = self.markets.get(&position.market_id).unwrap().vault_id;
        let available = self.vaults[vault_id.index()].balance + position.margin;
        if payout > available {
            payout = available;
        }
        let fees = fees_covered(&position, &marked, marked.borrow_fee + marked.close_fee);
        let net_funding = realized_funding(&position, &marked);
        self.record_settlement(vault_id, position.margin, payout, fees, net_funding, 0);
        (position, marked, payout)
    }

    fn position_view(&self, id: PositionId, position: &Position) -> PositionView {
        let market = self
            .markets
            .get(&position.market_id)
            .unwrap_or_else(|| env::panic_str("ERR_UNKNOWN_MARKET"));
        position.view(id, market, env::block_timestamp_ms())
    }
}

impl Ketos {
    pub(crate) fn try_open_position_for(
        &mut self,
        account_id: AccountId,
        market_id: MarketId,
        side: Side,
        margin: U128,
        leverage: u32,
        brackets: Option<Brackets>,
    ) -> Result<PositionView, String> {
        let now_ms = env::block_timestamp_ms();
        let margin = margin.0;
        let (price, size, fee) = self.opening_terms(
            &account_id, &market_id, side, margin, leverage, brackets.as_ref(), now_ms,
        )?;
        let market = self.market_mut(&market_id);

        market.accrue(now_ms);
        let entry_borrow_index = market.borrow_index_at(side, now_ms);
        let funding_side = side_index(side);
        let entry_funding_paid_index = market.funding.paid_index[funding_side].0;
        let entry_funding_received_index = market.funding.received_index[funding_side].0;
        let max_leverage = market.max_leverage;
        let vault_id = market.vault_id;
        *market.oi_mut(side) += size;
        market.track(side, size, price, entry_borrow_index, true);
        market.funding.track(side, size, entry_funding_paid_index, entry_funding_received_index, true);

        let account = self
            .accounts
            .get_mut(&account_id)
            .unwrap_or_else(|| env::panic_str("ERR_NO_ACCOUNT"));
        require!(account.margin >= margin, "ERR_INSUFFICIENT_MARGIN");
        account.margin -= margin;
        let id = self.next_position_id;
        self.next_position_id += 1;
        account.positions.push(id);
        self.record_opening_fee(vault_id, now_ms, fee);

        let position = Position {
            account_id: account_id.clone(),
            market_id: market_id.clone(),
            side,
            margin: margin - fee,
            size,
            entry_price: price,
            leverage,
            max_leverage,
            entry_borrow_index,
            entry_funding_paid_index,
            entry_funding_received_index,
            opened_at_ms: now_ms,
            take_profit: None,
            stop_loss: None,
        };
        emit_event(
            "position_opened",
            json!({
                "id": id,
                "account_id": account_id,
                "market_id": market_id,
                "side": side,
                "margin": U128(position.margin),
                "size": U128(size),
                "entry_price": U128(price),
                "fee": U128(fee),
            }),
        );
        self.record_entry(id, &position, margin, fee);
        self.positions.insert(id, position);
        self.attach_brackets(id, brackets);
        Ok(self.get_position(id).unwrap())
    }

    pub(crate) fn close_position_at(&mut self, position_id: PositionId, price: u128, now_ms: u64) -> U128 {
        let (position, marked, payout) = self.settle_position(position_id, price, now_ms);
        let account_id = position.account_id.clone();
        let account = self
            .accounts
            .get_mut(&account_id)
            .unwrap_or_else(|| env::panic_str("ERR_NO_ACCOUNT"));
        account.margin += payout;
        let event = HistoryEvent::position(HistoryKind::Close, position_id, &position, price, now_ms);
        let fees = fees_covered(&position, &marked, marked.borrow_fee + marked.close_fee);
        self.record_exit(event, &position, &marked, payout, fees);
        emit_event(
            "position_closed",
            json!({
                "id": position_id,
                "account_id": account_id,
                "market_id": position.market_id,
                "side": position.side,
                "size": U128(position.size),
                "exit_price": U128(price),
                "pnl": I128(marked.pnl),
                "borrow_fee": U128(marked.borrow_fee),
                "close_fee": U128(marked.close_fee),
                "funding_paid": U128(marked.funding_paid),
                "funding_received": U128(marked.funding_received),
                "funding_payment": I128(to_i128(marked.funding_paid) - to_i128(marked.funding_received)),
                "payout": U128(payout),
            }),
        );
        U128(payout)
    }
}

#[near]
impl Ketos {
    /// Opens at the fresh oracle price, optionally attaching full-position TP/SL exits.
    pub fn open_position(
        &mut self,
        market_id: MarketId,
        side: Side,
        margin: U128,
        leverage: u32,
        brackets: Option<Brackets>,
    ) -> PositionView {
        self.try_open_position_for(env::predecessor_account_id(), market_id, side, margin, leverage, brackets)
            .unwrap_or_else(|reason| env::panic_str(&reason))
    }

    /// Closes the caller's position at the oracle price; the result lands in free margin.
    pub fn close_position(&mut self, position_id: PositionId) -> U128 {
        let position = self.positions.get(&position_id)
            .unwrap_or_else(|| env::panic_str("ERR_NO_POSITION"));
        require!(position.account_id == env::predecessor_account_id(), "ERR_NOT_OWNER");
        let now_ms = env::block_timestamp_ms();
        let price = self.markets.get(&position.market_id).unwrap().fresh_price(now_ms);
        self.close_position_at(position_id, price, now_ms)
    }

    pub fn get_position(&self, position_id: PositionId) -> Option<PositionView> {
        self.positions
            .get(&position_id)
            .map(|p| self.position_view(position_id, p))
    }

    pub fn get_positions(&self, account_id: AccountId) -> Vec<PositionView> {
        let Some(account) = self.accounts.get(&account_id) else {
            return Vec::new();
        };
        account
            .positions
            .iter()
            .filter_map(|id| self.positions.get(id).map(|p| self.position_view(*id, p)))
            .collect()
    }

    /// All open positions, `limit` (≤ 100, default 50) at a time from `from_index`: lets a
    /// keeper find under-margined positions without knowing their owners.
    pub fn get_open_positions(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<PositionView> {
        let limit = limit.unwrap_or(50).min(100) as usize;
        self.positions
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit)
            .map(|(id, p)| self.position_view(*id, p))
            .collect()
    }
}
