use near_sdk::json_types::U128;
use near_sdk::{env, near, require};

use crate::math::{borrow_index_delta, borrow_rate_per_hour};
use crate::position::Side;
use crate::{Perps, PerpsExt};

/// USDC has 6 decimals: one dollar is 1_000_000 units.
pub const USD: u128 = 1_000_000;

/// Static per-side ceiling, applied on top of the live exit-liquidity cap.
pub const DEFAULT_HARD_CAP: u128 = 500_000 * USD;

/// Leverage allowed before any depth sample: the lowest tier.
pub const DEFAULT_MAX_LEVERAGE: u32 = 2;

/// Prices older than this are refused for opening and closing positions.
pub const MAX_PRICE_AGE_MS: u64 = 120_000;

pub type MarketId = String;

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Market {
    /// Short ticker used as the market key (`BTC`, `ETH`, `NEAR`, `ZEC`).
    pub id: MarketId,
    /// Asset id on the price oracle (OutLayer `price-oracle.testnet`).
    pub oracle_asset_id: String,
    /// Maximum open interest per side in USDC units, before the exit-liquidity cap.
    pub hard_cap: U128,
    pub oi_long: U128,
    pub oi_short: U128,
    pub max_leverage: u32,
    /// Last oracle price, 8 decimals (USD per asset unit). Zero until the first update.
    pub price: U128,
    pub price_timestamp_ms: u64,
    /// Cumulative borrow fee per unit of notional (RATE_PRECISION scale), one per side.
    pub borrow_index_long: U128,
    pub borrow_index_short: U128,
    pub last_accrual_ms: u64,
}

impl Market {
    pub fn new(id: &str, oracle_asset_id: &str, hard_cap: u128) -> Self {
        Self {
            id: id.to_string(),
            oracle_asset_id: oracle_asset_id.to_string(),
            hard_cap: U128(hard_cap),
            oi_long: U128(0),
            oi_short: U128(0),
            max_leverage: DEFAULT_MAX_LEVERAGE,
            price: U128(0),
            price_timestamp_ms: 0,
            borrow_index_long: U128(0),
            borrow_index_short: U128(0),
            last_accrual_ms: env::block_timestamp_ms(),
        }
    }

    pub fn max_oi_per_side(&self) -> u128 {
        self.hard_cap.0
    }

    pub fn oi(&self, side: Side) -> u128 {
        match side {
            Side::Long => self.oi_long.0,
            Side::Short => self.oi_short.0,
        }
    }

    pub fn oi_mut(&mut self, side: Side) -> &mut u128 {
        match side {
            Side::Long => &mut self.oi_long.0,
            Side::Short => &mut self.oi_short.0,
        }
    }

    /// Borrow index of `side` as of `now_ms`, including growth not yet written to state.
    pub fn borrow_index_at(&self, side: Side, now_ms: u64) -> u128 {
        let stored = match side {
            Side::Long => self.borrow_index_long.0,
            Side::Short => self.borrow_index_short.0,
        };
        let elapsed = now_ms.saturating_sub(self.last_accrual_ms);
        let rate = borrow_rate_per_hour(self.oi(side), self.max_oi_per_side());
        stored + borrow_index_delta(rate, elapsed)
    }

    /// Writes accrued borrow growth to state. Must run before any open-interest change so the
    /// elapsed period is charged at the utilization that was actually in force.
    pub fn accrue(&mut self, now_ms: u64) {
        self.borrow_index_long = U128(self.borrow_index_at(Side::Long, now_ms));
        self.borrow_index_short = U128(self.borrow_index_at(Side::Short, now_ms));
        self.last_accrual_ms = now_ms;
    }

    /// Oracle price if it is set and at most `MAX_PRICE_AGE_MS` old.
    pub fn fresh_price(&self, now_ms: u64) -> u128 {
        require!(self.price.0 > 0, "ERR_NO_PRICE");
        require!(
            now_ms.saturating_sub(self.price_timestamp_ms) <= MAX_PRICE_AGE_MS,
            "ERR_STALE_PRICE"
        );
        self.price.0
    }
}

/// The four listed markets and the OutLayer asset ids that price them.
pub fn default_markets() -> Vec<Market> {
    [
        ("BTC", "nbtc.bridge.near"),
        ("ETH", "aurora"),
        ("NEAR", "wrap.near"),
        ("ZEC", "zec.omft.near"),
    ]
    .into_iter()
    .map(|(id, asset)| Market::new(id, asset, DEFAULT_HARD_CAP))
    .collect()
}

#[near]
impl Perps {
    pub fn get_markets(&self) -> Vec<Market> {
        self.markets.values().cloned().collect()
    }

    pub fn get_market(&self, market_id: MarketId) -> Option<Market> {
        self.markets.get(&market_id).cloned()
    }
}
