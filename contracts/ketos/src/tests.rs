use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::U128;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, AccountId, Gas, NearToken, PromiseError, PromiseOrValue};

use crate::depth::DepthSample;
use crate::liquidation::LiquidationRecord;
use crate::market::{MarketConfig, PriceSource, VaultId, USD};
use crate::math;
use crate::position::{PositionView, Side};
use crate::Ketos;

mod capital;
mod cross;
mod execution_policy;
mod depth_policy;
mod funding;
mod history;
mod listing;
mod orders;
mod oracle_policy;
mod pull_prices;
mod signed_prices;
mod vaults;
mod worker_prices;
mod wallet_trading;
mod retirement;

const CONTRACT: &str = "ketos.test";
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

fn setup() -> Ketos {
    ctx("owner.test", 0);
    Ketos::new(id(USDC), id("oracle.test"), id("keeper.test"), id("outlayer.test"))
}

/// Deposits margin and checks the whole amount is kept (nothing refunded to the sender).
fn deposit(ketos: &mut Ketos, trader: &str, amount: u128) {
    ctx(USDC, 0);
    let PromiseOrValue::Value(unused) =
        ketos.ft_on_transfer(id(trader), U128(amount), "deposit_margin".into())
    else {
        panic!("deposit must resolve synchronously");
    };
    assert_eq!(unused, U128(0));
}

fn margin(ketos: &Ketos, trader: &str) -> u128 {
    ketos.get_account(id(trader)).map_or(0, |a| a.margin.0)
}

fn assert_margin_wallet_transfer(amount: u128) {
    let receipts = get_created_receipts();
    let transfers: Vec<_> = receipts.iter()
        .filter(|receipt| receipt.receiver_id == id(USDC))
        .collect();
    assert_eq!(transfers.len(), 1);
    let MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } =
        &transfers[0].actions[0]
    else {
        panic!("expected ft_transfer");
    };
    assert_eq!(method_name.as_slice(), b"ft_transfer");
    assert_eq!(*attached_deposit, NearToken::from_yoctonear(1));
    let args: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
    assert_eq!(args["receiver_id"], "alice.test");
    assert_eq!(args["amount"], amount.to_string());
    let callback = receipts.iter().find(|receipt| receipt.receiver_id == id(CONTRACT)).unwrap();
    let MockAction::FunctionCallWeight { method_name, args, .. } = &callback.actions[0] else {
        panic!("expected margin callback");
    };
    assert_eq!(method_name.as_slice(), b"on_margin_withdrawn");
    let args: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
    assert_eq!(args["account_id"], "alice.test");
    assert_eq!(args["amount"], amount.to_string());
}

#[test]
fn registry_paginates_all_markets_in_listing_order() {
    let ketos = setup();
    let markets = ketos.get_markets(None, None);
    assert_eq!(
        markets.iter().map(|m| m.market.id.as_str()).collect::<Vec<_>>(),
        ["BTC", "ETH", "NEAR", "ZEC", "SOL",
         "DOGE", "XRP", "LTC", "ADA", "SUI", "TRX", "BNB", "AVAX", "LINK"]
    );
    assert!(markets.iter().all(|m| !m.is_open && m.max_oi_per_side.0 == 0));
    let mut paged = Vec::new();
    for from in (0..markets.len()).step_by(3) {
        paged.extend(ketos.get_markets(Some(from as u32), Some(3)));
    }
    assert_eq!(paged, markets);
    assert!(ketos.get_markets(Some(markets.len() as u32), Some(3)).is_empty());
    assert!(ketos.get_markets(Some(u32::MAX), Some(3)).is_empty());
    assert!(ketos.get_markets(None, Some(0)).is_empty());
    assert_eq!(ketos.get_market("SOL".into()).unwrap().market.vault_id, VaultId::Core);
    assert_eq!(ketos.get_market("ZEC".into()).unwrap().market.vault_id, VaultId::LongTail);
    assert!(ketos.get_market("AURORA".into()).is_none());
    assert!(ketos.get_market("RHEA".into()).is_none());
    let doge = ketos.get_market("DOGE".into()).unwrap().market;
    assert_eq!(doge.price_source, PriceSource::OutlayerWorker);
    assert_eq!(doge.vault_id, VaultId::LongTail);
    assert_eq!(doge.max_leverage_cap, 5);
}

fn extra_market(symbol: &str, source: PriceSource) -> MarketConfig {
    MarketConfig {
        symbol: symbol.into(),
        oracle_asset_id: format!("{symbol}.oracle"),
        intents_asset_id: format!("nep141:{symbol}.token"),
        price_source: source,
        vault_id: VaultId::LongTail,
        hard_cap: U128(20_000 * USD),
        fee_bps: 5,
        max_leverage_cap: 3,
    }
}

#[test]
fn registry_addition_uses_asset_prices_market_fees_and_risk_limits() {
    let mut ketos = setup();
    ketos.register_market(extra_market("NEW", PriceSource::Tee));
    assert!(!ketos.get_market("NEW".into()).unwrap().is_open);
    seed_depth(&mut ketos, "NEW", measured_curve(), T0_MS);
    // An unrelated asset must not price this market.
    let data = price_data(T0_MS, &[("OTHER.oracle", Some((P4, 8)))]);
    push_prices(&mut ketos, ORACLE, T0_MS, data);
    assert_eq!(stored_price(&ketos, "NEW"), (0, 0));
    let data = price_data(T0_MS, &[("NEW.oracle", Some((P4, 8)))]);
    push_prices(&mut ketos, ORACLE, T0_MS, data);
    ketos.vaults[VaultId::LongTail.index()].balance = 10_000 * USD;
    let market = ketos.get_market("NEW".into()).unwrap();
    assert!(market.is_open);
    assert_eq!(market.max_oi_per_side.0, 20_000 * USD);
    assert_eq!(market.market.max_leverage, 3);
    assert_eq!(ketos.get_depth("NEW".into()).unwrap().history.last().unwrap().max_leverage, 3);
    deposit(&mut ketos, "alice.test", 200 * USD);
    let p = open(&mut ketos, "NEW", Side::Long, 100 * USD, 3);
    assert_eq!(p.entry_price.0, P4);
    assert_eq!(p.margin.0, 100 * USD - 750_000);
    assert_eq!(p.close_fee.0, 750_000);
    ctx_at("alice.test", T0_MS);
    assert_eq!(ketos.close_position_now(p.id).0, 100 * USD - 1_500_000);
}

