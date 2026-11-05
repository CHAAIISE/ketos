use near_sdk::json_types::{I128, U128};
use near_sdk::{near, AccountId};

use crate::market::MarketId;
use crate::math::{mul_div_floor, to_i128};
use crate::orders::OrderId;
use crate::position::{realized_funding, Marked, Position, PositionId, Side};
use crate::{Ketos, KetosExt};

pub const ACCOUNT_HISTORY_LEN: u64 = 200;
pub const MAX_LEADERBOARD_ACCOUNTS: u32 = 500;

#[near(serializers = [json, borsh])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HistoryKind {
    Open,
    Close,
    Liquidation,
    OrderFill,
    Funding,
    Deposit,
    Withdrawal,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryEvent {
    pub sequence: u64,
    pub kind: HistoryKind,
    pub position_id: PositionId,
    pub order_id: Option<OrderId>,
    pub market_id: MarketId,
    pub side: Side,
    pub price: U128,
    pub size: U128,
    /// Oracle price PnL before costs; may exceed the collateral or vault payout.
    pub pnl: I128,
    /// Trading settlement delta, excluding collateral transfers and executor reward income.
    pub realized_pnl: I128,
    /// Collected trading/borrow fees, penalties and order/liquidation executor rewards.
    pub fees: U128,
    pub funding_paid: U128,
    pub funding_received: U128,
    /// Net funding booked at settlement (negative = credit); payout caps affect realized_pnl.
    pub funding_payment: I128,
    pub timestamp_ms: u64,
}

impl HistoryEvent {
    pub(crate) fn transfer(kind: HistoryKind, amount: u128, timestamp_ms: u64) -> Self {
        Self {
            sequence: 0,
            kind,
            position_id: 0,
            order_id: None,
            market_id: "USDC".into(),
            side: Side::Long,
            price: U128(0),
            size: U128(amount),
            pnl: I128(0),
            realized_pnl: I128(0),
            fees: U128(0),
            funding_paid: U128(0),
            funding_received: U128(0),
            funding_payment: I128(0),
            timestamp_ms,
        }
    }

    pub(crate) fn position(
        kind: HistoryKind,
        position_id: PositionId,
        position: &Position,
        price: u128,
        timestamp_ms: u64,
    ) -> Self {
        Self {
            sequence: 0,
            kind,
            position_id,
            order_id: None,
            market_id: position.market_id.clone(),
            side: position.side,
            price: U128(price),
            size: U128(position.size),
            pnl: I128(0),
            realized_pnl: I128(0),
            fees: U128(0),
            funding_paid: U128(0),
            funding_received: U128(0),
            funding_payment: I128(0),
            timestamp_ms,
        }
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AccountStats {
    pub realized_pnl: I128,
    /// Entry and exit notional; annotations, funding and transfers never add volume.
    pub volume: U128,
    /// Executed entries and exits, including liquidations.
    pub trades: u64,
    /// Sum of collateral committed at entry, used as the all-time ROI denominator.
    pub committed_margin: U128,
    pub event_count: u64,
    #[serde(skip)]
    pub(crate) last_activity: Option<u64>,
}

#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy)]
pub enum LeaderboardSort {
    Pnl,
    Volume,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq, Eq)]
pub struct LeaderboardEntry {
    pub account_id: AccountId,
    pub realized_pnl: I128,
    pub volume: U128,
    pub trades: u64,
    pub committed_margin: U128,
    pub roi_bps: I128,
}

impl Ketos {
    pub(crate) fn record_history(&mut self, account_id: &AccountId, mut event: HistoryEvent) {
        let stats = self.account_stats.entry(account_id.clone()).or_default();
        event.sequence = stats.event_count;
        stats.event_count += 1;
        self.account_history.insert(
            (
                account_id.clone(),
                (event.sequence % ACCOUNT_HISTORY_LEN) as u16,
            ),
            event,
        );
    }

    fn record_trade(&mut self, account_id: &AccountId, event: &HistoryEvent, collateral: u128) {
        let stats = self.account_stats.entry(account_id.clone()).or_default();
        if let Some(last) = stats.last_activity {
            self.active_traders.remove(&(last, account_id.clone()));
            self.pnl_ranking
                .remove(&(stats.realized_pnl.0, account_id.clone()));
            self.volume_ranking
                .remove(&(stats.volume.0, account_id.clone()));
        }
        stats.realized_pnl.0 += event.realized_pnl.0;
        if event.kind != HistoryKind::OrderFill {
            stats.volume.0 += event.size.0;
            stats.trades += 1;
            stats.committed_margin.0 += collateral;
        }
        let activity = self.trader_activity_count;
        self.trader_activity_count += 1;
        stats.last_activity = Some(activity);
        self.active_traders
            .insert((activity, account_id.clone()), ());
        self.pnl_ranking
            .insert((stats.realized_pnl.0, account_id.clone()), ());
        self.volume_ranking
            .insert((stats.volume.0, account_id.clone()), ());
        if self.active_traders.len() > MAX_LEADERBOARD_ACCOUNTS {
            let (oldest, _) = self.active_traders.iter().next().unwrap();
            let oldest = oldest.clone();
            let stats = self.account_stats.get(&oldest.1).unwrap();
            self.pnl_ranking
                .remove(&(stats.realized_pnl.0, oldest.1.clone()));
            self.volume_ranking
                .remove(&(stats.volume.0, oldest.1.clone()));
            self.active_traders.remove(&oldest);
        }
    }

