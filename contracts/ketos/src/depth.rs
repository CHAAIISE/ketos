//! Exit-liquidity caps. The keeper publishes the price impact of selling each asset into USDC
//! on NEAR Intents (1Click dry quotes, fee excluded) at a grid of sizes; the contract derives
//! the market's open-interest cap and leverage tier from that curve.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require};

use crate::market::{MarketId, MarketView, USD};
use crate::math::BPS;
use crate::{emit_event, Ketos, KetosExt};

/// Largest acceptable impact for a size to count as exit capacity.
pub const MAX_EXIT_IMPACT_BPS: u32 = 100;

/// Depth samples older than this close the market to new positions.
pub const MAX_DEPTH_AGE_MS: u64 = 30 * 60_000;

/// Samples kept per market, oldest dropped first.
pub const DEPTH_HISTORY_LEN: usize = 48;

pub const MAX_SAMPLES_PER_UPDATE: usize = 16;
pub const LEVERAGE_RAISE_INTERVAL_MS: u64 = 3_600_000;

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

fn next_leverage_tier(current: u32) -> u32 {
    match current {
        0..=1 => 2,
        2..=4 => 5,
        5..=9 => 10,
        _ => 20,
    }
}

/// Ceil a fraction of the notional without overflowing even at the full u128 range.
/// Here the numerator is at most the denominator, and the denominator is bounded by
/// the largest whole-dollar sample span times USD times BPS (less than 2^98).
fn impact_fraction_fee(notional: u128, numerator: u128, denominator: u128) -> u128 {
    if let Some(product) = notional.checked_mul(numerator) {
        return product.div_ceil(denominator);
    }
    // Only extreme notionals need binary long division; ordinary trades use one multiply.
    let mut quotient = 0u128;
    let mut remainder = 0u128;
    for bit in (0..128).rev() {
        remainder = remainder * 2 + ((notional >> bit) & 1) * numerator;
        quotient = quotient * 2 + remainder / denominator;
        remainder %= denominator;
    }
    quotient + u128::from(remainder != 0)
}

/// Price the actual microUSDC notional, not total market OI. Missing quotes terminate
/// the supported curve; no interpolation crosses a hole. Older, nonmonotone curves
/// are read through a nondecreasing envelope without allocating or mutating storage.
fn curve_impact_fee(samples: &[DepthSample], notional: u128) -> u128 {
    let mut previous_size = 0;
    let mut previous_bps = 0;
    let mut has_previous = false;
    for sample in samples.iter().take(MAX_SAMPLES_PER_UPDATE) {
        let Some(impact) = sample.impact_bps else {
            break;
        };
        let size = u128::from(sample.size_usd) * USD;
        let bps = u128::from(impact).max(previous_bps);
        if notional <= size {
            if !has_previous {
                return impact_fraction_fee(notional, bps.min(BPS), BPS);
            }
            let span = size - previous_size;
            let numerator = previous_bps * span
                + (bps - previous_bps) * (notional - previous_size);
            let denominator = span * BPS;
            return impact_fraction_fee(notional, numerator.min(denominator), denominator);
        }
        previous_size = size;
        previous_bps = bps;
        has_previous = true;
    }
    let fallback = previous_bps.max(u128::from(MAX_EXIT_IMPACT_BPS)).min(BPS);
    impact_fraction_fee(notional, fallback, BPS)
}