#[test]
#[should_panic(expected = "ERR_LEVERAGE_TOO_HIGH: max 3")]
fn market_leverage_ceiling_cannot_be_overridden_by_deeper_liquidity() {
    let mut ketos = setup();
    ketos.register_market(extra_market("NEW", PriceSource::Tee));
    seed_depth(&mut ketos, "NEW", measured_curve(), T0_MS);
    set_price(&mut ketos, "NEW", P4, T0_MS);
    deposit(&mut ketos, "alice.test", 200 * USD);
    open(&mut ketos, "NEW", Side::Long, 100 * USD, 4);
}

#[test]
#[should_panic(expected = "ERR_MARKET_EXISTS")]
fn registry_refuses_replacing_a_live_market() {
    let mut ketos = setup();
    ketos.register_market(extra_market("NEAR", PriceSource::Tee));
}

#[test]
#[should_panic(expected = "ERR_ASSET_EXISTS")]
fn registry_refuses_reusing_an_oracle_asset() {
    let mut ketos = setup();
    let mut config = extra_market("NEW", PriceSource::Tee);
    config.oracle_asset_id = "wrap.near".into();
    ketos.register_market(config);
}

#[test]
#[should_panic(expected = "ERR_ASSET_EXISTS")]
fn registry_refuses_reusing_an_intents_asset() {
    let mut ketos = setup();
    let mut config = extra_market("NEW", PriceSource::Tee);
    config.intents_asset_id = "nep141:wrap.near".into();
    ketos.register_market(config);
}

#[test]
fn registry_limit_preserves_existing_markets_and_pagination() {
    let mut ketos = setup();
    for i in 0..18 {
        ketos.register_market(extra_market(&format!("NEW{i}"), PriceSource::Tee));
    }
    let before = ketos.get_markets(None, Some(u32::MAX));
    let error = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ketos.register_market(extra_market("OVERFLOW", PriceSource::Tee));
    }));
    assert!(error.is_err());
    assert_eq!(ketos.get_markets(None, Some(u32::MAX)), before);
    assert_eq!(before.len(), 32);
    assert_eq!(ketos.get_markets(Some(14), Some(100)).last().unwrap().market.id, "NEW17");
    assert!(!ketos.oracle_markets.contains_key(&"OVERFLOW.oracle".to_string()));
}

#[test]
fn deposit_credits_margin_and_keeps_all_tokens() {
    let mut ketos = setup();
    deposit(&mut ketos, "alice.test", 200 * USD);
    deposit(&mut ketos, "alice.test", USD);
    assert_eq!(margin(&ketos, "alice.test"), 201 * USD);
}

#[test]
#[should_panic(expected = "ERR_WRONG_TOKEN")]
fn deposit_from_other_token_is_rejected() {
    let mut ketos = setup();
    ctx("fake-usdc.test", 0);
    let _ = ketos.ft_on_transfer(id("alice.test"), U128(200 * USD), "deposit_margin".into());
}

#[test]
#[should_panic(expected = "ERR_INVALID_MSG")]
fn unknown_message_is_rejected() {
    let mut ketos = setup();
    ctx(USDC, 0);
    let _ = ketos.ft_on_transfer(id("alice.test"), U128(200 * USD), "gift".into());
}

#[test]
#[should_panic(expected = "ERR_MIN_MARGIN_DEPOSIT")]
fn first_deposit_below_minimum_is_rejected() {
    let mut ketos = setup();
    deposit(&mut ketos, "alice.test", USD - 1);
}

#[test]
fn withdraw_debits_margin_and_transfers_tokens() {
    let mut ketos = setup();
    deposit(&mut ketos, "alice.test", 200 * USD);
    ctx("alice.test", 1);
    let _ = ketos.withdraw_margin(U128(150 * USD));
    assert_eq!(margin(&ketos, "alice.test"), 50 * USD);

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
    assert_eq!(receipts[1].receiver_id, id(CONTRACT));
    let MockAction::FunctionCallWeight { method_name, args, .. } = &receipts[1].actions[0] else {
        panic!("expected withdrawal callback");
    };
    assert_eq!(method_name.as_slice(), b"on_margin_withdrawn");
    let args: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
    assert_eq!(args["account_id"], "alice.test");
    assert_eq!(args["amount"], (150 * USD).to_string());

    let pending = ketos.get_history(id("alice.test"), None, None);
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].kind, crate::history::HistoryKind::Deposit);
    ctx_at(CONTRACT, T0_MS + 7);
    assert_eq!(
        ketos.on_margin_withdrawn(id("alice.test"), U128(150 * USD), Ok(())),
        U128(150 * USD)
    );
    let completed = ketos.get_history(id("alice.test"), None, None);
    assert_eq!(completed.len(), 2);
    assert_eq!(completed[1].kind, crate::history::HistoryKind::Withdrawal);
    assert_eq!(completed[1].size.0, 150 * USD);
    assert_eq!(completed[1].timestamp_ms, T0_MS + 7);
    assert_eq!(margin(&ketos, "alice.test"), 50 * USD);
}