    pub(crate) fn record_order_fill(&mut self, account_id: &AccountId, event: HistoryEvent) {
        self.record_trade(account_id, &event, 0);
        self.record_history(account_id, event);
    }

    pub(crate) fn record_entry(
        &mut self,
        position_id: PositionId,
        position: &Position,
        collateral: u128,
        fee: u128,
    ) {
        let mut event = HistoryEvent::position(
            HistoryKind::Open,
            position_id,
            position,
            position.entry_price,
            position.opened_at_ms,
        );
        event.fees = U128(fee);
        event.realized_pnl = I128(-to_i128(fee));
        self.record_trade(&position.account_id, &event, collateral);
        self.record_history(&position.account_id, event);
    }

    pub(crate) fn record_exit(
        &mut self,
        event: HistoryEvent,
        position: &Position,
        marked: &Marked,
        payout: u128,
        fees: u128,
    ) {
        self.record_signed_exit(event, position, marked, to_i128(payout), fees);
    }

    pub(crate) fn record_signed_exit(
        &mut self,
        mut event: HistoryEvent,
        position: &Position,
        marked: &Marked,
        payout: i128,
        fees: u128,
    ) {
        let net_funding = if position.margin_mode == crate::cross::MarginMode::Cross {
            to_i128(marked.funding_paid) - to_i128(marked.funding_received)
        } else {
            realized_funding(position, marked)
        };
        if marked.funding_paid > 0 || marked.funding_received > 0 {
            let mut funding = HistoryEvent::position(
                HistoryKind::Funding,
                event.position_id,
                position,
                event.price.0,
                event.timestamp_ms,
            );
            funding.funding_paid = U128(marked.funding_paid);
            funding.funding_received = U128(marked.funding_received);
            funding.funding_payment = I128(net_funding);
            self.record_history(&position.account_id, funding);
        }
        event.pnl = I128(marked.pnl);
        event.realized_pnl = I128(payout - to_i128(position.margin));
        event.fees = U128(fees);
        event.funding_paid = U128(marked.funding_paid);
        event.funding_received = U128(marked.funding_received);
        event.funding_payment = I128(net_funding);
        self.record_trade(&position.account_id, &event, 0);
        self.record_history(&position.account_id, event);
    }

    fn leaderboard_entry(&self, account_id: &AccountId) -> LeaderboardEntry {
        let stats = self.account_stats.get(account_id).unwrap();
        let magnitude = if stats.committed_margin.0 == 0 {
            0
        } else {
            to_i128(mul_div_floor(
                stats.realized_pnl.0.unsigned_abs(),
                10_000,
                stats.committed_margin.0,
            ))
        };
        LeaderboardEntry {
            account_id: account_id.clone(),
            realized_pnl: stats.realized_pnl,
            volume: stats.volume,
            trades: stats.trades,
            committed_margin: stats.committed_margin,
            roi_bps: I128(if stats.realized_pnl.0 < 0 {
                -magnitude
            } else {
                magnitude
            }),
        }
    }
}

#[near]
impl Ketos {
    /// Chronological, absolute sequence cursor. A cursor older than retention starts at the oldest kept event.
    pub fn get_history(
        &self,
        account_id: AccountId,
        from: Option<u64>,
        limit: Option<u32>,
    ) -> Vec<HistoryEvent> {
        let Some(stats) = self.account_stats.get(&account_id) else {
            return Vec::new();
        };
        let start = from
            .unwrap_or(0)
            .max(stats.event_count.saturating_sub(ACCOUNT_HISTORY_LEN));
        let end = start
            .saturating_add(u64::from(
                limit.unwrap_or(50).min(ACCOUNT_HISTORY_LEN as u32),
            ))
            .min(stats.event_count);
        (start..end)
            .map(|sequence| {
                self.account_history
                    .get(&(account_id.clone(), (sequence % ACCOUNT_HISTORY_LEN) as u16))
                    .unwrap()
                    .clone()
            })
            .collect()
    }

    pub fn get_account_stats(&self, account_id: AccountId) -> Option<AccountStats> {
        self.account_stats.get(&account_id).cloned()
    }

    /// Descending score, then descending account id, among the 500 most recently active traders.
    pub fn get_leaderboard(
        &self,
        sort: Option<LeaderboardSort>,
        limit: Option<u32>,
    ) -> Vec<LeaderboardEntry> {
        let limit = limit.unwrap_or(50).min(MAX_LEADERBOARD_ACCOUNTS) as usize;
        match sort.unwrap_or(LeaderboardSort::Pnl) {
            LeaderboardSort::Pnl => self
                .pnl_ranking
                .iter()
                .rev()
                .take(limit)
                .map(|((_, account), _)| self.leaderboard_entry(account))
                .collect(),
            LeaderboardSort::Volume => self
                .volume_ranking
                .iter()
                .rev()
                .take(limit)
                .map(|((_, account), _)| self.leaderboard_entry(account))
                .collect(),
        }
    }
}
