use super::*;
use crate::cross::MarginMode;
use crate::orders::{Brackets, OrderExecution};
use crate::pull_prices::PullAction;
use crate::wallet_trading::{WalletOpenRequest, WalletOrderKind, WalletOrderRequest};
use near_sdk::serde_json::{json, Value};

fn bounds(price: u128, expires_at_ms: u64) -> ExecutionBounds {
    ExecutionBounds { limit_price: U128(price), expires_at_ms }
}

fn value(result: PromiseOrValue<Value>) -> Value {
    match result { PromiseOrValue::Value(value) => value, _ => panic!("expected settled callback") }
}

fn assert_directional_execution(mode: MarginMode) {
    let mut ketos = trading_setup();
    let mut positions = Vec::new();
    for side in [Side::Long, Side::Short] {
        ctx_at("alice.test", T0_MS);
        let margin_before = margin(&ketos, "alice.test");
        let vault_before = ketos.vaults.get(&VaultId::Core).unwrap().balance;
        let market_before = ketos.get_market("NEAR".into()).unwrap().market;
        let bad = if side == Side::Long { P4 - 1 } else { P4 + 1 };
        let rejected = ketos.try_open_position_for(id("alice.test"), "NEAR".into(), side,
            U128(10 * USD), 2, None, mode, bounds(bad, T0_MS), None);
        assert_eq!(rejected.unwrap_err(), "ERR_EXECUTION_PRICE_LIMIT");
        assert_eq!(margin(&ketos, "alice.test"), margin_before);
        assert_eq!(ketos.vaults.get(&VaultId::Core).unwrap().balance, vault_before);
        let market_after = ketos.get_market("NEAR".into()).unwrap().market;
        assert_eq!((market_after.oi_long, market_after.oi_short), (market_before.oi_long, market_before.oi_short));
        let opened = ketos.try_open_position_for(id("alice.test"), "NEAR".into(), side,
            U128(10 * USD), 2, None, mode, bounds(P4, T0_MS), None).unwrap();
        assert_eq!(opened.entry_price.0, P4);
        positions.push((side, opened.id));
    }
    for (side, id) in positions {
        let bad = if side == Side::Long { P4 + 1 } else { P4 - 1 };
        let before = near_sdk::borsh::to_vec(ketos.positions.get(&id).unwrap()).unwrap();
        assert_eq!(ketos.close_position_for(crate::tests::id("alice.test"), id, P4, T0_MS,
            false, bounds(bad, T0_MS)).err().as_deref(), Some("ERR_EXECUTION_PRICE_LIMIT"));
        assert_eq!(near_sdk::borsh::to_vec(ketos.positions.get(&id).unwrap()).unwrap(), before);
        assert!(matches!(ketos.close_position_for(crate::tests::id("alice.test"), id, P4, T0_MS,
            false, bounds(P4, T0_MS)), Ok(PromiseOrValue::Value(_))));
    }
    let market = ketos.get_market("NEAR".into()).unwrap().market;
    assert_eq!((market.oi_long.0, market.oi_short.0), (0, 0));
    assert!(ketos.get_positions(id("alice.test")).is_empty());
    assert_eq!(margin(&ketos, "alice.test") + ketos.vaults.get(&VaultId::Core).unwrap().balance, 10_200 * USD);
}

#[test]
fn isolated_entries_and_exits_enforce_both_directions_and_accept_equality() {
    assert_directional_execution(MarginMode::Isolated);
}

#[test]
fn cross_entries_and_exits_enforce_both_directions_and_accept_equality() {
    assert_directional_execution(MarginMode::Cross);
}

fn wallet_action(side: Side, execution: ExecutionBounds) -> PullAction {
    PullAction::WalletOpen {
        account_id: id("alice.test"), amount: U128(50 * USD),
        request: WalletOpenRequest {
            market_id: "NEAR".into(), side, margin: Some(U128(50 * USD)), leverage: 2,
            margin_mode: MarginMode::Isolated, brackets: None, signed_prices: None,
            execution, bracket_bounds: None,
        },
    }
}

