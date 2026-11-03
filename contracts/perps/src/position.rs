use near_sdk::json_types::{I128, U128};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId};

use crate::market::{Market, MarketId, USD};
use crate::math::{borrow_fee, liquidation_price, maintenance_margin, pnl, to_i128, trade_fee};
use crate::{emit_event, Perps, PerpsExt};

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
    pub opened_at_ms: u64,
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
    /// margin + unrealized PnL − borrow fee.
    pub equity: I128,
    pub maintenance_margin: U128,
    pub liquidation_price: U128,
}

/// Result of marking a position to a price at a given time.
pub(crate) struct Marked {
    pub pnl: i128,
    pub borrow_fee: u128,
    pub close_fee: u128,
    pub equity: i128,
    pub maintenance: u128,
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
        Marked {
            pnl,
            borrow_fee,
            close_fee: trade_fee(self.size),
            equity: to_i128(self.margin) + pnl - to_i128(borrow_fee),
            maintenance: maintenance_margin(self.size, self.max_leverage),
        }
    }

    fn view(&self, id: PositionId, market: &Market, now_ms: u64) -> PositionView {
        let price = market.price.0;
        let marked = self.mark(market, price, now_ms);
        let buffer =
            to_i128(self.margin) - to_i128(marked.borrow_fee) - to_i128(marked.maintenance);
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
            equity: I128(marked.equity),
            maintenance_margin: U128(marked.maintenance),
            liquidation_price: U128(liquidation_price(
                self.is_long(),
                self.size,
                self.entry_price,
                buffer,
            )),
        }
    }
}

impl Perps {
    pub(crate) fn market_mut(&mut self, market_id: &MarketId) -> &mut Market {
        self.markets
            .get_mut(market_id)
            .unwrap_or_else(|| env::panic_str("ERR_UNKNOWN_MARKET"))
    }

    /// Removes a position from the books and returns what is owed to the trader: margin plus
    /// PnL minus borrow and closing fees, floored at zero. The vault takes the other side:
    /// it keeps losses and fees, and pays gains up to its balance.
    pub(crate) fn settle_position(
        &mut self,
        id: PositionId,
        price: u128,
        now_ms: u64,
    ) -> (Position, Marked, u128) {
        let position = self
            .positions
            .remove(&id)
            .unwrap_or_else(|| env::panic_str("ERR_NO_POSITION"));
        let market = self.market_mut(&position.market_id);
        market.accrue(now_ms);
        let marked = position.mark(market, price, now_ms);
        let oi = market.oi_mut(position.side);
        *oi = oi.saturating_sub(position.size);

        let owed = marked.equity - to_i128(marked.close_fee);
        let mut payout = u128::try_from(owed.max(0)).unwrap_or(0);
        let available = self.vault_usdc + position.margin;
        if payout > available {
            payout = available;
        }
        self.vault_usdc = available - payout;

        let account = self
            .accounts
            .get_mut(&position.account_id)
            .unwrap_or_else(|| env::panic_str("ERR_NO_ACCOUNT"));
        account.positions.retain(|p| *p != id);
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

#[near]
impl Perps {
    /// Opens an isolated-margin position: `margin` USDC is taken from the caller's free margin,
    /// notional = margin × leverage at the oracle price. The 0.1% opening fee is paid out of
    /// the position's collateral to the vault.
    pub fn open_position(
        &mut self,
        market_id: MarketId,
        side: Side,
        margin: U128,
        leverage: u32,
    ) -> PositionView {
        let account_id = env::predecessor_account_id();
        let now_ms = env::block_timestamp_ms();
        let margin = margin.0;
        require!(
            margin >= MIN_POSITION_MARGIN,
            "ERR_MIN_POSITION_MARGIN: 1 USDC"
        );

        let market = self.market_mut(&market_id);
        if let Some(reason) = market.closed_reason(now_ms) {
            env::panic_str(reason);
        }
        require!(leverage >= 1, "ERR_LEVERAGE_TOO_LOW");
        if leverage > market.max_leverage {
            env::panic_str(&format!(
                "ERR_LEVERAGE_TOO_HIGH: max {}",
                market.max_leverage
            ));
        }
        let price = market.fresh_price(now_ms);
        let size = margin * leverage as u128;
        let fee = trade_fee(size);
        // `cap` is the notional (USDC units) still available on this side.
        let room = market.max_oi_per_side().saturating_sub(market.oi(side));
        if size > room {
            env::panic_str(&format!("ERR_EXCEEDS_EXIT_LIQUIDITY: cap {room}"));
        }

        market.accrue(now_ms);
        let entry_borrow_index = market.borrow_index_at(side, now_ms);
        let max_leverage = market.max_leverage;
        *market.oi_mut(side) += size;

        let account = self
            .accounts
            .get_mut(&account_id)
            .unwrap_or_else(|| env::panic_str("ERR_NO_ACCOUNT"));
        require!(account.margin >= margin, "ERR_INSUFFICIENT_MARGIN");
        account.margin -= margin;
        let id = self.next_position_id;
        self.next_position_id += 1;
        account.positions.push(id);
        self.vault_usdc += fee;

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
            opened_at_ms: now_ms,
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
        let view = self.position_view(id, &position);
        self.positions.insert(id, position);
        view
    }

    /// Closes the caller's position at the oracle price; the result lands in free margin.
    pub fn close_position(&mut self, position_id: PositionId) -> U128 {
        let account_id = env::predecessor_account_id();
        let now_ms = env::block_timestamp_ms();
        let position = self
            .positions
            .get(&position_id)
            .unwrap_or_else(|| env::panic_str("ERR_NO_POSITION"));
        require!(position.account_id == account_id, "ERR_NOT_OWNER");
        let market_id = position.market_id.clone();
        let price = self.market_mut(&market_id).fresh_price(now_ms);

        let (position, marked, payout) = self.settle_position(position_id, price, now_ms);
        let account = self
            .accounts
            .get_mut(&account_id)
            .unwrap_or_else(|| env::panic_str("ERR_NO_ACCOUNT"));
        account.margin += payout;
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
                "payout": U128(payout),
            }),
        );
        U128(payout)
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
}
