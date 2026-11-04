use super::*;
use crate::orders::{Brackets, EntryOrder, Order, OrderExecution, OrderRequest, MAX_OPEN_ORDERS};

fn entry(side: Side, trigger_price: u128, margin: u128, leverage: u32) -> EntryOrder {
    EntryOrder {
        market_id: "NEAR".into(),
        side,
        margin: U128(margin),
        leverage,
        trigger_price: U128(trigger_price),
        brackets: None,
    }
}

fn place(ketos: &mut Ketos, request: OrderRequest) -> Order {
    ctx_at("alice.test", T0_MS);
    ketos.place_order(request)
}

fn execute(ketos: &mut Ketos, ids: Vec<u64>, price: u128, now_ms: u64) -> Vec<OrderExecution> {
    set_price(ketos, "NEAR", price, now_ms);
    ctx_at("executor.test", now_ms);
    ketos.execute_orders(ids)
}

fn brackets() -> Brackets {
    Brackets {
        take_profit: Some(U128(440_000_000)),
        stop_loss: Some(U128(380_000_000)),
    }
}

#[test]
fn entry_reserves_margin_cancellation_releases_it_without_fees_or_oi() {
    let mut ketos = trading_setup();
    let vault = ketos.vault_usdc;
    let order = place(
        &mut ketos,
        OrderRequest::Limit(entry(Side::Long, 380_000_000, 100 * USD, 5)),
    );
    let account = ketos.get_account(id("alice.test")).unwrap();
    assert_eq!(
        (account.margin.0, account.reserved_margin.0),
        (100 * USD, 100 * USD)
    );
    assert_eq!(ketos.get_orders(id("alice.test")), vec![order.clone()]);
    assert_eq!(ketos.get_market("NEAR".into()).unwrap().market.oi_long.0, 0);
    assert_eq!(ketos.vault_usdc, vault);
    ketos.cancel_order(order.id);
    let account = ketos.get_account(id("alice.test")).unwrap();
    assert_eq!(
        (account.margin.0, account.reserved_margin.0),
        (200 * USD, 0)
    );
    assert!(ketos.get_orders(id("alice.test")).is_empty());
    assert_eq!(ketos.vault_usdc, vault);
}

#[test]
fn reserved_entry_margin_cannot_be_withdrawn() {
    let mut ketos = trading_setup();
    place(
        &mut ketos,
        OrderRequest::Limit(entry(Side::Long, P4, 150 * USD, 5)),
    );
    testing_env!(VMContextBuilder::new()
        .current_account_id(id(CONTRACT))
        .predecessor_account_id(id("alice.test"))
        .attached_deposit(NearToken::from_yoctonear(1))
        .block_timestamp(T0_MS * 1_000_000)
        .build());
    let error = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ketos.withdraw_margin(U128(51 * USD))
    }));
    assert!(error.is_err());
    assert_eq!(margin(&ketos, "alice.test"), 50 * USD);
    assert_eq!(
        ketos
            .get_account(id("alice.test"))
            .unwrap()
            .reserved_margin
            .0,
        150 * USD
    );
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn another_account_cannot_cancel_reserved_collateral() {
    let mut ketos = trading_setup();
    let order = place(
        &mut ketos,
        OrderRequest::Limit(entry(Side::Long, P4, 100 * USD, 5)),
    );
    ctx_at("stranger.test", T0_MS);
    ketos.cancel_order(order.id);
}

