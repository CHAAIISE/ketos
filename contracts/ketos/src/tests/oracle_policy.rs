use super::*;
use crate::oracle::{MIN_PRICE_REQUEST_INTERVAL_MS, ORACLE_CALL_DEPOSIT};
use crate::worker_prices::{WORKER_BATCH_SIZE, WORKER_DEPOSIT};
use std::panic::{catch_unwind, AssertUnwindSafe};

fn request_context(caller: &str, now_ms: u64, attached: NearToken, balance: NearToken) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(id(CONTRACT))
        .predecessor_account_id(id(caller))
        .block_timestamp(now_ms * 1_000_000)
        .attached_deposit(attached)
        .account_balance(balance.saturating_sub(attached))
        .storage_usage(0)
        .prepaid_gas(Gas::from_tgas(300))
        .build());
}

fn request_cost(ketos: &Ketos) -> NearToken {
    let workers = ketos.markets.values()
        .filter(|market| market.price_source == PriceSource::OutlayerWorker)
        .count();
    let tee_cost = if ketos.markets.values().any(|market| market.price_source == PriceSource::Tee) {
        ORACLE_CALL_DEPOSIT
    } else {
        NearToken::from_yoctonear(0)
    };
    tee_cost.saturating_add(
        WORKER_DEPOSIT.saturating_mul(workers.div_ceil(WORKER_BATCH_SIZE) as u128),
    )
}

fn assert_funded_receipts(cost: NearToken, refund: NearToken, caller: &str) {
    let mut spent = NearToken::from_yoctonear(0);
    let mut refunded = NearToken::from_yoctonear(0);
    for receipt in get_created_receipts() {
        for action in receipt.actions {
            match action {
                MockAction::FunctionCallWeight { attached_deposit, .. } => {
                    spent = spent.saturating_add(attached_deposit);
                }
                MockAction::Transfer { deposit, .. } => {
                    assert_eq!(receipt.receiver_id, id(caller));
                    refunded = refunded.saturating_add(deposit);
                }
                _ => {}
            }
        }
    }
    assert_eq!(spent, cost);
    assert_eq!(refunded, refund);
}

#[test]
fn first_request_at_zero_and_exact_interval_are_allowed() {
    let mut ketos = setup();
    assert_eq!(ketos.last_price_request_ms, None);
    let cost = request_cost(&ketos);
    request_context("alice.test", 0, cost, cost);
    drop(ketos.refresh_prices(None));
    assert_eq!(ketos.last_price_request_ms, Some(0));
    assert_funded_receipts(cost, NearToken::from_yoctonear(0), "alice.test");

    request_context("alice.test", MIN_PRICE_REQUEST_INTERVAL_MS, cost, cost);
    drop(ketos.refresh_prices(None));
    assert_eq!(ketos.last_price_request_ms, Some(MIN_PRICE_REQUEST_INTERVAL_MS));
}

#[test]
fn requests_before_interval_cannot_create_promises_or_move_the_lease() {
    let mut ketos = setup();
    let cost = request_cost(&ketos);
    request_context("alice.test", T0_MS, cost, cost);
    drop(ketos.refresh_prices(None));
    for now in [T0_MS, T0_MS + MIN_PRICE_REQUEST_INTERVAL_MS - 1, T0_MS - 1] {
        // The lease applies to every caller, including the privileged keeper.
        request_context("keeper.test", now, cost, cost);
        assert!(catch_unwind(AssertUnwindSafe(|| drop(ketos.refresh_prices(None)))).is_err());
        assert_eq!(ketos.last_price_request_ms, Some(T0_MS));
        assert!(get_created_receipts().is_empty());
    }
}

