//! Integer math for positions. Every rounding goes in favor of the vault: trader gains are
//! floored, trader losses and fees are ceiled.

use near_sdk::env;

/// Basis points denominator.
pub const BPS: u128 = 10_000;

/// Fixed-point scale of borrow indexes and hourly rates (1e12 = 100%).
pub const RATE_PRECISION: u128 = 1_000_000_000_000;

pub const MS_PER_HOUR: u128 = 3_600_000;

/// Opening and closing fee: 0.1% of notional.
pub const TRADE_FEE_BPS: u128 = 10;

/// Hourly borrow rate at zero utilization: 0.001% of notional per hour.
pub const BORROW_BASE_PER_HOUR: u128 = 10_000_000;

/// Extra hourly borrow rate at full utilization of the side's cap: +0.009% per hour.
pub const BORROW_SLOPE_PER_HOUR: u128 = 90_000_000;

fn mul(a: u128, b: u128) -> u128 {
    a.checked_mul(b)
        .unwrap_or_else(|| env::panic_str("ERR_OVERFLOW"))
}

pub fn mul_div_floor(a: u128, b: u128, d: u128) -> u128 {
    mul(a, b) / d
}

pub fn mul_div_ceil(a: u128, b: u128, d: u128) -> u128 {
    mul(a, b).div_ceil(d)
}

/// Fee in USDC units charged on `notional`, rounded up.
pub fn trade_fee(notional: u128) -> u128 {
    mul_div_ceil(notional, TRADE_FEE_BPS, BPS)
}

/// Hourly borrow rate (RATE_PRECISION scale) for a side carrying `oi` out of `max_oi`.
pub fn borrow_rate_per_hour(oi: u128, max_oi: u128) -> u128 {
    let slope = if max_oi == 0 || oi >= max_oi {
        BORROW_SLOPE_PER_HOUR
    } else {
        mul_div_ceil(BORROW_SLOPE_PER_HOUR, oi, max_oi)
    };
    BORROW_BASE_PER_HOUR + slope
}

/// Borrow index growth over `elapsed_ms` at `rate_per_hour`.
pub fn borrow_index_delta(rate_per_hour: u128, elapsed_ms: u64) -> u128 {
    mul_div_ceil(rate_per_hour, elapsed_ms as u128, MS_PER_HOUR)
}

/// Borrow fee owed by `notional` between two index values.
pub fn borrow_fee(notional: u128, index_entry: u128, index_now: u128) -> u128 {
    mul_div_ceil(
        notional,
        index_now.saturating_sub(index_entry),
        RATE_PRECISION,
    )
}

/// Profit (positive) or loss (negative) in USDC units of a position of `notional` opened at
/// `entry` and marked at `mark`.
pub fn pnl(is_long: bool, notional: u128, entry: u128, mark: u128) -> i128 {
    let gain = if is_long { mark > entry } else { mark < entry };
    let diff = entry.abs_diff(mark);
    if gain {
        to_i128(mul_div_floor(notional, diff, entry))
    } else {
        -to_i128(mul_div_ceil(notional, diff, entry))
    }
}

/// Maintenance margin: notional / (2 × max leverage), rounded up.
pub fn maintenance_margin(notional: u128, max_leverage: u32) -> u128 {
    notional.div_ceil(2 * max_leverage as u128)
}

/// Mark price at which equity (margin + PnL − borrow fee) falls to the maintenance margin.
/// `buffer` = margin − borrow fee − maintenance; zero when the price would be negative.
pub fn liquidation_price(is_long: bool, notional: u128, entry: u128, buffer: i128) -> u128 {
    let move_abs = mul_div_floor(entry, buffer.unsigned_abs(), notional);
    // A long loses when the price falls, so a positive buffer puts liquidation below entry.
    let below = is_long == (buffer > 0);
    if below {
        entry.saturating_sub(move_abs)
    } else {
        entry + move_abs
    }
}

pub fn to_i128(v: u128) -> i128 {
    i128::try_from(v).unwrap_or_else(|_| env::panic_str("ERR_OVERFLOW"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const USD: u128 = 1_000_000;
    const PRICE: u128 = 100_000_000;

    #[test]
    fn pnl_rounds_against_the_trader() {
        // 1 USD notional, price +1/3 unit: gain floors, loss ceils.
        assert_eq!(pnl(true, 1_000_000, 3, 4), 333_333);
        assert_eq!(pnl(false, 1_000_000, 3, 4), -333_334);
        assert_eq!(pnl(false, 1_000_000, 3, 2), 333_333);
        assert_eq!(pnl(true, 500 * USD, 4 * PRICE, 4 * PRICE), 0);
    }

    #[test]
    fn fees_round_up() {
        assert_eq!(trade_fee(500 * USD), 500_000);
        assert_eq!(trade_fee(1), 1);
    }

    #[test]
    fn borrow_rate_grows_with_utilization() {
        assert_eq!(borrow_rate_per_hour(0, 100), BORROW_BASE_PER_HOUR);
        assert_eq!(
            borrow_rate_per_hour(50, 100),
            BORROW_BASE_PER_HOUR + BORROW_SLOPE_PER_HOUR / 2
        );
        assert_eq!(
            borrow_rate_per_hour(150, 100),
            BORROW_BASE_PER_HOUR + BORROW_SLOPE_PER_HOUR
        );
    }

    #[test]
    fn liquidation_price_sits_on_maintenance() {
        // Long 5x, 100 margin, 500 notional at 4.00, max leverage 5 → maintenance 50.
        let notional = 500 * USD;
        let maint = maintenance_margin(notional, 5);
        assert_eq!(maint, 50 * USD);
        let buffer = to_i128(100 * USD - maint);
        let liq = liquidation_price(true, notional, 4 * PRICE, buffer);
        assert_eq!(liq, 360_000_000);
        // At that price the loss equals the buffer exactly.
        assert_eq!(pnl(true, notional, 4 * PRICE, liq), -buffer);
        let liq_short = liquidation_price(false, notional, 4 * PRICE, buffer);
        assert_eq!(liq_short, 440_000_000);
        // Negative buffer: already under maintenance, liquidation price is above entry for a long.
        assert!(liquidation_price(true, notional, 4 * PRICE, -to_i128(USD)) > 4 * PRICE);
    }
}