#[test]
fn failed_transfer_restores_margin() {
    let mut ketos = setup();
    deposit(&mut ketos, "alice.test", 200 * USD);
    let history_before = ketos.get_history(id("alice.test"), None, None);
    let stats_before = ketos.get_account_stats(id("alice.test"));
    ctx("alice.test", 1);
    let _ = ketos.withdraw_margin(U128(200 * USD));
    assert_eq!(margin(&ketos, "alice.test"), 0);

    ctx(CONTRACT, 0);
    let sent =
        ketos.on_margin_withdrawn(id("alice.test"), U128(200 * USD), Err(PromiseError::Failed));
    assert_eq!(sent, U128(0));
    assert_eq!(margin(&ketos, "alice.test"), 200 * USD);

    assert_eq!(
        ketos.get_history(id("alice.test"), None, None),
        history_before
    );
    assert_eq!(ketos.get_account_stats(id("alice.test")), stats_before);
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT_MARGIN")]
fn cannot_withdraw_more_than_margin() {
    let mut ketos = setup();
    deposit(&mut ketos, "alice.test", 200 * USD);
    ctx("alice.test", 1);
    let _ = ketos.withdraw_margin(U128(200 * USD + 1));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn withdraw_requires_one_yocto() {
    let mut ketos = setup();
    deposit(&mut ketos, "alice.test", 200 * USD);
    ctx("alice.test", 0);
    let _ = ketos.withdraw_margin(U128(USD));
}

#[test]
#[should_panic(expected = "ERR_NO_ACCOUNT")]
fn withdraw_without_account_fails() {
    let mut ketos = setup();
    ctx("bob.test", 1);
    let _ = ketos.withdraw_margin(U128(USD));
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

fn set_price(ketos: &mut Ketos, market: &str, price: u128, at_ms: u64) {
    let m = ketos.markets.get_mut(&market.to_string()).unwrap();
    m.price = U128(price);
    m.price_timestamp_ms = at_ms;
}

/// Curve shaped like the 2026-11-03 1Click measurement: ~25 bps up to $100k, then no liquidity.
fn measured_curve() -> Vec<DepthSample> {
    [
        (1_000, Some(20)),
        (10_000, Some(20)),
        (50_000, Some(25)),
        (100_000, Some(31)),
        (250_000, None),
        (500_000, None),
        (1_000_000, None),
    ]
    .into_iter()
    .map(|(size_usd, impact_bps)| DepthSample {
        size_usd,
        impact_bps,
    })
    .collect()
}

fn set_depth_at(ketos: &mut Ketos, market: &str, samples: Vec<DepthSample>, at_ms: u64) {
    ctx_at("keeper.test", at_ms);
    ketos.set_depth(market.into(), samples, at_ms);
}

/// Mature measured limits through real updates; individual depth tests use set_depth_at.
fn seed_depth(ketos: &mut Ketos, market: &str, samples: Vec<DepthSample>, at_ms: u64) {
    for step in 0..=10 {
        set_depth_at(ketos, market, samples.clone(), at_ms - 4 * HOUR_MS + step * (4 * HOUR_MS / 10));
    }
}

fn seed_unpriced_markets(ketos: &mut Ketos) {
    for market in ketos.markets.values_mut() {
        if market.price.0 == 0 {
            market.price = U128(P4);
            market.price_timestamp_ms = T0_MS;
        }
    }
}

/// NEAR and ZEC at $4 with the measured $100k exit capacity (5x, $100k OI per side), trader
/// with 200 USDC margin, vault with 10,000 USDC.
fn trading_setup() -> Ketos {
    let mut ketos = setup();
    seed_unpriced_markets(&mut ketos);
    deposit(&mut ketos, "alice.test", 200 * USD);
    ketos.vaults[VaultId::Core.index()].balance = 10_000 * USD;
    ketos.vaults[VaultId::LongTail.index()].balance = 10_000 * USD;
    for m in ["NEAR", "ZEC"] {
        seed_depth(&mut ketos, m, measured_curve(), T0_MS);
        set_price(&mut ketos, m, P4, T0_MS);
    }
    ketos
}

fn open(ketos: &mut Ketos, market: &str, side: Side, margin: u128, leverage: u32) -> PositionView {
    ctx_at("alice.test", T0_MS);
    ketos.open_position_now(market.into(), side, U128(margin), leverage, None, None)
}

fn close_at(ketos: &mut Ketos, position: u64, price: u128, now_ms: u64) -> u128 {
    set_price(ketos, "NEAR", price, now_ms);
    ctx_at("alice.test", now_ms);
    ketos.close_position_now(position).0
}

#[test]
fn open_locks_margin_and_charges_fee_to_vault() {
    let mut ketos = trading_setup();
    let p = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    assert_eq!(p.size.0, 500 * USD);
    assert_eq!(p.margin.0, 100 * USD - 1_500_000);
    assert_eq!(p.entry_price.0, P4);
    assert_eq!(margin(&ketos, "alice.test"), 100 * USD);
    assert_eq!(ketos.vaults[0].balance, 10_000 * USD + 1_500_000);
    assert_eq!(
        ketos.get_market("NEAR".into()).unwrap().market.oi_long.0,
        500 * USD
    );
    assert_eq!(ketos.get_positions(id("alice.test")), vec![p.clone()]);
    // Maintenance 10% of notional at 5x max leverage; liquidation ~ -10% minus the fee.
    assert_eq!(p.maintenance_margin.0, 50 * USD);
    assert_eq!(p.liquidation_price.0, 361_200_000);
}

#[test]
fn open_positions_are_listed_page_by_page() {
    let mut ketos = trading_setup();
    let a = open(&mut ketos, "NEAR", Side::Long, 10 * USD, 2);
    let b = open(&mut ketos, "ZEC", Side::Short, 10 * USD, 2);
    let c = open(&mut ketos, "NEAR", Side::Short, 10 * USD, 2);
    assert_eq!(ketos.get_open_positions(None, None), vec![a.clone(), b.clone(), c.clone()]);
    assert_eq!(ketos.get_open_positions(Some(1), Some(1)), vec![b.clone()]);
    assert!(ketos.get_open_positions(Some(3), None).is_empty());
    ctx_at("alice.test", T0_MS);
    ketos.close_position_now(a.id);
    assert_eq!(ketos.get_open_positions(None, None).len(), 2);
}

#[test]
fn winning_long_is_paid_by_the_vault() {
    let mut ketos = trading_setup();
    let p = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    // +10%: PnL +50 USDC, closing fee 1.5 including impact, borrow fee over 1 minute.
    let payout = close_at(&mut ketos, p.id, 440_000_000, T0_MS + 60_000);
    // Utilization 500 / 100,000: rate = 10_000_000 + 450_000 per hour; the index grows by
    // ceil(10_450_000 / 60) = 174_167; fee = ceil(500e6 × 174_167 / 1e12) = 88.
    // One-sided funding: ceil(500 USDC × 0.05% / 60) = 4,167 micro-USDC.
    assert_eq!(payout, 98_500_000 + 50 * USD - 1_500_000 - 88 - 4_167);
    assert_eq!(margin(&ketos, "alice.test"), 100 * USD + payout);
    // Vault + trader balances are conserved.
    assert_eq!(
        ketos.vaults[0].balance + margin(&ketos, "alice.test"),
        10_200 * USD
    );
    assert!(ketos.get_position(p.id).is_none());
    assert!(ketos.get_positions(id("alice.test")).is_empty());
    assert_eq!(ketos.get_market("NEAR".into()).unwrap().market.oi_long.0, 0);
}

#[test]
fn losing_long_pays_the_vault() {
    let mut ketos = trading_setup();
    let p = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    // -5%: PnL -25 USDC.
    let payout = close_at(&mut ketos, p.id, 380_000_000, T0_MS);
    assert_eq!(payout, 98_500_000 - 25 * USD - 1_500_000);
    assert_eq!(
        ketos.vaults[0].balance,
        10_000 * USD + 1_500_000 + 25 * USD + 1_500_000
    );
    assert_eq!(
        ketos.vaults[0].balance + margin(&ketos, "alice.test"),
        10_200 * USD
    );
}

#[test]
fn winning_short_on_price_drop() {
    let mut ketos = trading_setup();
    ctx_at("alice.test", T0_MS);
    let p = ketos.open_position_now("NEAR".into(), Side::Short, U128(50 * USD), 2, None, None);
    assert_eq!(p.size.0, 100 * USD);
    // -20%: short PnL +20 USDC.
    let payout = close_at(&mut ketos, p.id, 320_000_000, T0_MS);
    assert_eq!(payout, 50 * USD - 300_000 + 20 * USD - 300_000);
}

#[test]
fn loss_beyond_margin_is_absorbed_by_the_vault_floor_at_zero() {
    let mut ketos = trading_setup();
    let p = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    let payout = close_at(&mut ketos, p.id, 300_000_000, T0_MS);
    assert_eq!(payout, 0);
    assert_eq!(ketos.vaults[0].balance, 10_000 * USD + 100 * USD);
}

#[test]
fn borrow_fee_accrues_hourly_with_utilization() {
    let mut ketos = trading_setup();
    let p = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    // Utilization 500 / 100,000 of the exit capacity: rate = base + slope × 0.005 per hour.
    let rate = math::BORROW_BASE_PER_HOUR + math::BORROW_SLOPE_PER_HOUR / 200;
    let expected = (500 * USD * rate * 10).div_ceil(math::RATE_PRECISION);
    set_price(&mut ketos, "NEAR", P4, T0_MS + 10 * HOUR_MS);
    ctx_at("bob.test", T0_MS + 10 * HOUR_MS);
    let view = ketos.get_position(p.id).unwrap();
    assert_eq!(view.borrow_fee.0, expected);
    assert_eq!(expected, 52_250); // ~0.01% of notional over 10 hours
    assert_eq!(view.funding_payment.0, 2_500_000);
    assert_eq!(view.equity.0, (p.margin.0 - expected - 2_500_000) as i128);

    let payout = close_at(&mut ketos, p.id, P4, T0_MS + 10 * HOUR_MS);
    assert_eq!(payout, p.margin.0 - expected - 1_500_000 - 2_500_000);
}

#[test]
fn borrow_rate_is_charged_at_the_utilization_in_force() {
    let mut ketos = trading_setup();
    let first = open(&mut ketos, "NEAR", Side::Long, 50 * USD, 2);
    // A second, bigger position opened 5 hours later must not raise the first one's fee
    // for the hours already elapsed.
    set_price(&mut ketos, "NEAR", P4, T0_MS + 5 * HOUR_MS);
    set_depth_at(&mut ketos, "NEAR", measured_curve(), T0_MS + 5 * HOUR_MS);
    ctx_at("alice.test", T0_MS + 5 * HOUR_MS);
    ketos.open_position_now("NEAR".into(), Side::Long, U128(100 * USD), 5, None, None);
    ctx_at("alice.test", T0_MS + 5 * HOUR_MS);
    let fee = ketos.get_position(first.id).unwrap().borrow_fee.0;
    let rate = math::borrow_rate_per_hour(100 * USD, 100_000 * USD);
    assert_eq!(fee, (100 * USD * (rate * 5)).div_ceil(math::RATE_PRECISION));
}

#[test]
#[should_panic(expected = "ERR_STALE_PRICE")]
fn stale_price_is_refused() {
    let mut ketos = trading_setup();
    ctx_at("alice.test", T0_MS + 120_001);
    ketos.open_position_now("NEAR".into(), Side::Long, U128(100 * USD), 5, None, None);
}

#[test]
#[should_panic(expected = "ERR_STALE_PRICE")]
fn close_with_stale_price_is_refused() {
    let mut ketos = trading_setup();
    let p = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    ctx_at("alice.test", T0_MS + 121_000);
    ketos.close_position_now(p.id);
}

#[test]
#[should_panic(expected = "ERR_NO_PRICE")]
fn missing_price_is_refused() {
    let mut ketos = trading_setup();
    set_price(&mut ketos, "BTC", 0, T0_MS);
    set_depth_at(&mut ketos, "BTC", measured_curve(), T0_MS);
    ctx_at("alice.test", T0_MS);
    ketos.open_position_now("BTC".into(), Side::Long, U128(100 * USD), 2, None, None);
}

#[test]
#[should_panic(expected = "ERR_LEVERAGE_TOO_HIGH: max 5")]
fn leverage_above_market_max_is_refused() {
    let mut ketos = trading_setup();
    open(&mut ketos, "NEAR", Side::Long, 100 * USD, 6);
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT_MARGIN")]
fn margin_above_free_balance_is_refused() {
    let mut ketos = trading_setup();
    open(&mut ketos, "NEAR", Side::Long, 201 * USD, 2);
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn only_owner_can_close() {
    let mut ketos = trading_setup();
    let p = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    ctx_at("bob.test", T0_MS);
    ketos.close_position_now(p.id);
}

// Exit-liquidity caps

fn curve_up_to(capacity_usd: u64) -> Vec<DepthSample> {
    [1_000, 10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000]
        .into_iter()
        .map(|size_usd| DepthSample {
            size_usd,
            impact_bps: (size_usd <= capacity_usd).then_some(40),
        })
        .collect()
}

#[test]
fn depth_growth_is_bounded_while_decreases_and_closure_are_immediate() {
    let mut ketos = setup();
    ketos.vaults[VaultId::Core.index()].balance = 1_000_000 * USD;
    seed_depth(&mut ketos, "BTC", curve_up_to(1_000_000), T0_MS);
    assert_eq!(ketos.get_market("BTC".into()).unwrap().market.max_leverage, 20);
    let tiers = [(500_000, 10), (250_000, 10), (100_000, 5), (50_000, 5), (10_000, 2)];
    for (i, (capacity, leverage)) in tiers.into_iter().enumerate() {
        let at = T0_MS + (i as u64 + 1) * 60_000;
        set_depth_at(&mut ketos, "BTC", curve_up_to(capacity), at);
        let m = ketos.get_market("BTC".into()).unwrap();
        assert_eq!(m.market.max_leverage, leverage);
        assert_eq!(m.market.exit_capacity.0, capacity as u128 * USD);
        assert_eq!(m.max_oi_per_side.0, capacity as u128 * USD);
        assert!(m.is_open);
    }
    set_depth_at(&mut ketos, "BTC", curve_up_to(1_000), T0_MS + HOUR_MS);
    assert!(!ketos.get_market("BTC".into()).unwrap().is_open);
}

#[test]
fn size_beyond_exit_capacity_is_refused_with_remaining_cap() {
    let mut ketos = trading_setup();
    ketos.vaults[VaultId::LongTail.index()].balance = 100_000 * USD;
    deposit(&mut ketos, "whale.test", 30_000 * USD);
    ctx_at("whale.test", T0_MS);
    ketos.open_position_now("ZEC".into(), Side::Short, U128(12_000 * USD), 5, None, None);
    ctx_at("whale.test", T0_MS);
    let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ketos.open_position_now("ZEC".into(), Side::Short, U128(8_001 * USD), 5, None, None);
    }))
    .unwrap_err();
    let msg = err.downcast_ref::<String>().unwrap();
    assert!(msg.contains("ERR_EXCEEDS_EXIT_LIQUIDITY: cap 40000000000"), "{msg}");
    // Exactly the remaining cap fits; the other side has its own cap.
    ctx_at("whale.test", T0_MS);
    ketos.open_position_now("ZEC".into(), Side::Short, U128(8_000 * USD), 5, None, None);
    ctx_at("whale.test", T0_MS);
    ketos.open_position_now("ZEC".into(), Side::Long, U128(2_000 * USD), 5, None, None);
    let zec = ketos.get_market("ZEC".into()).unwrap().market;
    assert_eq!((zec.oi_short.0, zec.oi_long.0), (100_000 * USD, 10_000 * USD));
}

#[test]
fn market_closes_when_depth_is_older_than_30_minutes() {
    let mut ketos = trading_setup();
    let limit = T0_MS + 30 * 60_000;
    set_price(&mut ketos, "NEAR", P4, limit);
    ctx_at("alice.test", limit);
    assert!(ketos.get_market("NEAR".into()).unwrap().is_open);
    let p = ketos.open_position_now("NEAR".into(), Side::Long, U128(50 * USD), 5, None, None);

    set_price(&mut ketos, "NEAR", P4, limit + 1);
    ctx_at("alice.test", limit + 1);
    assert!(!ketos.get_market("NEAR".into()).unwrap().is_open);
    let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ketos.open_position_now("NEAR".into(), Side::Long, U128(50 * USD), 5, None, None);
    }))
    .unwrap_err();
    assert!(err
        .downcast_ref::<String>()
        .unwrap()
        .contains("ERR_MARKET_CLOSED: depth sample older than 30 minutes"));
    // Closing is never blocked by stale depth.
    ctx_at("alice.test", limit + 1);
    ketos.close_position_now(p.id);
}

