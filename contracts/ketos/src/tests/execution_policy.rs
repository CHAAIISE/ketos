use super::*;
use crate::cross::MarginMode;
use crate::history::HistoryKind;
use crate::orders::{Brackets, EntryOrder, OrderExecution, OrderRequest};

fn limit(margin: u128, leverage: u32) -> OrderRequest {
    OrderRequest::Limit(EntryOrder {
        market_id: "NEAR".into(), side: Side::Long, margin: U128(margin), leverage,
        trigger_price: U128(P4), brackets: None, margin_mode: MarginMode::Isolated,
    })
}

#[test]
fn opening_age_boundary_applies_to_market_cross_and_pending_entries() {
    for mode in [MarginMode::Isolated, MarginMode::Cross] {
        let mut ketos = trading_setup();
        ctx_at("alice.test", T0_MS + 30_000);
        let p = ketos.open_position_now("NEAR".into(), Side::Long, U128(10 * USD), 2, None, Some(mode));
        assert_eq!(p.entry_price.0, P4);
        ctx_at("alice.test", T0_MS + 30_001);
        assert_eq!(ketos.try_open_position_for(id("alice.test"), "NEAR".into(), Side::Short, U128(10 * USD), 2, None, mode).unwrap_err(), "ERR_STALE_PRICE");
        let order = ketos.place_order_now(limit(10 * USD, 2));
        let reserved = ketos.get_account(id("alice.test")).unwrap().reserved_margin;
        ctx_at("executor.test", T0_MS + 30_001);
        assert_eq!(ketos.execute_orders_now(vec![order.id]), vec![OrderExecution::Skipped { order_id: order.id }]);
        assert_eq!(ketos.get_account(id("alice.test")).unwrap().reserved_margin, reserved);
        let market = ketos.get_market("NEAR".into()).unwrap();
        assert!(market.close_only);
        // Reset storage between independent contract instances in this test.
        drop(ketos);
        near_sdk::mock::with_mocked_blockchain(|b| { b.take_storage(); });
    }
}

#[test]
fn stale_close_has_adverse_spread_boundaries_and_never_reopens_or_liquidates() {
    let ketos = trading_setup();
    let market = ketos.markets.get("NEAR").unwrap();
    for side in [Side::Long, Side::Short] {
        assert_eq!(market.closing_price(T0_MS + 120_000), Ok(P4));
        assert_eq!(market.closing_price(T0_MS + 120_001), Err("ERR_STALE_PRICE"));
        for (age, bps) in [(15_001, 50u128), (600_000, 50), (600_001, 100), (1_200_000, 100), (1_200_001, 150), (3_000_001, 300), (u64::MAX - T0_MS, 300)] {
            let price = if side == Side::Long { P4 * (10_000 - bps) / 10_000 } else { (P4 * (10_000 + bps)).div_ceil(10_000) };
            assert_eq!(market.failed_pull_close_price(side, T0_MS + age), price);
            assert_eq!(market.stale_close_spread_bps(T0_MS + age), bps as u32);
        }
    }
}

#[test]
fn stale_owner_closes_settle_isolated_and_cross_with_conservation() {
    for mode in [MarginMode::Isolated, MarginMode::Cross] {
        let mut ketos = trading_setup();
        ctx_at("alice.test", T0_MS);
        let p = ketos.open_position_now("NEAR".into(), Side::Long, U128(100 * USD), 5, None, Some(mode));
        ctx_at("alice.test", T0_MS + 600_001);
        let near_sdk::PromiseOrValue::Value(value) = ketos.execute_priced_action(
            crate::pull_prices::PullAction::Close { account_id: id("alice.test"), position_id: p.id, to_wallet: false }, true,
        ).unwrap() else { panic!("close must settle"); };
        let payout: U128 = near_sdk::serde_json::from_value(value).unwrap();
        let payout = payout.0;
        assert!(payout < p.margin.0 - 2_500_000);
        let close = ketos.get_history(id("alice.test"), None, None).into_iter().find(|e| e.kind == HistoryKind::Close).unwrap();
        assert_eq!(close.price.0, 396_000_000);
        assert_eq!(ketos.vaults[0].balance + margin(&ketos, "alice.test"), 10_200 * USD);
        assert!(ketos.get_position(p.id).is_none());
        drop(ketos);
        near_sdk::mock::with_mocked_blockchain(|b| { b.take_storage(); });
    }
}

#[test]
fn entry_reward_is_reserved_paid_once_and_accounted_without_extra_volume() {
    let mut ketos = trading_setup();
    ctx_at("alice.test", T0_MS);
    let order = ketos.place_order_now(limit(100 * USD, 5));
    assert_eq!(order.execution_reward.0, 250_000);
    assert_eq!(ketos.get_account(id("alice.test")).unwrap().reserved_margin.0, 100_250_000);
    assert_eq!(margin(&ketos, "alice.test"), 99_750_000);
    ctx_at("executor.test", T0_MS);
    let result = ketos.execute_orders_now(vec![order.id, order.id]);
    assert!(matches!(result[0], OrderExecution::Filled { .. }));
    assert_eq!(result[1], OrderExecution::Skipped { order_id: order.id });
    assert_eq!(margin(&ketos, "executor.test"), 250_000);
    let p = ketos.get_positions(id("alice.test"))[0].clone();
    assert_eq!(p.size.0, 500 * USD);
    assert_eq!(p.margin.0, 98_500_000);
    let stats = ketos.get_account_stats(id("alice.test")).unwrap();
    assert_eq!(stats.realized_pnl.0, -1_750_000);
    assert_eq!((stats.volume.0, stats.trades), (500 * USD, 1));
    ctx_at("alice.test", T0_MS);
    ketos.close_position_now(p.id);
    assert_eq!(ketos.vaults[0].balance + margin(&ketos, "alice.test") + margin(&ketos, "executor.test"), 10_200 * USD);
    let history = ketos.get_history(id("alice.test"), None, None);
    let realized: i128 = history.iter().map(|e| e.realized_pnl.0).sum();
    assert_eq!(ketos.get_account_stats(id("alice.test")).unwrap().realized_pnl.0, realized);
}

