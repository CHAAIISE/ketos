//! Exit-liquidity caps. The keeper publishes the price impact of selling each asset into USDC
//! on NEAR Intents (1Click dry quotes, fee excluded) at a grid of sizes; the contract derives
//! the market's open-interest cap and leverage tier from that curve.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require};

use crate::market::{MarketId, MarketView, USD};
use crate::{emit_event, Ketos, KetosExt};

/// Largest acceptable impact for a size to count as exit capacity.
pub const MAX_EXIT_IMPACT_BPS: u32 = 100;

/// Depth samples older than this close the market to new positions.
pub const MAX_DEPTH_AGE_MS: u64 = 30 * 60_000;

/// Samples kept per market, oldest dropped first.
pub const DEPTH_HISTORY_LEN: usize = 48;

pub const MAX_SAMPLES_PER_UPDATE: usize = 16;

/// Tolerated clock skew between the keeper's measurement time and the block time.
const MAX_FUTURE_SKEW_MS: u64 = 60_000;

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DepthSample {
    /// Order size in whole US dollars.
    pub size_usd: u64,
    /// Impact in bps net of the 1Click fee; `None` when 1Click has no liquidity at that size.
    pub impact_bps: Option<u32>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DepthRecord {
    pub measured_at_ms: u64,
    pub exit_capacity_usd: u64,
    pub max_leverage: u32,
    pub samples: Vec<DepthSample>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DepthView {
    pub market: MarketView,
    /// Oldest first, at most 48 entries.
    pub history: Vec<DepthRecord>,
}

/// Largest sampled size whose impact, and that of every smaller size, is within 100 bps.
/// `samples` must be sorted by size.
pub fn exit_capacity_usd(samples: &[DepthSample]) -> u64 {
    samples
        .iter()
        .take_while(|s| s.impact_bps.is_some_and(|bps| bps <= MAX_EXIT_IMPACT_BPS))
        .last()
        .map_or(0, |s| s.size_usd)
}

/// Leverage tier for an exit capacity in whole dollars.
pub fn max_leverage_for(capacity_usd: u64) -> u32 {
    match capacity_usd {
        c if c >= 1_000_000 => 20,
        c if c >= 250_000 => 10,
        c if c >= 50_000 => 5,
        _ => 2,
    }
}

#[near]
impl Ketos {
    /// Keeper only: records a depth curve for `market_id` and re-derives its caps. Existing
    /// positions keep their terms; the new cap and leverage apply to new positions.
    pub fn set_depth(&mut self, market_id: MarketId, samples: Vec<DepthSample>, measured_at_ms: u64) {
        require!(
            env::predecessor_account_id() == self.keeper_id,
            "ERR_NOT_KEEPER"
        );
        let now_ms = env::block_timestamp_ms();
        require!(
            !samples.is_empty() && samples.len() <= MAX_SAMPLES_PER_UPDATE,
            "ERR_INVALID_SAMPLES: 1 to 16 samples"
        );
        require!(
            samples.windows(2).all(|w| w[0].size_usd < w[1].size_usd),
            "ERR_INVALID_SAMPLES: sizes must be strictly increasing"
        );
        require!(
            measured_at_ms <= now_ms + MAX_FUTURE_SKEW_MS,
            "ERR_DEPTH_IN_FUTURE"
        );
        let measured_at_ms = measured_at_ms.min(now_ms);

        let market = self.market_mut(&market_id);
        require!(
            measured_at_ms > market.depth_measured_at_ms,
            "ERR_DEPTH_NOT_NEWER"
        );
        let capacity_usd = exit_capacity_usd(&samples);
        // Utilization changes with the cap: charge the elapsed period at the old one.
        market.accrue(now_ms);
        let max_leverage = max_leverage_for(capacity_usd).min(market.max_leverage_cap);
        market.exit_capacity = U128(capacity_usd as u128 * USD);
        market.depth_measured_at_ms = measured_at_ms;
        market.max_leverage = max_leverage;
        let max_oi = market.max_oi_per_side();

        let mut history = self.depth.get(&market_id).cloned().unwrap_or_default();
        if history.len() >= DEPTH_HISTORY_LEN {
            history.drain(..=history.len() - DEPTH_HISTORY_LEN);
        }
        history.push(DepthRecord {
            measured_at_ms,
            exit_capacity_usd: capacity_usd,
            max_leverage,
            samples,
        });
        self.depth.insert(market_id.clone(), history);

        emit_event(
            "depth_updated",
            json!({
                "market_id": market_id,
                "measured_at_ms": measured_at_ms,
                "exit_capacity_usd": capacity_usd,
                "max_leverage": max_leverage,
                "max_oi_per_side": U128(max_oi),
            }),
        );
    }

    pub fn get_depth(&self, market_id: MarketId) -> Option<DepthView> {
        let market = self.markets.get(&market_id)?;
        Some(DepthView {
            market: market.view(env::block_timestamp_ms()),
            history: self.depth.get(&market_id).cloned().unwrap_or_default(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(size_usd: u64, impact_bps: Option<u32>) -> DepthSample {
        DepthSample {
            size_usd,
            impact_bps,
        }
    }

    #[test]
    fn capacity_stops_at_first_sample_over_threshold_or_without_liquidity() {
        let curve = [
            s(1_000, Some(20)),
            s(10_000, Some(100)),
            s(50_000, Some(101)),
            s(100_000, Some(30)),
        ];
        assert_eq!(exit_capacity_usd(&curve), 10_000);
        assert_eq!(
            exit_capacity_usd(&[s(1_000, Some(5)), s(10_000, None), s(50_000, Some(5))]),
            1_000
        );
        assert_eq!(exit_capacity_usd(&[s(1_000, None)]), 0);
    }

    #[test]
    fn leverage_tiers() {
        assert_eq!(max_leverage_for(1_000_000), 20);
        assert_eq!(max_leverage_for(999_999), 10);
        assert_eq!(max_leverage_for(250_000), 10);
        assert_eq!(max_leverage_for(249_999), 5);
        assert_eq!(max_leverage_for(50_000), 5);
        assert_eq!(max_leverage_for(49_999), 2);
        assert_eq!(max_leverage_for(0), 2);
    }
}