#[test]
#[should_panic(expected = "ERR_MARKET_CLOSED: exit liquidity below $10,000")]
fn market_with_thin_exit_liquidity_takes_no_positions() {
    let mut ketos = trading_setup();
    set_depth_at(&mut ketos, "NEAR", curve_up_to(1_000), T0_MS + 1);
    set_price(&mut ketos, "NEAR", P4, T0_MS + 1);
    ctx_at("alice.test", T0_MS + 1);
    ketos.open_position_now("NEAR".into(), Side::Long, U128(10 * USD), 2, None, None);
}

#[test]
fn depth_history_keeps_the_last_48_samples() {
    let mut ketos = setup();
    for i in 0..50u64 {
        set_depth_at(&mut ketos, "ETH", curve_up_to(50_000), T0_MS + i * 60_000);
    }
    let depth = ketos.get_depth("ETH".into()).unwrap();
    assert_eq!(depth.history.len(), 48);
    assert_eq!(depth.history[0].measured_at_ms, T0_MS + 2 * 60_000);
    assert_eq!(depth.history[47].measured_at_ms, T0_MS + 49 * 60_000);
    assert_eq!(depth.history[47].exit_capacity_usd, 50_000);
    assert_eq!(depth.history[47].samples.len(), 7);
    assert_eq!(depth.market.market.depth_measured_at_ms, T0_MS + 49 * 60_000);
    assert!(ketos.get_depth("UNKNOWN".into()).is_none());
    assert!(ketos.get_depth("BTC".into()).unwrap().history.is_empty());
}

