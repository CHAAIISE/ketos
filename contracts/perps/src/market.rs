use near_sdk::json_types::U128;
use near_sdk::{env, near, require};

use crate::depth::MAX_DEPTH_AGE_MS;
use crate::math::{
    borrow_index_delta, borrow_rate_per_hour, mul_div_ceil, mul_div_floor, to_i128,
    RATE_PRECISION,
};
use crate::position::Side;
use crate::{Perps, PerpsExt};

/// USDC has 6 decimals: one dollar is 1_000_000 units.
pub const USD: u128 = 1_000_000;

/// Static per-side ceiling, applied on top of the live exit-liquidity cap.
pub const DEFAULT_HARD_CAP: u128 = 500_000 * USD;

/// Leverage allowed before any depth sample: the lowest tier.
pub const DEFAULT_MAX_LEVERAGE: u32 = 2;

/// Below this exit capacity a market takes no new positions.
pub const MIN_OPEN_CAPACITY: u128 = 10_000 * USD;

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
    /// Largest size (USDC units) that exits to USDC on NEAR Intents within 100 bps of impact.
    pub exit_capacity: U128,
    /// When the depth behind `exit_capacity` was measured; zero before the first sample.
    pub depth_measured_at_ms: u64,
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
    /// Per-side sums over open positions, so the vault can mark all of them in O(markets):
    /// Σ size × ENTRY_UNIT_SCALE / entry_price, and Σ size × entry borrow index.
    #[serde(skip)]
    pub entry_units: [u128; 2],
    #[serde(skip)]
    pub borrow_weight: [u128; 2],
}

/// Scale of `entry_units`: keeps precision for 8-decimal prices of any magnitude.
pub const ENTRY_UNIT_SCALE: u128 = 1_000_000_000_000_000_000;

fn side_index(side: Side) -> usize {
    match side {
        Side::Long => 0,
        Side::Short => 1,
    }
}

/// Market with the limits derived from its latest depth sample at the current block time.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarketView {
    #[serde(flatten)]
    pub market: Market,
    pub max_oi_per_side: U128,
    /// False when exit capacity is under $10k or the depth sample is older than 30 minutes.
    pub is_open: bool,
}

impl Market {
    pub fn new(id: &str, oracle_asset_id: &str, hard_cap: u128) -> Self {
        Self {
            id: id.to_string(),
            oracle_asset_id: oracle_asset_id.to_string(),
            hard_cap: U128(hard_cap),
            exit_capacity: U128(0),
            depth_measured_at_ms: 0,
            oi_long: U128(0),
            oi_short: U128(0),
            max_leverage: DEFAULT_MAX_LEVERAGE,
            price: U128(0),
            price_timestamp_ms: 0,
            borrow_index_long: U128(0),
            borrow_index_short: U128(0),
            last_accrual_ms: env::block_timestamp_ms(),
            entry_units: [0; 2],
            borrow_weight: [0; 2],
        }
    }

    /// Adds (`open = true`) or removes a position from the per-side exposure sums.
    pub fn track(&mut self, side: Side, size: u128, entry: u128, entry_index: u128, open: bool) {
        let i = side_index(side);
        let units = mul_div_floor(size, ENTRY_UNIT_SCALE, entry);
        let weight = size * entry_index;
        if open {
            self.entry_units[i] += units;
            self.borrow_weight[i] += weight;
        } else {
            self.entry_units[i] = self.entry_units[i].saturating_sub(units);
            self.borrow_weight[i] = self.borrow_weight[i].saturating_sub(weight);
        }
    }

    /// Net unrealized PnL of all traders at the last oracle price (positive = traders win).
    pub fn traders_pnl(&self) -> i128 {
        let mark = self.price.0;
        let long_value = mul_div_floor(self.entry_units[0], mark, ENTRY_UNIT_SCALE);
        let short_value = mul_div_ceil(self.entry_units[1], mark, ENTRY_UNIT_SCALE);
        to_i128(long_value) - to_i128(self.oi_long.0) + to_i128(self.oi_short.0)
            - to_i128(short_value)
    }

    /// Borrow fees accrued by open positions and not yet paid, as of `now_ms`.
    pub fn borrow_fees_due(&self, now_ms: u64) -> u128 {
        [Side::Long, Side::Short]
            .into_iter()
            .map(|side| {
                let accrued = self.borrow_index_at(side, now_ms) * self.oi(side);
                accrued.saturating_sub(self.borrow_weight[side_index(side)]) / RATE_PRECISION
            })
            .sum()
    }

    pub fn max_oi_per_side(&self) -> u128 {
        self.hard_cap.0.min(self.exit_capacity.0)
    }

    /// Why the market refuses new positions at `now_ms`, if it does.
    pub fn closed_reason(&self, now_ms: u64) -> Option<&'static str> {
        if self.depth_measured_at_ms == 0
            || now_ms.saturating_sub(self.depth_measured_at_ms) > MAX_DEPTH_AGE_MS
        {
            Some("ERR_MARKET_CLOSED: depth sample older than 30 minutes")
        } else if self.exit_capacity.0 < MIN_OPEN_CAPACITY {
            Some("ERR_MARKET_CLOSED: exit liquidity below $10,000")
        } else {
            None
        }
    }

    pub fn view(&self, now_ms: u64) -> MarketView {
        MarketView {
            market: self.clone(),
            max_oi_per_side: U128(self.max_oi_per_side()),
            is_open: self.closed_reason(now_ms).is_none(),
        }
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

    /// Writes accrued borrow growth to state. Must run before any change of open interest or
    /// cap so the elapsed period is charged at the utilization that was actually in force.
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
    pub fn get_markets(&self) -> Vec<MarketView> {
        let now_ms = env::block_timestamp_ms();
        self.markets.values().map(|m| m.view(now_ms)).collect()
    }

    pub fn get_market(&self, market_id: MarketId) -> Option<MarketView> {
        self.markets
            .get(&market_id)
            .map(|m| m.view(env::block_timestamp_ms()))
    }
}