fn assert_wallet_rejection(side: Side, price: u128, expires_after_request: u64) {
    let mut ketos = trading_setup();
    let requested = T0_MS + 20_000;
    let now = requested + 1_000;
    let history = ketos.get_history(id("alice.test"), None, None);
    ctx_at("alice.test", requested);
    let action_id = ketos.reserve_price_action();
    let action = wallet_action(side, bounds(P4, requested + expires_after_request));
    set_price(&mut ketos, "NEAR", price, now);
    ctx_at(CONTRACT, now);
    let refund = value(ketos.on_action_prices(action_id, action.clone(), vec![("NEAR".into(), T0_MS)], requested, Ok(json!(true))));
    assert_eq!(refund, json!((50 * USD).to_string()));
    let repeated = value(ketos.on_action_prices(action_id, action, vec![("NEAR".into(), T0_MS)], requested, Ok(json!(true))));
    assert_eq!(repeated, json!("0"));
    assert_eq!(margin(&ketos, "alice.test"), 200 * USD);
    assert_eq!(ketos.vaults.get(&VaultId::Core).unwrap().balance, 10_000 * USD);
    let market = ketos.get_market("NEAR".into()).unwrap().market;
    assert_eq!((market.oi_long.0, market.oi_short.0), (0, 0));
    assert!(ketos.get_positions(id("alice.test")).is_empty());
    assert_eq!(ketos.get_history(id("alice.test"), None, None), history);
}

#[test]
fn adverse_long_callback_refunds_exactly_once_without_spending_existing_margin() {
    assert_wallet_rejection(Side::Long, P4 + 1, 2_000);
}

#[test]
fn adverse_short_callback_refunds_exactly_once_without_spending_existing_margin() {
    assert_wallet_rejection(Side::Short, P4 - 1, 2_000);
}

#[test]
fn callback_expiry_refunds_even_when_the_execution_price_is_acceptable() {
    assert_wallet_rejection(Side::Long, P4, 999);
}

#[test]
fn successful_wallet_callback_cannot_duplicate_a_position_or_charge_twice() {
    let mut ketos = trading_setup();
    let requested = T0_MS + 20_000;
    let now = requested + 1_000;
    let action_id = ketos.reserve_price_action();
    let action = wallet_action(Side::Long, bounds(P4, now));
    set_price(&mut ketos, "NEAR", P4, now);
    ctx_at(CONTRACT, now);
    assert_eq!(value(ketos.on_action_prices(action_id, action.clone(), vec![("NEAR".into(), T0_MS)], requested, Ok(json!(true)))), json!("0"));
    let history = ketos.get_history(id("alice.test"), None, None);
    assert_eq!(value(ketos.on_action_prices(action_id, action, vec![("NEAR".into(), T0_MS)], requested, Ok(json!(true)))), json!("0"));
    let positions = ketos.get_positions(id("alice.test"));
    assert_eq!(positions.len(), 1);
    assert_eq!(positions[0].size.0, 100 * USD);
    assert_eq!(positions[0].margin.0, 49_700_000);
    assert_eq!(margin(&ketos, "alice.test"), 200 * USD);
    assert_eq!(ketos.vaults.get(&VaultId::Core).unwrap().balance, 10_000 * USD + 300_000);
    assert_eq!(ketos.get_market("NEAR".into()).unwrap().market.oi_long.0, 100 * USD);
    assert_eq!(ketos.get_history(id("alice.test"), None, None), history);
}

#[test]
fn rejected_direct_callback_cannot_fill_later_when_the_price_recovers() {
    let mut ketos = trading_setup();
    let requested = T0_MS + 20_000;
    let action_id = ketos.reserve_price_action();
    let action = PullAction::Open {
        account_id: id("alice.test"), market_id: "NEAR".into(), side: Side::Long,
        margin: U128(50 * USD), leverage: 2, brackets: None, margin_mode: MarginMode::Isolated,
        execution: bounds(P4, requested + 10_000), bracket_bounds: None,
    };
    set_price(&mut ketos, "NEAR", P4 + 1, requested + 1);
    ctx_at(CONTRACT, requested + 1);
    let refused = value(ketos.on_action_prices(action_id, action.clone(), vec![("NEAR".into(), T0_MS)], requested, Ok(json!(true))));
    assert_eq!(refused["error"], "ERR_EXECUTION_PRICE_LIMIT");
    set_price(&mut ketos, "NEAR", P4, requested + 2);
    ctx_at(CONTRACT, requested + 2);
    let replay = value(ketos.on_action_prices(action_id, action, vec![("NEAR".into(), T0_MS)], requested, Ok(json!(true))));
    assert_eq!(replay["error"], "ERR_ACTION_ALREADY_SETTLED");
    assert_eq!(margin(&ketos, "alice.test"), 200 * USD);
    assert_eq!(ketos.get_market("NEAR".into()).unwrap().market.oi_long.0, 0);
    assert!(ketos.get_positions(id("alice.test")).is_empty());
}