#[test]
#[should_panic(expected = "ERR_NOT_KEEPER")]
fn only_keeper_sets_depth() {
    let mut ketos = setup();
    ctx_at("alice.test", T0_MS);
    ketos.set_depth("BTC".into(), curve_up_to(1_000_000), T0_MS);
}

#[test]
#[should_panic(expected = "ERR_DEPTH_NOT_NEWER")]
fn older_depth_sample_is_refused() {
    let mut ketos = setup();
    set_depth_at(&mut ketos, "BTC", curve_up_to(100_000), T0_MS);
    set_depth_at(&mut ketos, "BTC", curve_up_to(1_000_000), T0_MS);
}

#[test]
#[should_panic(expected = "ERR_INVALID_SAMPLES: sizes must be strictly increasing")]
fn unsorted_samples_are_refused() {
    let mut ketos = setup();
    let mut samples = curve_up_to(100_000);
    samples.swap(0, 1);
    set_depth_at(&mut ketos, "BTC", samples, T0_MS);
}

// Liquidations

fn liquidate_at(ketos: &mut Ketos, position: u64, price: u128, now_ms: u64) -> LiquidationRecord {
    set_price(ketos, "NEAR", price, now_ms);
    ctx_at("bob.test", now_ms);
    ketos.liquidate_now(position)
}