#[test]
fn public_caller_pays_full_cost_even_with_a_funded_treasury() {
    let mut ketos = setup();
    let cost = request_cost(&ketos);
    for attached in [NearToken::from_yoctonear(0), cost.saturating_sub(NearToken::from_yoctonear(1))] {
        request_context("alice.test", T0_MS, attached, NearToken::from_near(100));
        assert!(catch_unwind(AssertUnwindSafe(|| drop(ketos.refresh_prices(None)))).is_err());
        assert_eq!(ketos.last_price_request_ms, None);
        assert!(get_created_receipts().is_empty());
    }
}

#[test]
fn public_caller_funds_requests_without_spending_treasury_and_gets_excess_back() {
    let mut ketos = setup();
    let cost = request_cost(&ketos);
    let excess = NearToken::from_millinear(17);
    let attached = cost.saturating_add(excess);
    request_context("alice.test", T0_MS, attached, attached);
    drop(ketos.refresh_prices(None));
    assert_funded_receipts(cost, excess, "alice.test");
    assert_eq!(ketos.last_price_request_ms, Some(T0_MS));
}

#[test]
fn keeper_can_use_treasury_and_partial_funding_without_receiving_a_subsidy() {
    let mut ketos = setup();
    let cost = request_cost(&ketos);
    for (index, attached) in [NearToken::from_yoctonear(0), NearToken::from_millinear(1)]
        .into_iter().enumerate()
    {
        request_context("keeper.test", T0_MS + index as u64 * MIN_PRICE_REQUEST_INTERVAL_MS, attached, cost);
        drop(ketos.refresh_prices(None));
        assert_funded_receipts(cost, NearToken::from_yoctonear(0), "keeper.test");
    }
}

#[test]
fn keeper_overpayment_is_refunded_too() {
    let mut ketos = setup();
    let cost = request_cost(&ketos);
    let excess = NearToken::from_millinear(7);
    let attached = cost.saturating_add(excess);
    request_context("keeper.test", T0_MS, attached, attached);
    drop(ketos.refresh_prices(None));
    assert_funded_receipts(cost, excess, "keeper.test");
}

#[test]
fn refund_cannot_encroach_on_storage_locked_balance() {
    let mut ketos = setup();
    let cost = request_cost(&ketos);
    let attached = cost.saturating_add(NearToken::from_millinear(5));
    let storage_bytes = 10;
    let locked = near_sdk::env::storage_byte_cost().saturating_mul(storage_bytes as u128);
    let balance = attached.saturating_add(locked).saturating_sub(NearToken::from_yoctonear(1));
    let mut builder = VMContextBuilder::new();
    builder.current_account_id(id(CONTRACT))
        .predecessor_account_id(id("alice.test"))
        .attached_deposit(attached)
        .account_balance(balance.saturating_sub(attached))
        .storage_usage(storage_bytes)
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(builder.build());
    assert!(catch_unwind(AssertUnwindSafe(|| drop(ketos.refresh_prices(None)))).is_err());
    assert_eq!(ketos.last_price_request_ms, None);
    assert!(get_created_receipts().is_empty());
}

#[test]
fn cost_tracks_multiple_worker_batches_without_charging_an_unused_tee_adapter() {
    let mut ketos = setup();
    // The adapter supports these symbols; splitting them must charge each batch.
    let assets = crate::worker_prices::WORKER_ASSETS;
    for (index, market) in ketos.markets.values_mut().enumerate() {
        market.price_source = PriceSource::OutlayerWorker;
        market.oracle_asset_id = assets[index].into();
    }
    let cost = WORKER_DEPOSIT.saturating_mul(2);
    assert_eq!(request_cost(&ketos), cost);
    request_context("alice.test", T0_MS, cost, cost);
    drop(ketos.refresh_prices(None));
    assert_funded_receipts(cost, NearToken::from_yoctonear(0), "alice.test");
}

