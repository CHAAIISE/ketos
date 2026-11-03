use near_sdk::json_types::U128;
use near_sdk::near;

use crate::{Perps, PerpsExt};

/// USDC has 6 decimals: one dollar is 1_000_000 units.
pub const USD: u128 = 1_000_000;

/// Static per-side ceiling, applied on top of the live exit-liquidity cap.
pub const DEFAULT_HARD_CAP: u128 = 500_000 * USD;

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
}

impl Market {
    pub fn new(id: &str, oracle_asset_id: &str, hard_cap: u128) -> Self {
        Self {
            id: id.to_string(),
            oracle_asset_id: oracle_asset_id.to_string(),
            hard_cap: U128(hard_cap),
            oi_long: U128(0),
            oi_short: U128(0),
        }
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