#[test]
fn exit_callback_cannot_sell_below_the_signed_floor() {
    let mut ketos = trading_setup();
    let position = open(&mut ketos, "NEAR", Side::Long, 50 * USD, 2);
    let requested = T0_MS + 20_000;
    let action_id = ketos.reserve_price_action();
    let action = PullAction::Close {
        account_id: id("alice.test"), position_id: position.id, to_wallet: true,
        execution: bounds(P4, requested + 10_000),
    };
    set_price(&mut ketos, "NEAR", P4 - 1, requested + 1);
    ctx_at(CONTRACT, requested + 1);
    let refused = value(ketos.on_action_prices(action_id, action, vec![("NEAR".into(), T0_MS)], requested, Ok(json!(true))));
    assert_eq!(refused["error"], "ERR_EXECUTION_PRICE_LIMIT");
    assert_eq!(ketos.get_position(position.id).unwrap().size, position.size);
    assert_eq!(margin(&ketos, "alice.test"), 150 * USD);
    assert_eq!(ketos.get_market("NEAR".into()).unwrap().market.oi_long.0, 100 * USD);
    assert!(get_created_receipts().is_empty());
}

fn assert_wallet_order_refund(expired: bool) {
    let mut ketos = trading_setup();
    let brackets = Brackets { take_profit: Some(U128(500_000_000)), stop_loss: Some(U128(300_000_000)) };
    let request = WalletOrderRequest {
        kind: if expired { WalletOrderKind::Limit } else { WalletOrderKind::StopMarket },
        trigger_price: U128(if expired { P4 - 1 } else { P4 + 1 }),
        entry: WalletOpenRequest {
            market_id: "NEAR".into(), side: Side::Long, margin: Some(U128(50 * USD)), leverage: 2,
            margin_mode: MarginMode::Isolated, bracket_bounds: bracket_execution(Side::Long, Some(&brackets)),
            brackets: Some(brackets), signed_prices: None,
            execution: bounds(P4 + 2, if expired { T0_MS + 500 } else { T0_MS + 60_000 }),
        },
    };
    ctx_at(USDC, T0_MS);
    assert_eq!(ketos.receive_wallet_order(id("alice.test"), U128(51 * USD), request), U128(700_000));
    let order_id = ketos.get_orders(id("alice.test"))[0].id;
    let now = if expired { T0_MS + 600_000 } else { T0_MS + 1_000 };
    if !expired { set_price(&mut ketos, "NEAR", P4 + 3, now); }
    ctx_at("executor.test", now);
    let expected = if expired { "ERR_EXECUTION_EXPIRED" } else { "ERR_EXECUTION_PRICE_LIMIT" };
    assert_eq!(ketos.execute_orders_for(id("executor.test"), vec![order_id], false), vec![
        OrderExecution::Rejected { order_id, reason: expected.into() },
    ]);
    assert_margin_wallet_transfer(50_300_000);
    assert_eq!(margin(&ketos, "alice.test"), 200 * USD);
    assert_eq!(ketos.get_account(id("alice.test")).unwrap().reserved_margin, U128(0));
    assert!(ketos.get_orders(id("alice.test")).is_empty());
    assert!(ketos.get_positions(id("alice.test")).is_empty());
    assert!(ketos.accounts.get(&id("executor.test")).is_none());
    assert_eq!(ketos.vaults.get(&VaultId::Core).unwrap().balance, 10_000 * USD);
}

#[test]
fn expired_wallet_order_refunds_collateral_and_all_rewards_without_a_fresh_price() {
    assert_wallet_order_refund(true);
}

#[test]
fn a_crossed_stop_cannot_violate_execution_limit_and_refunds_wallet_reservations() {
    assert_wallet_order_refund(false);
}