#[test]
#[should_panic(expected = "ERR_POSITION_HEALTHY")]
fn healthy_position_cannot_be_liquidated() {
    let mut ketos = trading_setup();
    let p = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    // -7.5%: equity 61 USDC, maintenance 50.
    liquidate_at(&mut ketos, p.id, 370_000_000, T0_MS);
}

#[test]
#[should_panic(expected = "ERR_POSITION_HEALTHY")]
fn one_tick_above_liquidation_price_is_still_healthy() {
    let mut ketos = trading_setup();
    let p = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    liquidate_at(&mut ketos, p.id, p.liquidation_price.0 + 1, T0_MS);
}

#[test]
fn liquidation_at_the_liquidation_price_pays_penalty_reward_and_remainder() {
    let mut ketos = trading_setup();
    let p = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    assert_eq!(p.liquidation_price.0, 361_200_000);
    let r = liquidate_at(&mut ketos, p.id, p.liquidation_price.0, T0_MS);
    // Equity sits exactly on the 50 USDC maintenance: 1 to the liquidator, 5 to the vault.
    assert_eq!(r.equity.0, 50 * USD as i128);
    assert_eq!((r.reward.0, r.penalty.0, r.returned.0), (USD, 5 * USD, 44 * USD));
    assert_eq!(r.liquidator, id("bob.test"));
    assert_eq!(margin(&ketos, "bob.test"), USD);
    assert_eq!(margin(&ketos, "alice.test"), 100 * USD + 44 * USD);
    // Opening fee 1.5 + trader loss 48.5 + penalty 5.
    assert_eq!(ketos.vaults[0].balance, 10_055 * USD);
    assert_eq!(
        ketos.vaults[0].balance + margin(&ketos, "alice.test") + margin(&ketos, "bob.test"),
        10_200 * USD
    );
    assert!(ketos.get_position(p.id).is_none());
    assert!(ketos.get_positions(id("alice.test")).is_empty());
    assert_eq!(ketos.get_market("NEAR".into()).unwrap().market.oi_long.0, 0);
    assert!(near_sdk::test_utils::get_logs()
        .iter()
        .any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"event\":\"liquidation\"")));
    assert_eq!(ketos.get_liquidations(None), vec![r]);
}

#[test]
fn negative_equity_is_absorbed_by_the_vault() {
    let mut ketos = trading_setup();
    let p = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    // -25%: loss 125 USDC on 98.5 of margin.
    let r = liquidate_at(&mut ketos, p.id, 300_000_000, T0_MS);
    assert_eq!(r.equity.0, -26_500_000);
    assert_eq!((r.reward.0, r.penalty.0, r.returned.0), (0, 0, 0));
    assert_eq!(ketos.vaults[0].balance, 10_100 * USD);
    assert!(ketos.get_account(id("bob.test")).is_none());
    assert_eq!(margin(&ketos, "alice.test"), 100 * USD);
}

#[test]
fn short_is_liquidated_when_price_rises() {
    let mut ketos = trading_setup();
    ctx_at("alice.test", T0_MS);
    let p = ketos.open_position_now("NEAR".into(), Side::Short, U128(100 * USD), 5, None, None);
    assert_eq!(p.liquidation_price.0, 438_800_000);
    let r = liquidate_at(&mut ketos, p.id, 438_800_000, T0_MS);
    assert_eq!(r.side, Side::Short);
    assert_eq!(r.returned.0, 44 * USD);
}

#[test]
#[should_panic(expected = "ERR_STALE_PRICE")]
fn liquidation_needs_a_fresh_price() {
    let mut ketos = trading_setup();
    let p = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    set_price(&mut ketos, "NEAR", 300_000_000, T0_MS);
    ctx_at("bob.test", T0_MS + 120_001);
    ketos.liquidate_now(p.id);
}

#[test]
fn liquidation_history_keeps_the_last_20_newest_first() {
    let mut ketos = trading_setup();
    let ids: Vec<u64> = (0..22)
        .map(|_| open(&mut ketos, "NEAR", Side::Long, 2 * USD, 5).id)
        .collect();
    for id in &ids {
        liquidate_at(&mut ketos, *id, 300_000_000, T0_MS);
    }
    let history = ketos.get_liquidations(None);
    assert_eq!(history.len(), 20);
    assert_eq!(history[0].position_id, 21);
    assert_eq!(history[19].position_id, 2);
    let latest: Vec<u64> = ketos
        .get_liquidations(Some(3))
        .iter()
        .map(|r| r.position_id)
        .collect();
    assert_eq!(latest, [21, 20, 19]);
    assert_eq!(ketos.get_liquidations(Some(50)).len(), 20);
}

// LP vault

fn deposit_vault(ketos: &mut Ketos, lp: &str, amount: u128) {
    ctx_at(USDC, T0_MS);
    let PromiseOrValue::Value(unused) =
        ketos.ft_on_transfer(id(lp), U128(amount), "deposit_vault:core".into())
    else {
        panic!("vault deposit must resolve synchronously");
    };
    assert_eq!(unused, U128(0));
}

/// `trading_setup` with the vault funded by an LP deposit instead of a direct balance.
fn vault_setup() -> Ketos {
    let mut ketos = trading_setup();
    ketos.vaults[VaultId::Core.index()].balance = 0;
    deposit_vault(&mut ketos, "lp.test", 10_000 * USD);
    ketos
}

fn vault_at(ketos: &Ketos, now_ms: u64) -> crate::vault::VaultView {
    ctx_at("bob.test", now_ms);
    ketos.get_vault(VaultId::Core)
}