#[test]
fn limit_and_stop_entries_use_inclusive_opposite_triggers_for_both_sides() {
    let mut ketos = trading_setup();
    let orders = [
        place(
            &mut ketos,
            OrderRequest::Limit(entry(Side::Long, 380_000_000, 10 * USD, 2)),
        ),
        place(
            &mut ketos,
            OrderRequest::Limit(entry(Side::Short, 420_000_000, 10 * USD, 2)),
        ),
        place(
            &mut ketos,
            OrderRequest::StopMarket(entry(Side::Long, 420_000_000, 10 * USD, 2)),
        ),
        place(
            &mut ketos,
            OrderRequest::StopMarket(entry(Side::Short, 380_000_000, 10 * USD, 2)),
        ),
    ];
    let ids: Vec<_> = orders.iter().map(|o| o.id).collect();
    assert!(execute(&mut ketos, ids.clone(), P4, T0_MS)
        .iter()
        .all(|r| matches!(r, OrderExecution::Skipped { .. })));
    assert_eq!(
        ketos
            .get_account(id("alice.test"))
            .unwrap()
            .reserved_margin
            .0,
        40 * USD
    );
    let low = execute(&mut ketos, ids.clone(), 380_000_000, T0_MS);
    assert!(matches!(
        low[0],
        OrderExecution::Filled {
            price: U128(380_000_000),
            ..
        }
    ));
    assert!(matches!(low[1], OrderExecution::Skipped { .. }));
    assert!(matches!(low[2], OrderExecution::Skipped { .. }));
    assert!(matches!(low[3], OrderExecution::Filled { .. }));
    let high = execute(&mut ketos, ids, 420_000_000, T0_MS);
    assert!(matches!(high[1], OrderExecution::Filled { .. }));
    assert!(matches!(high[2], OrderExecution::Filled { .. }));
    let positions = ketos.get_positions(id("alice.test"));
    assert_eq!(
        positions
            .iter()
            .map(|p| (p.side, p.entry_price.0))
            .collect::<Vec<_>>(),
        [
            (Side::Long, 380_000_000),
            (Side::Short, 380_000_000),
            (Side::Short, 420_000_000),
            (Side::Long, 420_000_000),
        ]
    );
    assert!(positions
        .iter()
        .all(|p| p.account_id == id("alice.test") && p.margin.0 == 9_980_000));
    assert_eq!(
        ketos
            .get_account(id("alice.test"))
            .unwrap()
            .reserved_margin
            .0,
        0
    );
    assert!(ketos.get_positions(id("executor.test")).is_empty());
    assert_eq!(ketos.vault_usdc, 10_000 * USD + 80_000);
}

#[test]
fn gap_executes_at_current_oracle_price_and_duplicates_do_not_double_fill() {
    let mut ketos = trading_setup();
    let order = place(
        &mut ketos,
        OrderRequest::Limit(entry(Side::Long, 390_000_000, 100 * USD, 5)),
    );
    let results = execute(
        &mut ketos,
        vec![order.id, order.id, u64::MAX],
        370_000_000,
        T0_MS,
    );
    assert_eq!(
        results,
        vec![
            OrderExecution::Filled {
                order_id: order.id,
                position_id: 0,
                price: U128(370_000_000)
            },
            OrderExecution::Skipped { order_id: order.id },
            OrderExecution::Skipped { order_id: u64::MAX },
        ]
    );
    assert_eq!(
        ketos.get_positions(id("alice.test"))[0].entry_price.0,
        370_000_000
    );
    assert_eq!(margin(&ketos, "alice.test"), 100 * USD);
    assert_eq!(
        ketos.get_market("NEAR".into()).unwrap().market.oi_long.0,
        500 * USD
    );
}

#[test]
fn stale_or_missing_price_never_fills_or_releases_reserved_margin() {
    let mut ketos = trading_setup();
    let order = place(
        &mut ketos,
        OrderRequest::Limit(entry(Side::Long, P4, 100 * USD, 5)),
    );
    ctx_at("executor.test", T0_MS + 120_001);
    assert_eq!(
        ketos.execute_orders(vec![order.id]),
        vec![OrderExecution::Skipped { order_id: order.id }]
    );
    assert_eq!(
        execute(&mut ketos, vec![order.id], 0, T0_MS + 120_001),
        vec![OrderExecution::Skipped { order_id: order.id }]
    );
    assert_eq!(
        ketos
            .get_account(id("alice.test"))
            .unwrap()
            .reserved_margin
            .0,
        100 * USD
    );
    assert!(matches!(
        execute(&mut ketos, vec![order.id], P4, T0_MS + 120_001)[0],
        OrderExecution::Filled { .. }
    ));
}

#[test]
fn cap_is_checked_sequentially_at_fill_and_rejection_refunds_only_that_entry() {
    let mut ketos = trading_setup();
    deposit(&mut ketos, "alice.test", 30_000 * USD);
    let first = place(
        &mut ketos,
        OrderRequest::Limit(entry(Side::Long, P4, 12_000 * USD, 5)),
    );
    let second = place(
        &mut ketos,
        OrderRequest::Limit(entry(Side::Long, P4, 12_000 * USD, 5)),
    );
    let third = place(
        &mut ketos,
        OrderRequest::Limit(entry(Side::Short, P4, 100 * USD, 5)),
    );
    let result = execute(&mut ketos, vec![first.id, second.id, third.id], P4, T0_MS);
    assert!(matches!(result[0], OrderExecution::Filled { .. }));
    assert_eq!(
        result[1],
        OrderExecution::Rejected {
            order_id: second.id,
            reason: "ERR_EXCEEDS_EXIT_LIQUIDITY: cap 40000000000".into()
        }
    );
    assert!(matches!(result[2], OrderExecution::Filled { .. }));
    assert_eq!(margin(&ketos, "alice.test"), 18_100 * USD);
    assert_eq!(
        ketos
            .get_account(id("alice.test"))
            .unwrap()
            .reserved_margin
            .0,
        0
    );
    assert_eq!(ketos.vault_usdc, 10_000 * USD + 60_500_000);
    assert_eq!(ketos.get_positions(id("alice.test")).len(), 2);
    assert!(ketos.get_orders(id("alice.test")).is_empty());
}