impl Ketos {
    /// Latest depth prices execution even when stale; missing depth never blocks an exit.
    pub(crate) fn impact_fee(&self, market_id: &MarketId, notional: u128) -> u128 {
        let samples = self
            .depth
            .get(market_id)
            .and_then(|history| history.last())
            .map_or(&[][..], |record| record.samples.as_slice());
        curve_impact_fee(samples, notional)
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
        let mut previous_impact = 0;
        for impact in samples.iter().filter_map(|sample| sample.impact_bps) {
            require!(
                impact >= previous_impact,
                "ERR_INVALID_SAMPLES: impact must be nondecreasing"
            );
            previous_impact = impact;
        }
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
        let measured_capacity_usd = exit_capacity_usd(&samples);
        // A zero-cap market restarts at the opening threshold, never at a deep reported cap.
        let growth_limit = if market.exit_capacity.0 == 0 {
            crate::market::MIN_OPEN_CAPACITY
        } else {
            market.exit_capacity.0.saturating_mul(2)
        };
        let capacity = (u128::from(measured_capacity_usd) * USD).min(growth_limit);
        let capacity_usd = (capacity / USD) as u64;
        // Utilization changes with the cap: charge the elapsed period at the old one.
        market.accrue(now_ms);
        let desired_leverage = max_leverage_for(capacity_usd).min(market.max_leverage_cap);
        let max_leverage = if desired_leverage > market.max_leverage {
            if market.leverage_increased_at_ms == 0
                || now_ms.saturating_sub(market.leverage_increased_at_ms) >= LEVERAGE_RAISE_INTERVAL_MS {
                market.leverage_increased_at_ms = now_ms;
                desired_leverage.min(next_leverage_tier(market.max_leverage))
            } else {
                market.max_leverage
            }
        } else {
            desired_leverage
        };
        market.exit_capacity = U128(capacity);
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
                "measured_exit_capacity_usd": measured_capacity_usd,
                "max_leverage": max_leverage,
                "max_oi_per_side": U128(max_oi),
            }),
        );
    }

    pub fn get_depth(&self, market_id: MarketId) -> Option<DepthView> {
        let market = self.get_market(market_id.clone())?;
        Some(DepthView {
            market,
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

    #[test]
    fn impact_is_flat_below_first_point_and_linear_between_points() {
        let curve = [s(100, Some(20)), s(200, Some(60))];
        assert_eq!(curve_impact_fee(&curve, 0), 0);
        assert_eq!(curve_impact_fee(&curve, 50 * USD), 100_000);
        assert_eq!(curve_impact_fee(&curve, 100 * USD), 200_000);
        assert_eq!(curve_impact_fee(&curve, 125 * USD), 375_000);
        assert_eq!(curve_impact_fee(&curve, 150 * USD), 600_000);
        assert_eq!(curve_impact_fee(&curve, 200 * USD), 1_200_000);
    }

    #[test]
    fn impact_interpolates_fractional_micro_sizes_and_rounds_only_the_fee_up() {
        let curve = [s(1, Some(10)), s(2, Some(11))];
        assert_eq!(curve_impact_fee(&curve, 1), 1);
        assert_eq!(curve_impact_fee(&curve, USD + 1), 1_001);
        assert_eq!(curve_impact_fee(&curve, USD + USD / 2), 1_575);
        assert_eq!(curve_impact_fee(&curve, USD + USD / 2 + 1), 1_576);
        assert_eq!(curve_impact_fee(&[s(1, Some(0))], 1), 0);
    }

    #[test]
    fn missing_curves_and_holes_use_conservative_fallback_without_crossing_holes() {
        assert_eq!(curve_impact_fee(&[], 100 * USD), USD);
        assert_eq!(curve_impact_fee(&[s(100, None)], 50 * USD), 500_000);
        let hole = [s(100, Some(20)), s(200, None), s(300, Some(500))];
        assert_eq!(curve_impact_fee(&hole, 100 * USD), 200_000);
        assert_eq!(curve_impact_fee(&hole, 150 * USD), 1_500_000);
        assert_eq!(curve_impact_fee(&hole, 300 * USD), 3 * USD);
        assert_eq!(curve_impact_fee(&hole, 400 * USD), 4 * USD);
        let high = [s(100, Some(250)), s(200, None)];
        assert_eq!(curve_impact_fee(&high, 150 * USD), 3_750_000);
    }

    #[test]
    fn beyond_grid_fallback_never_caps_known_impacts_at_one_percent() {
        assert_eq!(curve_impact_fee(&[s(100, Some(20))], 200 * USD), 2 * USD);
        assert_eq!(curve_impact_fee(&[s(100, Some(250))], 200 * USD), 5 * USD);
        assert_eq!(
            curve_impact_fee(&[s(100, Some(u32::MAX))], 200 * USD),
            200 * USD
        );
        let extreme = [s(100, Some(0)), s(200, Some(20_000))];
        assert_eq!(curve_impact_fee(&extreme, 125 * USD), 62_500_000);
        assert_eq!(curve_impact_fee(&extreme, 150 * USD), 150 * USD);
    }

    #[test]
    fn nonmonotone_curves_use_a_nondecreasing_envelope() {
        let curve = [s(100, Some(200)), s(200, Some(10)), s(300, Some(400))];
        assert_eq!(curve_impact_fee(&curve, 150 * USD), 3 * USD);
        assert_eq!(curve_impact_fee(&curve, 200 * USD), 4 * USD);
        assert_eq!(curve_impact_fee(&curve, 250 * USD), 7_500_000);
        assert_eq!(curve_impact_fee(&curve, 400 * USD), 16 * USD);
    }

    #[test]
    fn extreme_sizes_keep_exact_rounding_without_overflow() {
        assert_eq!(curve_impact_fee(&[], u128::MAX), u128::MAX.div_ceil(100));
        assert_eq!(
            curve_impact_fee(&[s(1, Some(u32::MAX))], u128::MAX),
            u128::MAX
        );
        let size = u128::from(u64::MAX) * USD;
        let curve = [s(0, Some(0)), s(u64::MAX, Some(10_000))];
        assert_eq!(curve_impact_fee(&curve, size / 2), size / 4);
        assert_eq!(curve_impact_fee(&curve, size), size);
    }

    #[test]
    fn impact_uses_latest_record_even_when_stale_and_defaults_without_history() {
        use near_sdk::test_utils::VMContextBuilder;
        use near_sdk::testing_env;

        testing_env!(VMContextBuilder::new()
            .block_timestamp((MAX_DEPTH_AGE_MS + 2) * 1_000_000)
            .build());
        let mut contract = Ketos::new(
            "usdc.test".parse().unwrap(),
            "oracle.test".parse().unwrap(),
            "keeper.test".parse().unwrap(),
            "outlayer.test".parse().unwrap(),
            None,
        );
        let market_id = "NEAR".to_string();
        assert_eq!(contract.impact_fee(&market_id, 100 * USD), USD);
        contract.depth.insert(
            market_id.clone(),
            vec![
                DepthRecord {
                    measured_at_ms: 0,
                    exit_capacity_usd: 100,
                    max_leverage: 2,
                    samples: vec![s(100, Some(50))],
                },
                DepthRecord {
                    measured_at_ms: 1,
                    exit_capacity_usd: 100,
                    max_leverage: 2,
                    samples: vec![s(100, Some(25))],
                },
            ],
        );
        assert_eq!(contract.impact_fee(&market_id, 100 * USD), 250_000);
        contract.depth.insert(market_id.clone(), vec![]);
        assert_eq!(contract.impact_fee(&market_id, 100 * USD), USD);
    }
}