#[test]
fn first_vault_deposit_mints_shares_at_par() {
    let ketos = vault_setup();
    let v = vault_at(&ketos, T0_MS);
    assert_eq!(v.total_shares.0, 10_000 * USD);
    assert_eq!(v.nav.0, 10_000 * USD);
    assert_eq!(v.share_price.0, USD);
    assert_eq!((v.reserved.0, v.available.0), (0, 10_000 * USD));
    let lp = ketos.get_vault_account(VaultId::Core, id("lp.test"));
    assert_eq!((lp.shares.0, lp.value.0), (10_000 * USD, 10_000 * USD));
    assert_eq!(ketos.get_vault_account(VaultId::Core, id("bob.test")).shares.0, 0);
}

#[test]
fn deposit_after_trader_gains_mints_more_shares_below_par() {
    let mut ketos = vault_setup();
    open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    // NEAR +10%: traders are up 50 USDC, owed by the vault.
    set_price(&mut ketos, "NEAR", 440_000_000, T0_MS);
    let v = vault_at(&ketos, T0_MS);
    assert_eq!(v.traders_unrealized_pnl.0, 50 * USD as i128);
    assert_eq!(v.balance.0, 10_000 * USD + 1_500_000);
    assert_eq!(v.nav.0, 9_951_500_000);
    assert_eq!(v.share_price.0, 995_150);

    deposit_vault(&mut ketos, "lp2.test", 1_000 * USD);
    let lp2 = ketos.get_vault_account(VaultId::Core, id("lp2.test"));
    assert_eq!(lp2.shares.0, 1_000 * USD * 10_000 * USD / 9_951_500_000);
    assert!(lp2.shares.0 > 1_000 * USD);
    // Rounding favors the vault: the new LP's stake is worth at most what was deposited.
    assert!(lp2.value.0 <= 1_000 * USD && lp2.value.0 >= 1_000 * USD - 1);
}

#[test]
fn nav_includes_borrow_fees_due() {
    let mut ketos = vault_setup();
    let p = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    set_price(&mut ketos, "NEAR", P4, T0_MS + 10 * HOUR_MS);
    ctx_at("bob.test", T0_MS + 10 * HOUR_MS);
    let fee = ketos.get_position(p.id).unwrap().borrow_fee.0;
    let v = vault_at(&ketos, T0_MS + 10 * HOUR_MS);
    assert_eq!(v.borrow_fees_due.0, fee);
    assert_eq!(v.funding_net_due.0, 2_500_000);
    assert_eq!(v.nav.0, 10_000 * USD + 1_500_000 + fee + 2_500_000);
}

#[test]
fn vault_withdrawal_is_limited_to_unreserved_usdc() {
    let mut ketos = vault_setup();
    let p = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    let v = vault_at(&ketos, T0_MS);
    // Reserve the largest side plus a 10% buffer, not both gross sides.
    assert_eq!(v.reserved.0, 550 * USD);
    assert_eq!(v.available.0, 9_451_500_000);

    testing_env!(VMContextBuilder::new()
        .current_account_id(id(CONTRACT))
        .predecessor_account_id(id("lp.test"))
        .attached_deposit(NearToken::from_yoctonear(1))
        .block_timestamp(T0_MS * 1_000_000)
        .build());
    let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = ketos.withdraw_vault_now(VaultId::Core, U128(10_000 * USD));
    }))
    .unwrap_err();
    assert!(err
        .downcast_ref::<String>()
        .unwrap()
        .contains("ERR_VAULT_RESERVED: available 9451500000"));

    // A partial withdrawal within the unreserved balance goes through at NAV.
    let _ = ketos.withdraw_vault_now(VaultId::Core, U128(9_000 * USD));
    let lp = ketos.get_vault_account(VaultId::Core, id("lp.test"));
    assert_eq!(lp.shares.0, 1_000 * USD);
    assert_eq!(ketos.vaults[0].balance, 10_000 * USD + 1_500_000 - 9_001_350_000);
    let receipts = get_created_receipts();
    let MockAction::FunctionCallWeight { args, .. } = &receipts[0].actions[0] else {
        panic!("expected ft_transfer");
    };
    let args: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
    assert_eq!(args["amount"], "9001350000");

    // Once the position is closed nothing is reserved any more.
    close_at(&mut ketos, p.id, P4, T0_MS);
    let v = vault_at(&ketos, T0_MS);
    assert_eq!(v.reserved.0, 0);
    assert_eq!(v.available.0, v.balance.0);
}

#[test]
fn failed_vault_withdrawal_restores_shares() {
    let mut ketos = vault_setup();
    ctx("lp.test", 1);
    let _ = ketos.withdraw_vault_now(VaultId::Core, U128(4_000 * USD));
    assert_eq!(ketos.get_vault_account(VaultId::Core, id("lp.test")).shares.0, 6_000 * USD);
    ctx(CONTRACT, 0);
    let sent = ketos.on_vault_withdrawn(VaultId::Core, id("lp.test"),
    U128(4_000 * USD),
    U128(4_000 * USD),
    ketos.vaults[VaultId::Core.index()].share_epoch,
    Err(PromiseError::Failed),);
    assert_eq!(sent, U128(0));
    assert_eq!(ketos.get_vault_account(VaultId::Core, id("lp.test")).shares.0, 10_000 * USD);
    assert_eq!(ketos.vaults[0].balance, 10_000 * USD);
}