#[test]
fn tightened_leverage_and_stale_depth_reject_and_refund_triggered_entries() {
    let mut ketos = trading_setup();
    let leveraged = place(
        &mut ketos,
        OrderRequest::Limit(entry(Side::Long, P4, 100 * USD, 5)),
    );
    let stale = place(
        &mut ketos,
        OrderRequest::Limit(entry(Side::Long, P4, 100 * USD, 2)),
    );
    set_depth_at(
        &mut ketos,
        "NEAR",
        vec![DepthSample {
            size_usd: 10_000,
            impact_bps: Some(20),
        }],
        T0_MS + 1,
    );
    assert_eq!(
        execute(&mut ketos, vec![leveraged.id], P4, T0_MS + 1),
        vec![OrderExecution::Rejected {
            order_id: leveraged.id,
            reason: "ERR_LEVERAGE_TOO_HIGH: max 2".into(),
        }]
    );
    assert_eq!(
        execute(&mut ketos, vec![stale.id], P4, T0_MS + 1_800_002),
        vec![OrderExecution::Rejected {
            order_id: stale.id,
            reason: "ERR_MARKET_CLOSED: depth sample older than 30 minutes".into(),
        }]
    );
    assert_eq!(margin(&ketos, "alice.test"), 200 * USD);
    assert_eq!(ketos.vault_usdc, 10_000 * USD);
}

#[test]
fn long_stop_loss_closes_once_and_cancels_sibling_take_profit() {
    let mut ketos = trading_setup();
    ctx_at("alice.test", T0_MS);
    let position = ketos.open_position(
        "NEAR".into(),
        Side::Long,
        U128(100 * USD),
        5,
        Some(brackets()),
    );
    let tp = position.take_profit.unwrap();
    let sl = position.stop_loss.unwrap();
    assert_eq!(
        ketos
            .get_account(id("alice.test"))
            .unwrap()
            .reserved_margin
            .0,
        0
    );
    let result = execute(&mut ketos, vec![tp, sl, tp, sl], 380_000_000, T0_MS);
    assert_eq!(
        result,
        vec![
            OrderExecution::Skipped { order_id: tp },
            OrderExecution::Filled {
                order_id: sl,
                position_id: position.id,
                price: U128(380_000_000)
            },
            OrderExecution::Skipped { order_id: tp },
            OrderExecution::Skipped { order_id: sl }
        ]
    );
    assert!(ketos.get_position(position.id).is_none());
    assert!(ketos.get_orders(id("alice.test")).is_empty());
    assert_eq!(margin(&ketos, "alice.test"), 174 * USD);
    assert_eq!(ketos.get_market("NEAR".into()).unwrap().market.oi_long.0, 0);
    assert_eq!(
        ketos.vault_usdc + margin(&ketos, "alice.test"),
        10_200 * USD
    );
}

#[test]
fn short_take_profit_closes_at_threshold_and_cancels_stop_loss() {
    let mut ketos = trading_setup();
    ctx_at("alice.test", T0_MS);
    let position = ketos.open_position(
        "NEAR".into(),
        Side::Short,
        U128(100 * USD),
        5,
        Some(Brackets {
            take_profit: Some(U128(380_000_000)),
            stop_loss: Some(U128(440_000_000)),
        }),
    );
    let tp = position.take_profit.unwrap();
    let sl = position.stop_loss.unwrap();
    let result = execute(&mut ketos, vec![tp, sl], 380_000_000, T0_MS);
    assert!(matches!(result[0], OrderExecution::Filled { .. }));
    assert_eq!(result[1], OrderExecution::Skipped { order_id: sl });
    assert_eq!(margin(&ketos, "alice.test"), 224 * USD);
    assert!(ketos.get_orders(id("alice.test")).is_empty());
}

#[test]
fn pending_entry_attaches_brackets_only_after_fill_and_manual_close_cleans_them() {
    let mut ketos = trading_setup();
    let mut request = entry(Side::Long, P4, 100 * USD, 5);
    request.brackets = Some(brackets());
    let order = place(&mut ketos, OrderRequest::Limit(request));
    assert_eq!(ketos.get_orders(id("alice.test")), vec![order.clone()]);
    execute(&mut ketos, vec![order.id], P4, T0_MS);
    let position = ketos.get_positions(id("alice.test"))[0].clone();
    assert!(position.take_profit.is_some() && position.stop_loss.is_some());
    ctx_at("alice.test", T0_MS);
    ketos.close_position(position.id);
    assert!(ketos.get_orders(id("alice.test")).is_empty());
    assert_eq!(margin(&ketos, "alice.test"), 199 * USD);
}