#[test]
fn no_worker_markets_charge_only_the_tee_deposit() {
    let mut ketos = setup();
    for market in ketos.markets.values_mut() {
        market.price_source = PriceSource::Tee;
    }
    request_context("alice.test", T0_MS, ORACLE_CALL_DEPOSIT, ORACLE_CALL_DEPOSIT);
    drop(ketos.refresh_prices(None));
    assert_funded_receipts(ORACLE_CALL_DEPOSIT, NearToken::from_yoctonear(0), "alice.test");
    assert!(!get_created_receipts().iter().any(|receipt| receipt.receiver_id == id("outlayer.test")));
}

fn conservative_data(raw_ms: u64, recency_sec: u32, price: u128) -> PriceData {
    let mut data = price_data(raw_ms, &[("wrap.near", Some((price, 8)))]);
    data.recency_duration_sec = recency_sec;
    data
}

#[test]
fn tee_recency_is_subtracted_before_future_clamping() {
    let mut ketos = setup();
    let data = conservative_data(T0_MS + 60_000, 300, P4);
    push_prices(&mut ketos, ORACLE, T0_MS, data);
    assert_eq!(stored_price(&ketos, "NEAR"), (P4, T0_MS - 240_000));
    assert!(!ketos.get_prices().iter().find(|price| price.market_id == "NEAR").unwrap().is_fresh);

    let future = conservative_data(T0_MS + 600_000, 300, P4 + 1);
    push_prices(&mut ketos, ORACLE, T0_MS, future);
    assert_eq!(stored_price(&ketos, "NEAR"), (P4 + 1, T0_MS));
}

#[test]
fn tee_recency_subtraction_saturates_and_nanoseconds_round_down() {
    let mut ketos = setup();
    let mut data = conservative_data(1, u32::MAX, P4);
    data.timestamp = U64(1_999_999);
    push_prices(&mut ketos, ORACLE, T0_MS, data);
    assert_eq!(stored_price(&ketos, "NEAR"), (P4, 0));

    let mut data = conservative_data(T0_MS, 1, P4 + 1);
    data.timestamp.0 += 999_999;
    push_prices(&mut ketos, ORACLE, T0_MS, data);
    assert_eq!(stored_price(&ketos, "NEAR"), (P4 + 1, T0_MS - 1_000));
}

#[test]
fn newer_reply_cannot_replay_an_older_conservative_observation() {
    let mut ketos = setup();
    push_prices(&mut ketos, ORACLE, T0_MS, conservative_data(T0_MS, 30, P4));
    let newer_reply = conservative_data(T0_MS + 1_000, 300, P4 * 2);
    push_prices(&mut ketos, ORACLE, T0_MS + 1_000, newer_reply);
    assert_eq!(stored_price(&ketos, "NEAR"), (P4, T0_MS - 30_000));
}

#[test]
fn get_prices_keeps_the_inclusive_120_second_freshness_boundary() {
    let mut ketos = setup();
    push_prices(&mut ketos, ORACLE, T0_MS, conservative_data(T0_MS, 120, P4));
    assert!(ketos.get_prices().iter().find(|price| price.market_id == "NEAR").unwrap().is_fresh);
    ctx_at("alice.test", T0_MS + 1);
    assert!(!ketos.get_prices().iter().find(|price| price.market_id == "NEAR").unwrap().is_fresh);
}

#[test]
fn forged_tee_push_cannot_change_prices_or_request_lease() {
    let mut ketos = setup();
    push_prices(&mut ketos, ORACLE, T0_MS, conservative_data(T0_MS, 0, P4));
    ketos.last_price_request_ms = Some(T0_MS);
    ctx_at("mallory.test", T0_MS + 1);
    let data = conservative_data(T0_MS + 1, 0, P4 * 2);
    assert!(catch_unwind(AssertUnwindSafe(|| {
        ketos.oracle_on_call(id(ORACLE), data, String::new());
    })).is_err());
    assert_eq!(stored_price(&ketos, "NEAR"), (P4, T0_MS));
    assert_eq!(ketos.last_price_request_ms, Some(T0_MS));
    assert!(get_created_receipts().is_empty());
}
