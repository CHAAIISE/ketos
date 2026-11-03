use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::U128;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, AccountId, Gas, NearToken, PromiseError, PromiseOrValue};

use crate::market::USD;
use crate::math;
use crate::position::{PositionView, Side};
use crate::Perps;

const CONTRACT: &str = "perps.test";
const USDC: &str = "usdc.test";

fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(predecessor: &str, deposit: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(id(CONTRACT))
        .predecessor_account_id(id(predecessor))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .prepaid_gas(Gas::from_tgas(300))
        .build());
}

fn setup() -> Perps {
    ctx("owner.test", 0);
    Perps::new(id(USDC), id("oracle.test"), id("keeper.test"))
}

/// Deposits margin and checks the whole amount is kept (nothing refunded to the sender).
fn deposit(perps: &mut Perps, trader: &str, amount: u128) {
    ctx(USDC, 0);
    let PromiseOrValue::Value(unused) =
        perps.ft_on_transfer(id(trader), U128(amount), "deposit_margin".into())
    else {
        panic!("deposit must resolve synchronously");
    };
    assert_eq!(unused, U128(0));
}

fn margin(perps: &Perps, trader: &str) -> u128 {
    perps.get_account(id(trader)).map_or(0, |a| a.margin.0)
}

#[test]
fn lists_four_markets_with_oracle_ids() {
    let perps = setup();
    let markets = perps.get_markets();
    let ids: Vec<_> = markets
        .iter()
        .map(|m| (m.id.as_str(), m.oracle_asset_id.as_str()))
        .collect();
    assert_eq!(
        ids,
        [
            ("BTC", "nbtc.bridge.near"),
            ("ETH", "aurora"),
            ("NEAR", "wrap.near"),
            ("ZEC", "zec.omft.near")
        ]
    );
    assert_eq!(perps.get_market("ZEC".into()).unwrap().oi_short, U128(0));
    assert!(perps.get_market("DOGE".into()).is_none());
    assert_eq!(perps.get_config().usdc_id, id(USDC));
}

#[test]
fn deposit_credits_margin_and_keeps_all_tokens() {
    let mut perps = setup();
    deposit(&mut perps, "alice.test", 200 * USD);
    deposit(&mut perps, "alice.test", 50);
    assert_eq!(margin(&perps, "alice.test"), 200 * USD + 50);
}

#[test]
#[should_panic(expected = "ERR_WRONG_TOKEN")]
fn deposit_from_other_token_is_rejected() {
    let mut perps = setup();
    ctx("fake-usdc.test", 0);
    let _ = perps.ft_on_transfer(id("alice.test"), U128(200 * USD), "deposit_margin".into());
}

#[test]
#[should_panic(expected = "ERR_INVALID_MSG")]
fn unknown_message_is_rejected() {
    let mut perps = setup();
    ctx(USDC, 0);
    let _ = perps.ft_on_transfer(id("alice.test"), U128(200 * USD), "gift".into());
}

#[test]
#[should_panic(expected = "ERR_MIN_FIRST_DEPOSIT")]
fn first_deposit_below_minimum_is_rejected() {
    let mut perps = setup();
    deposit(&mut perps, "alice.test", USD - 1);
}

#[test]
fn withdraw_debits_margin_and_transfers_tokens() {
    let mut perps = setup();
    deposit(&mut perps, "alice.test", 200 * USD);
    ctx("alice.test", 1);
    let _ = perps.withdraw_margin(U128(150 * USD));
    assert_eq!(margin(&perps, "alice.test"), 50 * USD);

    let receipts = get_created_receipts();
    assert_eq!(receipts[0].receiver_id, id(USDC));
    let MockAction::FunctionCallWeight {
        method_name,
        args,
        attached_deposit,
        ..
    } = &receipts[0].actions[0]
    else {
        panic!("expected ft_transfer");
    };
    assert_eq!(method_name.as_slice(), b"ft_transfer");
    assert_eq!(*attached_deposit, NearToken::from_yoctonear(1));
    let args: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
    assert_eq!(args["receiver_id"], "alice.test");
    assert_eq!(args["amount"], (150 * USD).to_string());
}