#[test]
fn liquidation_cleans_brackets_without_refunding_position_collateral_twice() {
    let mut ketos = trading_setup();
    ctx_at("alice.test", T0_MS);
    let position = ketos.open_position(
        "NEAR".into(),
        Side::Long,
        U128(100 * USD),
        5,
        Some(brackets()),
    );
    set_price(&mut ketos, "NEAR", 350_000_000, T0_MS);
    ctx_at("executor.test", T0_MS);
    let liquidation = ketos.liquidate(position.id);
    assert!(ketos.get_orders(id("alice.test")).is_empty());
    assert_eq!(
        margin(&ketos, "alice.test"),
        100 * USD + liquidation.returned.0
    );
    assert_eq!(
        ketos.vault_usdc + margin(&ketos, "alice.test") + margin(&ketos, "executor.test"),
        10_200 * USD
    );
    assert_eq!(
        ketos.execute_orders(vec![position.stop_loss.unwrap()]),
        vec![OrderExecution::Skipped {
            order_id: position.stop_loss.unwrap()
        }]
    );
}

#[test]
fn cancelled_exit_can_be_replaced_without_changing_position_margin() {
    let mut ketos = trading_setup();
    let position = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    let sl = place(
        &mut ketos,
        OrderRequest::StopLoss {
            position_id: position.id,
            trigger_price: U128(380_000_000),
        },
    );
    ketos.cancel_order(sl.id);
    assert_eq!(ketos.get_position(position.id).unwrap().stop_loss, None);
    let tp = place(
        &mut ketos,
        OrderRequest::TakeProfit {
            position_id: position.id,
            trigger_price: U128(440_000_000),
        },
    );
    let result = execute(&mut ketos, vec![tp.id], 440_000_000, T0_MS);
    assert!(matches!(result[0], OrderExecution::Filled { .. }));
    assert_eq!(margin(&ketos, "alice.test"), 249 * USD);
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn cannot_place_an_exit_on_another_accounts_position() {
    let mut ketos = trading_setup();
    let position = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    deposit(&mut ketos, "stranger.test", USD);
    ctx_at("stranger.test", T0_MS);
    ketos.place_order(OrderRequest::StopLoss {
        position_id: position.id,
        trigger_price: U128(380_000_000),
    });
}

#[test]
#[should_panic(expected = "ERR_EXIT_ORDER_EXISTS")]
fn duplicate_exit_is_rejected_instead_of_orphaning_first_order() {
    let mut ketos = trading_setup();
    ctx_at("alice.test", T0_MS);
    let position = ketos.open_position(
        "NEAR".into(),
        Side::Long,
        U128(100 * USD),
        5,
        Some(brackets()),
    );
    ketos.place_order(OrderRequest::StopLoss {
        position_id: position.id,
        trigger_price: U128(390_000_000),
    });
}

#[test]
fn gap_past_attached_stop_rejects_entry_atomically_without_charging_fees() {
    let mut ketos = trading_setup();
    let mut request = entry(Side::Long, P4, 100 * USD, 5);
    request.brackets = Some(brackets());
    let order = place(&mut ketos, OrderRequest::Limit(request));
    assert_eq!(
        execute(&mut ketos, vec![order.id], 370_000_000, T0_MS),
        vec![OrderExecution::Rejected {
            order_id: order.id,
            reason: "ERR_INVALID_STOP_LOSS".into(),
        }]
    );
    assert_eq!(margin(&ketos, "alice.test"), 200 * USD);
    assert_eq!(ketos.vault_usdc, 10_000 * USD);
    assert!(ketos.get_positions(id("alice.test")).is_empty());
    assert!(ketos.get_orders(id("alice.test")).is_empty());
}

#[test]
#[should_panic(expected = "ERR_TOO_MANY_ORDERS")]
fn account_order_limit_includes_exit_orders() {
    let mut ketos = trading_setup();
    for _ in 0..MAX_OPEN_ORDERS {
        place(
            &mut ketos,
            OrderRequest::Limit(entry(Side::Long, P4, USD, 1)),
        );
        ctx_at("alice.test", T0_MS);
    }
    ketos.open_position(
        "NEAR".into(),
        Side::Long,
        U128(10 * USD),
        5,
        Some(brackets()),
    );
}

#[test]
#[should_panic(expected = "ERR_ORDER_BATCH_TOO_LARGE")]
fn execution_batch_bound_is_enforced_before_mutation() {
    let mut ketos = trading_setup();
    ketos.execute_orders(vec![0; 51]);
}
