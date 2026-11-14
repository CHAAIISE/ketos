//! Spot cannot hedge net-short trader exposure. Targets are quantities, not current OI/mark.
use crate::*;

pub const MIN_TRADE: u128 = 10_000;
pub const COOLDOWN_MS: u64 = 60_000;

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HoldReason { Pending, StalePrice, Cooldown, WithinThreshold, NoCash, NoSpotShort }

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpotPlan {
    pub trader_delta: I128,
    pub target_inventory: U128,
    pub confirmed_inventory: U128,
    /// Vault delta = long spot holdings minus the traders' signed payout delta.
    pub residual_delta: I128,
    pub side: Option<HedgeSide>,
    pub amount_in: U128,
    pub hold_reason: Option<HoldReason>,
}

pub struct PolicyInput {
    pub trader_delta: i128,
    pub inventory: u128,
    pub cash: u128,
    pub price: u128,
    pub price_timestamp_ms: u64,
    pub now_ms: u64,
    pub last_attempt_ms: Option<u64>,
    pub pending: bool,
}

pub fn plan_spot(input: PolicyInput) -> SpotPlan {
    let mut plan = SpotPlan { trader_delta: I128(input.trader_delta),
        target_inventory: U128(0), confirmed_inventory: U128(input.inventory),
        residual_delta: I128(signed(input.inventory).checked_sub(input.trader_delta).expect("ERR_OVERFLOW")),
        side: None, amount_in: U128(0), hold_reason: None };
    let fresh = input.price > 0 && input.price_timestamp_ms <= input.now_ms
        && input.now_ms - input.price_timestamp_ms <= MAX_PRICE_AGE_MS;
    if fresh {
        plan.target_inventory = U128(input.trader_delta.max(0).unsigned_abs().min(token_quantity(MAX_CAPITAL, input.price)));
    }
    let hold = if input.pending { Some(HoldReason::Pending) }
        else if !fresh { Some(HoldReason::StalePrice) }
        else if input.last_attempt_ms.is_some_and(|last| input.now_ms.saturating_sub(last) < COOLDOWN_MS) { Some(HoldReason::Cooldown) }
        else { None };
    if let Some(reason) = hold { plan.hold_reason = Some(reason); return plan; }
    let target = plan.target_inventory.0;
    if input.inventory > target {
        let amount = (input.inventory - target).min(token_quantity(MAX_TRADE, input.price));
        if cash_value(amount, input.price) >= MIN_TRADE {
            plan.side = Some(HedgeSide::Sell); plan.amount_in = U128(amount); return plan;
        }
    } else if input.inventory < target {
        // Ceil is unnecessary: under-hedging by sub-token dust is safer than overshooting.
        let amount = cash_value(target - input.inventory, input.price).min(MAX_TRADE).min(input.cash);
        if amount >= MIN_TRADE {
            plan.side = Some(HedgeSide::Buy); plan.amount_in = U128(amount); return plan;
        }
        if input.cash < MIN_TRADE { plan.hold_reason = Some(HoldReason::NoCash); return plan; }
    }
    plan.hold_reason = Some(if input.trader_delta < 0 && input.inventory == 0 {
        HoldReason::NoSpotShort
    } else { HoldReason::WithinThreshold });
    plan
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(delta: i128) -> PolicyInput {
        PolicyInput { trader_delta: delta, inventory: 0, cash: MAX_CAPITAL, price: 400_000_000,
            price_timestamp_ms: 100_000, now_ms: 100_000, last_attempt_ms: None, pending: false }
    }
    #[test]
    fn net_long_traders_require_positive_spot_inventory() {
        let plan = plan_spot(input(signed(NEAR)));
        assert_eq!(plan.target_inventory.0, NEAR);
        assert_eq!(plan.side, Some(HedgeSide::Buy));
        assert_eq!(plan.amount_in.0, USD);
        assert_eq!(plan.residual_delta.0, -signed(NEAR));
    }
    #[test]
    fn net_short_traders_cannot_authorize_a_naked_spot_sale() {
        let plan = plan_spot(input(-signed(NEAR)));
        assert_eq!(plan.side, None);
        assert_eq!(plan.hold_reason, Some(HoldReason::NoSpotShort));
        assert_eq!(plan.residual_delta.0, signed(NEAR));
    }
    #[test]
    fn crossing_to_net_short_unwinds_only_existing_inventory() {
        let mut i = input(-signed(NEAR)); i.inventory = NEAR / 8;
        let plan = plan_spot(i);
        assert_eq!(plan.side, Some(HedgeSide::Sell));
        assert_eq!(plan.amount_in.0, NEAR / 8);
    }
    #[test]
    fn confirmed_inventory_reduces_target_deficit_without_increasing_capital() {
        let mut i = input(signed(NEAR / 4)); i.inventory = NEAR / 8; i.cash = 100_000;
        let plan = plan_spot(i);
        assert_eq!(plan.amount_in.0, 100_000);
        assert_eq!(plan.residual_delta.0, -signed(NEAR / 8));
        let mut i = input(signed(NEAR)); i.cash = 0;
        assert_eq!(plan_spot(i).hold_reason, Some(HoldReason::NoCash));
    }
    #[test]
    fn stale_future_and_unknown_observations_never_dispatch() {
        let mut stale = input(signed(NEAR)); stale.now_ms = 130_001;
        assert_eq!(plan_spot(stale).hold_reason, Some(HoldReason::StalePrice));
        let mut future = input(signed(NEAR)); future.price_timestamp_ms += 1;
        assert_eq!(plan_spot(future).hold_reason, Some(HoldReason::StalePrice));
        let mut pending = input(signed(NEAR)); pending.pending = true;
        assert_eq!(plan_spot(pending).hold_reason, Some(HoldReason::Pending));
    }
    #[test]
    fn capital_ceiling_and_cooldown_bound_repeated_execution() {
        let plan = plan_spot(input(signed(100 * NEAR)));
        assert_eq!(plan.target_inventory.0, 5 * NEAR / 2);
        let mut i = input(signed(NEAR)); i.last_attempt_ms = Some(90_000);
        assert_eq!(plan_spot(i).hold_reason, Some(HoldReason::Cooldown));
    }
}