#[test]
fn failed_transfer_restores_margin() {
    let mut perps = setup();
    deposit(&mut perps, "alice.test", 200 * USD);
    ctx("alice.test", 1);
    let _ = perps.withdraw_margin(U128(200 * USD));
    assert_eq!(margin(&perps, "alice.test"), 0);

    ctx(CONTRACT, 0);
    let sent =
        perps.on_margin_withdrawn(id("alice.test"), U128(200 * USD), Err(PromiseError::Failed));
    assert_eq!(sent, U128(0));
    assert_eq!(margin(&perps, "alice.test"), 200 * USD);

    let sent = perps.on_margin_withdrawn(id("alice.test"), U128(5), Ok(()));
    assert_eq!(sent, U128(5));
    assert_eq!(margin(&perps, "alice.test"), 200 * USD);
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT_MARGIN")]
fn cannot_withdraw_more_than_margin() {
    let mut perps = setup();
    deposit(&mut perps, "alice.test", 200 * USD);
    ctx("alice.test", 1);
    let _ = perps.withdraw_margin(U128(200 * USD + 1));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn withdraw_requires_one_yocto() {
    let mut perps = setup();
    deposit(&mut perps, "alice.test", 200 * USD);
    ctx("alice.test", 0);
    let _ = perps.withdraw_margin(U128(USD));
}

#[test]
#[should_panic(expected = "ERR_NO_ACCOUNT")]
fn withdraw_without_account_fails() {
    let mut perps = setup();
    ctx("bob.test", 1);
    let _ = perps.withdraw_margin(U128(USD));
}

// Positions

const T0_MS: u64 = 1_800_000_000_000;
const HOUR_MS: u64 = 3_600_000;
/// 8-decimal prices.
const P4: u128 = 400_000_000;

fn ctx_at(predecessor: &str, now_ms: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(id(CONTRACT))
        .predecessor_account_id(id(predecessor))
        .block_timestamp(now_ms * 1_000_000)
        .prepaid_gas(Gas::from_tgas(300))
        .build());
}

fn set_price(perps: &mut Perps, market: &str, price: u128, at_ms: u64) {
    let m = perps.markets.get_mut(&market.to_string()).unwrap();
    m.price = U128(price);
    m.price_timestamp_ms = at_ms;
}

/// NEAR market at $4 with 5x allowed, trader with 200 USDC margin, vault with 10,000 USDC.
fn trading_setup() -> Perps {
    let mut perps = setup();
    deposit(&mut perps, "alice.test", 200 * USD);
    perps.vault_usdc = 10_000 * USD;
    for m in ["NEAR", "ZEC"] {
        perps.markets.get_mut(&m.to_string()).unwrap().max_leverage = 5;
        set_price(&mut perps, m, P4, T0_MS);
    }
    perps
}

fn open(perps: &mut Perps, market: &str, side: Side, margin: u128, leverage: u32) -> PositionView {
    ctx_at("alice.test", T0_MS);
    perps.open_position(market.into(), side, U128(margin), leverage)
}

fn close_at(perps: &mut Perps, position: u64, price: u128, now_ms: u64) -> u128 {
    set_price(perps, "NEAR", price, now_ms);
    ctx_at("alice.test", now_ms);
    perps.close_position(position).0
}

#[test]
fn open_locks_margin_and_charges_fee_to_vault() {
    let mut perps = trading_setup();
    let p = open(&mut perps, "NEAR", Side::Long, 100 * USD, 5);
    assert_eq!(p.size.0, 500 * USD);
    assert_eq!(p.margin.0, 100 * USD - 500_000);
    assert_eq!(p.entry_price.0, P4);
    assert_eq!(margin(&perps, "alice.test"), 100 * USD);
    assert_eq!(perps.vault_usdc, 10_000 * USD + 500_000);
    assert_eq!(
        perps.get_market("NEAR".into()).unwrap().oi_long.0,
        500 * USD
    );
    assert_eq!(perps.get_positions(id("alice.test")), vec![p.clone()]);
    // Maintenance 10% of notional at 5x max leverage; liquidation ~ -10% minus the fee.
    assert_eq!(p.maintenance_margin.0, 50 * USD);
    assert_eq!(p.liquidation_price.0, 360_400_000);
}

#[test]
fn winning_long_is_paid_by_the_vault() {
    let mut perps = trading_setup();
    let p = open(&mut perps, "NEAR", Side::Long, 100 * USD, 5);
    // +10%: PnL +50 USDC, closing fee 0.5, borrow fee over 1 minute.
    let payout = close_at(&mut perps, p.id, 440_000_000, T0_MS + 60_000);
    // Index grows by ceil(10_090_000 / 60) = 168_167; fee = ceil(500e6 × 168_167 / 1e12) = 85.
    assert_eq!(payout, 99_500_000 + 50 * USD - 500_000 - 85);
    assert_eq!(margin(&perps, "alice.test"), 100 * USD + payout);
    // Vault + trader balances are conserved.
    assert_eq!(
        perps.vault_usdc + margin(&perps, "alice.test"),
        10_200 * USD
    );
    assert!(perps.get_position(p.id).is_none());
    assert!(perps.get_positions(id("alice.test")).is_empty());
    assert_eq!(perps.get_market("NEAR".into()).unwrap().oi_long.0, 0);
}

#[test]
fn losing_long_pays_the_vault() {
    let mut perps = trading_setup();
    let p = open(&mut perps, "NEAR", Side::Long, 100 * USD, 5);
    // -5%: PnL -25 USDC.
    let payout = close_at(&mut perps, p.id, 380_000_000, T0_MS);
    assert_eq!(payout, 99_500_000 - 25 * USD - 500_000);
    assert_eq!(
        perps.vault_usdc,
        10_000 * USD + 500_000 + 25 * USD + 500_000
    );
    assert_eq!(
        perps.vault_usdc + margin(&perps, "alice.test"),
        10_200 * USD
    );
}

#[test]
fn winning_short_on_price_drop() {
    let mut perps = trading_setup();
    ctx_at("alice.test", T0_MS);
    let p = perps.open_position("NEAR".into(), Side::Short, U128(50 * USD), 2);
    assert_eq!(p.size.0, 100 * USD);
    // -20%: short PnL +20 USDC.
    let payout = close_at(&mut perps, p.id, 320_000_000, T0_MS);
    assert_eq!(payout, 50 * USD - 100_000 + 20 * USD - 100_000);
}

#[test]
fn loss_beyond_margin_is_absorbed_by_the_vault_floor_at_zero() {
    let mut perps = trading_setup();
    let p = open(&mut perps, "NEAR", Side::Long, 100 * USD, 5);
    let payout = close_at(&mut perps, p.id, 300_000_000, T0_MS);
    assert_eq!(payout, 0);
    assert_eq!(perps.vault_usdc, 10_000 * USD + 100 * USD);
}

#[test]
fn borrow_fee_accrues_hourly_with_utilization() {
    let mut perps = trading_setup();
    let p = open(&mut perps, "NEAR", Side::Long, 100 * USD, 5);
    // Utilization 500 / 500,000 of the hard cap: rate = base + slope × 0.001 per hour.
    let rate = math::BORROW_BASE_PER_HOUR + math::BORROW_SLOPE_PER_HOUR / 1_000;
    let expected = (500 * USD * rate * 10).div_ceil(math::RATE_PRECISION);
    set_price(&mut perps, "NEAR", P4, T0_MS + 10 * HOUR_MS);
    ctx_at("bob.test", T0_MS + 10 * HOUR_MS);
    let view = perps.get_position(p.id).unwrap();
    assert_eq!(view.borrow_fee.0, expected);
    assert_eq!(expected, 50_450); // ~0.01% of notional over 10 hours
    assert_eq!(view.equity.0, (p.margin.0 - expected) as i128);

    let payout = close_at(&mut perps, p.id, P4, T0_MS + 10 * HOUR_MS);
    assert_eq!(payout, p.margin.0 - expected - 500_000);
}

#[test]
fn borrow_rate_is_charged_at_the_utilization_in_force() {
    let mut perps = trading_setup();
    let first = open(&mut perps, "NEAR", Side::Long, 50 * USD, 2);
    // A second, bigger position opened 5 hours later must not raise the first one's fee
    // for the hours already elapsed.
    set_price(&mut perps, "NEAR", P4, T0_MS + 5 * HOUR_MS);
    ctx_at("alice.test", T0_MS + 5 * HOUR_MS);
    perps.open_position("NEAR".into(), Side::Long, U128(100 * USD), 5);
    ctx_at("alice.test", T0_MS + 5 * HOUR_MS);
    let fee = perps.get_position(first.id).unwrap().borrow_fee.0;
    let rate = math::borrow_rate_per_hour(100 * USD, 500_000 * USD);
    assert_eq!(fee, (100 * USD * (rate * 5)).div_ceil(math::RATE_PRECISION));
}

#[test]
#[should_panic(expected = "ERR_STALE_PRICE")]
fn stale_price_is_refused() {
    let mut perps = trading_setup();
    ctx_at("alice.test", T0_MS + 120_001);
    perps.open_position("NEAR".into(), Side::Long, U128(100 * USD), 5);
}

#[test]
#[should_panic(expected = "ERR_STALE_PRICE")]
fn close_with_stale_price_is_refused() {
    let mut perps = trading_setup();
    let p = open(&mut perps, "NEAR", Side::Long, 100 * USD, 5);
    ctx_at("alice.test", T0_MS + 121_000);
    perps.close_position(p.id);
}

#[test]
#[should_panic(expected = "ERR_NO_PRICE")]
fn missing_price_is_refused() {
    let mut perps = trading_setup();
    perps
        .markets
        .get_mut(&"BTC".to_string())
        .unwrap()
        .max_leverage = 5;
    ctx_at("alice.test", T0_MS);
    perps.open_position("BTC".into(), Side::Long, U128(100 * USD), 2);
}

#[test]
#[should_panic(expected = "ERR_LEVERAGE_TOO_HIGH: max 5")]
fn leverage_above_market_max_is_refused() {
    let mut perps = trading_setup();
    open(&mut perps, "NEAR", Side::Long, 100 * USD, 6);
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT_MARGIN")]
fn margin_above_free_balance_is_refused() {
    let mut perps = trading_setup();
    open(&mut perps, "NEAR", Side::Long, 201 * USD, 2);
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn only_owner_can_close() {
    let mut perps = trading_setup();
    let p = open(&mut perps, "NEAR", Side::Long, 100 * USD, 5);
    ctx_at("bob.test", T0_MS);
    perps.close_position(p.id);
}