#[test]
fn fee_apr_annualizes_the_trailing_week() {
    let mut ketos = vault_setup();
    let p = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    let v = vault_at(&ketos, T0_MS);
    assert_eq!(v.fees_7d.0, 1_500_000);
    // 1.5 USDC × 365 / 7 over a 10,001.5 USDC NAV.
    assert_eq!(v.fee_apr_bps, 78);
    // Liquidation adds its penalty; a fully underwater position pays no fee.
    let r = liquidate_at(&mut ketos, p.id, p.liquidation_price.0, T0_MS);
    assert_eq!(vault_at(&ketos, T0_MS).fees_7d.0, 1_500_000 + r.penalty.0);
    assert_eq!(vault_at(&ketos, T0_MS + 7 * 24 * HOUR_MS).fees_7d.0, 0);
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT_SHARES")]
fn cannot_withdraw_more_shares_than_held() {
    let mut ketos = vault_setup();
    ctx("bob.test", 1);
    let _ = ketos.withdraw_vault_now(VaultId::Core, U128(1));
}

// Oracle

use crate::oracle::{to_price8, AssetOptionalPrice, OraclePrice, PriceData};
use near_sdk::json_types::U64;

const ORACLE: &str = "oracle.test";

fn price_data(at_ms: u64, prices: &[(&str, Option<(u128, u8)>)]) -> PriceData {
    PriceData {
        timestamp: U64(at_ms * 1_000_000),
        recency_duration_sec: 0,
        prices: prices
            .iter()
            .map(|(asset_id, price)| AssetOptionalPrice {
                asset_id: asset_id.to_string(),
                price: price.map(|(multiplier, decimals)| OraclePrice {
                    multiplier: U128(multiplier),
                    decimals,
                }),
            })
            .collect(),
    }
}

fn push_prices(ketos: &mut Ketos, from: &str, now_ms: u64, data: PriceData) {
    ctx_at(from, now_ms);
    ketos.oracle_on_call(id(CONTRACT), data, String::new());
}

fn stored_price(ketos: &Ketos, market: &str) -> (u128, u64) {
    let m = ketos.get_market(market.into()).unwrap().market;
    (m.price.0, m.price_timestamp_ms)
}


#[test]
#[should_panic(expected = "ERR_ORACLE_FUNDS_LOW")]
fn refresh_needs_the_oracle_deposit_in_free_balance() {
    let mut ketos = setup();
    testing_env!(VMContextBuilder::new()
        .current_account_id(id(CONTRACT))
        .predecessor_account_id(id("keeper.test"))
        .account_balance(NearToken::from_millinear(19))
        .storage_usage(0)
        .build());
    let _ = ketos.refresh_prices(None);
}

#[test]
#[should_panic(expected = "ERR_NOT_ORACLE")]
fn price_push_from_another_account_is_refused() {
    let mut ketos = setup();
    let data = price_data(T0_MS, &[("wrap.near", Some((1, 8)))]);
    push_prices(&mut ketos, "mallory.test", T0_MS, data);
}

#[test]
fn oracle_push_stores_8_decimal_prices_and_enables_trading() {
    let mut ketos = setup();
    deposit(&mut ketos, "alice.test", 200 * USD);
    ketos.vaults[VaultId::Core.index()].balance = 10_000 * USD;
    seed_depth(&mut ketos, "NEAR", measured_curve(), T0_MS);

    // Shapes seen on testnet (8 decimals), another precision, a missing price, an unlisted asset.
    let data = price_data(
        T0_MS - 1_500,
        &[
            ("nbtc.bridge.near", Some((7_756_150_000_000, 8))),
            ("aurora", Some((2_292_595_000_000_000, 12))),
            ("wrap.near", Some((382_231_700, 8))),
            ("zec.omft.near", None),
            ("token.rhealab.near", Some((53_000, 8))),
            ("22.contract.portalbridge.near", Some((15_000_000_000, 8))),
            (
                "aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near",
                Some((7_200_000, 8)),
            ),
            ("doge.near", Some((1, 8))),
        ],
    );
    push_prices(&mut ketos, ORACLE, T0_MS, data);
    assert_eq!(stored_price(&ketos, "BTC"), (7_756_150_000_000, T0_MS - 1_500));
    assert_eq!(stored_price(&ketos, "ETH"), (229_259_500_000, T0_MS - 1_500));
    assert_eq!(stored_price(&ketos, "NEAR"), (382_231_700, T0_MS - 1_500));
    assert_eq!(stored_price(&ketos, "ZEC"), (0, 0));
    assert_eq!(stored_price(&ketos, "SOL"), (15_000_000_000, T0_MS - 1_500));
    assert!(ketos.get_market("AURORA".into()).is_none());
    assert!(ketos.get_market("RHEA".into()).is_none());

    let prices = ketos.get_prices();
    assert_eq!(prices.len(), 14);
    assert!(prices.iter().find(|p| p.market_id == "NEAR").unwrap().is_fresh);
    assert!(!prices.iter().find(|p| p.market_id == "ZEC").unwrap().is_fresh);

    let p = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    assert_eq!(p.entry_price.0, 382_231_700);
}

#[test]
fn older_push_is_ignored_and_future_timestamps_are_clamped() {
    let mut ketos = setup();
    let future = price_data(T0_MS + 60_000, &[("wrap.near", Some((400_000_000, 8)))]);
    push_prices(&mut ketos, ORACLE, T0_MS, future);
    assert_eq!(stored_price(&ketos, "NEAR"), (400_000_000, T0_MS));

    let older = price_data(T0_MS - 1, &[("wrap.near", Some((300_000_000, 8)))]);
    push_prices(&mut ketos, ORACLE, T0_MS + 10, older);
    assert_eq!(stored_price(&ketos, "NEAR"), (400_000_000, T0_MS));

    let zero = price_data(T0_MS + 20, &[("wrap.near", Some((0, 8)))]);
    push_prices(&mut ketos, ORACLE, T0_MS + 20, zero);
    assert_eq!(stored_price(&ketos, "NEAR"), (400_000_000, T0_MS));

    // The price ages out for trading after 120 s.
    ctx_at("anyone.test", T0_MS + 120_001);
    assert!(!ketos.get_prices().iter().any(|p| p.is_fresh));
}

#[test]
fn tee_callback_cannot_price_a_signed_market() {
    let mut ketos = setup();
    ketos.register_market(extra_market("SIGNED", PriceSource::Signed));
    let data = price_data(T0_MS, &[("SIGNED.oracle", Some((P4, 8)))]);
    push_prices(&mut ketos, ORACLE, T0_MS, data);
    assert_eq!(stored_price(&ketos, "SIGNED"), (0, 0));
    assert!(!ketos.get_prices().iter().find(|p| p.market_id == "SIGNED").unwrap().is_fresh);
}

#[test]
fn oracle_prices_convert_to_8_decimals() {
    let p = |multiplier, decimals| to_price8(&OraclePrice { multiplier: U128(multiplier), decimals });
    assert_eq!(p(382_231_700, 8), Some(382_231_700));
    assert_eq!(p(38_223, 4), Some(382_230_000));
    assert_eq!(p(123_456_789, 10), Some(1_234_567));
    assert_eq!(p(u128::MAX, 0), None);
    assert_eq!(p(u128::MAX, 255), Some(0));
}