#[test]
fn minimum_reward_refunds_on_cancel_and_rejection_without_executor_income() {
    let mut ketos = trading_setup();
    ctx_at("alice.test", T0_MS);
    let first = ketos.place_order_now(limit(USD, 1));
    assert_eq!(first.execution_reward.0, USD / 10);
    let _ = ketos.cancel_order(first.id, Some(false));
    assert_eq!(margin(&ketos, "alice.test"), 200 * USD);
    let second = ketos.place_order_now(limit(100 * USD, 5));
    ketos.markets.get_mut("NEAR").unwrap().exit_capacity = U128(0);
    ctx_at("executor.test", T0_MS);
    assert!(matches!(ketos.execute_orders_now(vec![second.id])[0], OrderExecution::Rejected { .. }));
    assert_eq!(margin(&ketos, "alice.test"), 200 * USD);
    assert_eq!(margin(&ketos, "executor.test"), 0);
    assert_eq!(ketos.get_account(id("alice.test")).unwrap().reserved_margin.0, 0);
}

#[test]
fn stale_exit_uses_only_last_observed_trigger_and_refunds_sibling_reward() {
    let mut ketos = trading_setup();
    ctx_at("alice.test", T0_MS);
    let p = ketos.open_position_now("NEAR".into(), Side::Long, U128(100 * USD), 5, Some(Brackets {
        take_profit: Some(U128(440_000_000)), stop_loss: Some(U128(398_500_000)),
    }), None);
    assert_eq!(ketos.get_account(id("alice.test")).unwrap().reserved_margin.0, 500_000);
    ctx_at("executor.test", T0_MS + 600_001);
    // Spread alone would cross SL, but an unobserved move must not trigger the order.
    let sl = p.stop_loss.unwrap();
    assert_eq!(ketos.execute_orders_for(id("executor.test"), vec![sl], true), vec![OrderExecution::Skipped { order_id: sl }]);
    set_price(&mut ketos, "NEAR", 398_000_000, T0_MS);
    let result = ketos.execute_orders_for(id("executor.test"), vec![sl, p.take_profit.unwrap()], true);
    assert!(matches!(result[0], OrderExecution::Filled { price: U128(394_020_000), .. }));
    assert!(ketos.get_orders(id("alice.test")).is_empty());
    assert_eq!(ketos.get_account(id("alice.test")).unwrap().reserved_margin.0, 0);
    assert_eq!(margin(&ketos, "executor.test"), 250_000);
    assert_eq!(ketos.vaults[0].balance + margin(&ketos, "alice.test") + margin(&ketos, "executor.test"), 10_200 * USD);
}

#[test]
fn latest_curve_charges_both_sides_to_the_assigned_vault_and_close_view() {
    let mut ketos = trading_setup();
    let p = open(&mut ketos, "NEAR", Side::Short, 100 * USD, 5);
    assert_eq!(p.margin.0, 98_500_000);
    assert_eq!(p.close_fee.0, 1_500_000);
    set_depth_at(&mut ketos, "NEAR", vec![DepthSample { size_usd: 100_000, impact_bps: Some(80) }], T0_MS + 1);
    assert_eq!(ketos.get_position(p.id).unwrap().close_fee.0, 4_500_000);
    ctx_at("alice.test", T0_MS + 1);
    let payout = ketos.close_position_now(p.id).0;
    assert!(payout <= 94 * USD && payout >= 94 * USD - 2);
    assert_eq!(ketos.vaults[0].balance + margin(&ketos, "alice.test"), 10_200 * USD);
    assert_eq!(ketos.vaults[1].balance, 10_000 * USD);
}

#[test]
fn fees_that_consume_the_collateral_reject_before_mutating_cross_or_oi() {
    let mut ketos = trading_setup();
    // A once-open market may have an old curve that no longer supports this size.
    ketos.depth.remove(&"NEAR".to_string());
    ketos.markets.get_mut("NEAR").unwrap().fee_bps = 10_000;
    ctx_at("alice.test", T0_MS);
    let before = margin(&ketos, "alice.test");
    let result = ketos.try_open_position_for(
        id("alice.test"), "NEAR".into(), Side::Long, U128(USD), 1, None, MarginMode::Cross,
    );
    assert_eq!(result.unwrap_err(), "ERR_FEES_EXCEED_MARGIN");
    assert_eq!(margin(&ketos, "alice.test"), before);
    assert_eq!(ketos.get_cross_account(id("alice.test")).position_count, 0);
    assert_eq!(ketos.get_market("NEAR".into()).unwrap().market.oi_long.0, 0);
}
