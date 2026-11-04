//! Funding uses the same notional rate on both sides. The majority pays, the minority
//! receives, and the unmatched amount belongs to the vault. Transfers realize at exit.

use near_sdk::json_types::{I128, U128};
use near_sdk::serde_json::json;
use near_sdk::{env, near};

use crate::market::{Market, MarketId};
use crate::math::{mul_div_ceil, mul_div_floor, to_i128, MS_PER_HOUR, RATE_PRECISION};
use crate::position::Side;
use crate::{emit_event, Perps, PerpsExt};

/// 0.05% of notional per hour, at the maximum OI imbalance (RATE_PRECISION scale).
pub const MAX_FUNDING_PER_HOUR: u128 = 500_000_000;

pub fn funding_rate(long: u128, short: u128) -> i128 {
    let magnitude = mul_div_floor(
        MAX_FUNDING_PER_HOUR,
        long.abs_diff(short),
        (long + short).max(1),
    );
    if long >= short { to_i128(magnitude) } else { -to_i128(magnitude) }
}

pub(crate) fn side_index(side: Side) -> usize {
    match side {
        Side::Long => 0,
        Side::Short => 1,
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Funding {
    /// Cumulative rates per side (long, short), in RATE_PRECISION units.
    pub paid_index: [U128; 2],
    pub received_index: [U128; 2],
    pub last_accrual_ms: u64,
    /// Carry sub-index fractions across checkpoints, separately for each paying side.
    #[serde(skip)]
    remainder: [u128; 2],
    /// Sum of notional × entry index, for O(markets) vault valuation.
    #[serde(skip)]
    paid_weight: [u128; 2],
    #[serde(skip)]
    received_weight: [u128; 2],
}

impl Funding {
    pub(crate) fn new(now_ms: u64) -> Self {
        Self { last_accrual_ms: now_ms, ..Self::default() }
    }

    pub(crate) fn at(&self, rate: i128, now_ms: u64) -> Self {
        let mut next = *self;
        let elapsed_ms = now_ms.saturating_sub(self.last_accrual_ms);
        next.last_accrual_ms = now_ms;
        if rate != 0 {
            let payer = usize::from(rate < 0);
            let numerator = mul_div_floor(rate.unsigned_abs(), elapsed_ms as u128, 1)
                + self.remainder[payer];
            let delta = numerator / MS_PER_HOUR;
            next.remainder[payer] = numerator % MS_PER_HOUR;
            next.paid_index[payer].0 += delta;
            next.received_index[1 - payer].0 += delta;
        }
        next
    }

    pub(crate) fn track(
        &mut self,
        side: Side,
        size: u128,
        paid_entry: u128,
        received_entry: u128,
        open: bool,
    ) {
        let i = side_index(side);
        let paid = mul_div_floor(size, paid_entry, 1);
        let received = mul_div_floor(size, received_entry, 1);
        if open {
            self.paid_weight[i] += paid;
            self.received_weight[i] += received;
        } else {
            self.paid_weight[i] -= paid;
            self.received_weight[i] -= received;
        }
    }

    pub(crate) fn amounts(
        &self,
        side: Side,
        size: u128,
        paid_entry: u128,
        received_entry: u128,
    ) -> (u128, u128) {
        let i = side_index(side);
        (
            mul_div_ceil(size, self.paid_index[i].0 - paid_entry, RATE_PRECISION),
            mul_div_floor(size, self.received_index[i].0 - received_entry, RATE_PRECISION),
        )
    }

    /// Conservative aggregate: receivables floor, liabilities ceil. Per-position debits
    /// round up and credits round down, so this does not overstate net funding assets.
    pub(crate) fn net_due(&self, oi: [u128; 2]) -> i128 {
        let paid: u128 = (0..2)
            .map(|i| (mul_div_floor(oi[i], self.paid_index[i].0, 1) - self.paid_weight[i])
                / RATE_PRECISION)
            .sum();
        to_i128(paid) - to_i128(self.received_due(oi))
    }

    pub(crate) fn received_due(&self, oi: [u128; 2]) -> u128 {
        (0..2)
            .map(|i| (mul_div_floor(oi[i], self.received_index[i].0, 1)
                - self.received_weight[i]).div_ceil(RATE_PRECISION))
            .sum()
    }
}

impl Market {
    pub(crate) fn funding_at(&self, now_ms: u64) -> Funding {
        self.funding.at(
            funding_rate(self.oi_long.0, self.oi_short.0),
            now_ms,
        )
    }

    pub(crate) fn funding_net_due(&self, now_ms: u64) -> i128 {
        self.funding_at(now_ms).net_due([self.oi_long.0, self.oi_short.0])
    }
}

impl Perps {
    pub(crate) fn emit_position_funding(
        &self,
        position_id: u64,
        account_id: &near_sdk::AccountId,
        market_id: &MarketId,
        paid: u128,
        received: u128,
        now_ms: u64,
    ) {
        emit_event("funding_settled", json!({
            "position_id": position_id,
            "account_id": account_id,
            "market_id": market_id,
            "funding_paid": U128(paid),
            "funding_received": U128(received),
            "funding_payment": I128(to_i128(paid) - to_i128(received)),
            "timestamp_ms": now_ms,
        }));
    }
}

#[near]
impl Perps {
    /// Permissionless checkpoint. No price or depth freshness is needed to account for time;
    /// each position's accrued payment already affects equity and realizes when it exits.
    pub fn settle_funding(&mut self, market_id: MarketId) {
        let now_ms = env::block_timestamp_ms();
        let market = self.market_mut(&market_id);
        let from_ms = market.funding.last_accrual_ms;
        let rate = funding_rate(market.oi_long.0, market.oi_short.0);
        // Funding checkpoints must not introduce extra rounding into the borrow index.
        market.funding = market.funding_at(now_ms);
        if now_ms > from_ms {
            emit_event("funding_accrued", json!({
                "market_id": market_id,
                "from_ms": from_ms,
                "timestamp_ms": now_ms,
                "rate_per_hour": I128(rate),
                "paid_index": market.funding.paid_index,
                "received_index": market.funding.received_index,
            }));
        }
    }
}
