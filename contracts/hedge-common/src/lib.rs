//! Shared on-chain custody messages. Amounts are token-native integers, never floats.
use near_sdk::{env, json_types::{I128, U128}, near, AccountId};
pub mod policy;

pub const USD: u128 = 1_000_000;
pub const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
pub const PRICE_SCALE: u128 = 100_000_000;
pub const VALUE_SCALE: u128 = NEAR * PRICE_SCALE / USD;
pub const BPS: u128 = 10_000;
pub const MAX_CAPITAL: u128 = 10 * USD;
pub const MAX_TRADE: u128 = USD;
pub const MAX_PRICE_AGE_MS: u64 = 30_000;
pub const MAX_DEADLINE_MS: u64 = 30_000;
pub const MAX_SHORTFALL_BPS: u128 = 200;
pub const FUND_PREFIX: &str = "hedge_fund:";
pub const RETURN_PREFIX: &str = "hedge_return:";

uint::construct_uint! { struct U256(4); }

/// Full-width intermediate avoids rejecting a representable token conversion.
pub fn ratio(a: u128, b: u128, denominator: u128, ceil: bool) -> u128 {
    assert!(denominator > 0, "ERR_ZERO_DENOMINATOR");
    let product = U256::from(a) * U256::from(b);
    let divisor = U256::from(denominator);
    let quotient = product / divisor;
    let result = quotient + U256::from(u8::from(ceil && product % divisor != U256::zero()));
    assert!(result <= U256::from(u128::MAX), "ERR_OVERFLOW");
    result.low_u128()
}

pub fn cash_value(quantity: u128, price: u128) -> u128 {
    ratio(quantity, price, VALUE_SCALE, false)
}

pub fn token_quantity(cash: u128, price: u128) -> u128 {
    ratio(cash, VALUE_SCALE, price, false)
}

pub fn signed(value: u128) -> i128 {
    i128::try_from(value).unwrap_or_else(|_| env::panic_str("ERR_OVERFLOW"))
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CustodyConfig {
    pub controller: AccountId,
    pub usdc: AccountId,
    pub wrapped_near: AccountId,
    pub exchange: AccountId,
    pub pool_id: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HedgeSide { Buy, Sell }

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TradeCommand {
    pub nonce: u64,
    pub side: HedgeSide,
    pub amount_in: U128,
    pub min_out: U128,
    pub price: U128,
    pub price_timestamp_ms: u64,
    pub deadline_ms: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CustodyPhase { Preflight, Funding, Depositing, Swapping, Withdrawing, Checking, Returning, Uncertain }

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OperationKind { Fund, Trade, Return }

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingOperation {
    pub nonce: u64,
    pub kind: OperationKind,
    pub command: Option<TradeCommand>,
    pub amount: U128,
    /// Confirmed venue output; zero until a successful atomic swap result is parsed.
    pub output: U128,
    /// Amount accepted by the venue's NEP-141 deposit resolver.
    pub deposited: U128,
    pub phase: CustodyPhase,
    pub started_at_ms: u64,
    /// Set only after the atomic venue swap succeeds, not on submission.
    pub swapped: bool,
    /// Unallocated donations are excluded from expected execution deltas.
    pub wallet_before: [U128; 2],
    pub venue_before: [U128; 2],
    pub recovered: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HedgeFill {
    pub nonce: u64,
    pub side: HedgeSide,
    pub amount_in: U128,
    pub amount_out: U128,
    pub reference_price: U128,
    pub reference_timestamp_ms: u64,
    pub started_at_ms: u64,
    pub confirmed_at_ms: u64,
    /// All-in execution shortfall against the authorization mark, including venue fee.
    pub execution_cost: I128,
    pub realized_pnl: I128,
    /// True when venue holdings, rather than a swap callback, confirmed the output.
    pub recovered: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CustodySnapshot {
    pub config: CustodyConfig,
    pub nonce: u64,
    pub cash: U128,
    pub inventory: U128,
    pub cost_basis: U128,
    pub total_funded: U128,
    pub total_returned: U128,
    pub realized_pnl: I128,
    pub execution_cost: I128,
    pub pending: Option<PendingOperation>,
    pub last_fill: Option<HedgeFill>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_width_conversion_preserves_representable_results() {
        assert_eq!(ratio(u128::MAX, u128::MAX, u128::MAX, false), u128::MAX);
        assert_eq!(cash_value(NEAR, 350_000_000), 3_500_000);
        assert_eq!(token_quantity(3_500_000, 350_000_000), NEAR);
        assert_eq!(ratio(7, 3, 5, false), 4);
        assert_eq!(ratio(7, 3, 5, true), 5);
        assert_eq!(ratio(0, u128::MAX, 1, true), 0);
    }

    #[test]
    #[should_panic(expected = "ERR_OVERFLOW")]
    fn unrepresentable_result_is_not_truncated() {
        ratio(u128::MAX, 2, 1, false);
    }
}
