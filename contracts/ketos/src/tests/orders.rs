use super::*;
use crate::orders::{Brackets, EntryOrder, Order, OrderExecution, OrderRequest, MAX_OPEN_ORDERS};

fn entry(side: Side, trigger_price: u128, margin: u128, leverage: u32) -> EntryOrder {
    EntryOrder { market_id: "NEAR".into(),
    side,
    margin: U128(margin),
    leverage,
    trigger_price: U128(trigger_price),
    brackets: None, margin_mode: crate::cross::MarginMode::Isolated }
}

fn place(ketos: &mut Ketos, request: OrderRequest) -> Order {
    ctx_at("alice.test", T0_MS);
    ketos.place_order_now(request)
}

fn execute(ketos: &mut Ketos, ids: Vec<u64>, price: u128, now_ms: u64) -> Vec<OrderExecution> {
    set_price(ketos, "NEAR", price, now_ms);
    ctx_at("executor.test", now_ms);
    ketos.execute_orders_now(ids)
}

fn brackets() -> Brackets {
    Brackets {
        take_profit: Some(U128(440_000_000)),
        stop_loss: Some(U128(380_000_000)),
    }
}

fn wallet_order(ketos: &mut Ketos, request: EntryOrder) -> Order {
    let reserve = crate::orders::execution_reward(request.margin.0 * u128::from(request.leverage))
        * request.brackets.as_ref().map_or(0, Brackets::count) as u128;
    let mut order = place(ketos, OrderRequest::Limit(request));
    let account = ketos.accounts.get_mut(&id("alice.test")).unwrap();
    assert!(account.margin >= reserve);
    account.margin -= reserve;
    account.reserved_margin += reserve;
    order.wallet_funded = true;
    order.bracket_reserve = U128(reserve);
    ketos.orders.insert(order.id, order.clone());
    order
}

#[test]
fn default_cancel_sends_only_released_collateral_and_restores_it_on_failure() {
    let mut ketos = trading_setup();
    let mut request = entry(Side::Long, P4, 100 * USD, 5);
    request.brackets = Some(brackets());
    let order = wallet_order(&mut ketos, request);
    let before = margin(&ketos, "alice.test");
    let released = 100_750_000;
    ctx_at("alice.test", T0_MS);
    assert!(matches!(ketos.cancel_order(order.id, None), PromiseOrValue::Promise(_)));
    assert_eq!(margin(&ketos, "alice.test"), before);
    assert_eq!(ketos.get_account(id("alice.test")).unwrap().reserved_margin.0, 0);
    assert!(ketos.get_orders(id("alice.test")).is_empty());
    assert_margin_wallet_transfer(released);

    ctx_at(CONTRACT, T0_MS + 1);
    assert_eq!(ketos.on_margin_withdrawn(
        id("alice.test"), U128(released), Err(PromiseError::Failed),
    ), U128(0));
    assert_eq!(margin(&ketos, "alice.test"), 200 * USD);
}

#[test]
fn explicit_cancel_retention_returns_the_entire_released_amount() {
    let mut ketos = trading_setup();
    let order = place(&mut ketos, OrderRequest::Limit(entry(Side::Long, P4, 100 * USD, 5)));
    ctx_at("alice.test", T0_MS);
    let PromiseOrValue::Value(released) = ketos.cancel_order(order.id, Some(false)) else {
        panic!("retained cancellation must not transfer");
    };
    assert_eq!(released, U128(100_250_000));
    assert_eq!(margin(&ketos, "alice.test"), 200 * USD);
    assert!(get_created_receipts().is_empty());
}

#[test]
fn manual_close_releases_bracket_rewards_without_touching_prior_free_margin() {
    for to_wallet in [None, Some(false)] {
        let mut ketos = trading_setup();
        ctx_at("alice.test", T0_MS);
        let position = ketos.open_position_now(
            "NEAR".into(), Side::Long, U128(100 * USD), 5, Some(brackets()), None,
        );
        let before = margin(&ketos, "alice.test");
        let expected = 97_500_000;
        ctx_at("alice.test", T0_MS);
        match ketos.close_position(position.id, to_wallet, None) {
            PromiseOrValue::Promise(promise) => {
                assert_eq!(to_wallet, None);
                promise.detach();
                assert_eq!(margin(&ketos, "alice.test"), before);
                assert_margin_wallet_transfer(expected);
                ctx_at(CONTRACT, T0_MS + 1);
                assert_eq!(ketos.on_margin_withdrawn(
                    id("alice.test"), U128(expected), Err(PromiseError::Failed),
                ), U128(0));
                assert_eq!(margin(&ketos, "alice.test"), before + expected);
            }
            PromiseOrValue::Value(released) => {
                assert_eq!(to_wallet, Some(false));
                assert_eq!(released, U128(expected));
                assert_eq!(margin(&ketos, "alice.test"), before + expected);
                assert!(get_created_receipts().is_empty());
            }
        }
        assert!(ketos.get_position(position.id).is_none());
        assert!(ketos.get_orders(id("alice.test")).is_empty());
        assert_eq!(ketos.get_account(id("alice.test")).unwrap().reserved_margin.0, 0);
        drop(ketos);
        near_sdk::mock::with_mocked_blockchain(|blockchain| { blockchain.take_storage(); });
    }
}

#[test]
fn zero_close_payout_does_not_create_a_token_transfer() {
    let mut ketos = trading_setup();
    let position = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    set_price(&mut ketos, "NEAR", P4 / 2, T0_MS);
    ctx_at("alice.test", T0_MS);
    let PromiseOrValue::Value(released) = ketos.close_position(position.id, None, None) else {
        panic!("zero settlement must not transfer");
    };
    assert_eq!(released, U128(0));
    assert_eq!(margin(&ketos, "alice.test"), 100 * USD);
    assert!(get_created_receipts().is_empty());
}

#[test]
fn all_funds_wallet_entry_preserves_future_bracket_rewards_until_fill() {
    let mut ketos = trading_setup();
    ctx("alice.test", 1);
    ketos.withdraw_margin(U128(99_250_000)).detach();
    let mut request = entry(Side::Long, P4, 100 * USD, 5);
    request.brackets = Some(brackets());
    let order = wallet_order(&mut ketos, request);
    assert_eq!(margin(&ketos, "alice.test"), 0);
    assert_eq!(order.bracket_reserve, U128(500_000));
    let result = execute(&mut ketos, vec![order.id], P4, T0_MS);
    assert!(matches!(result[0], OrderExecution::Filled { .. }));
    assert_eq!(margin(&ketos, "alice.test"), 0);
    assert_eq!(margin(&ketos, "executor.test"), 250_000);
    assert_eq!(ketos.get_account(id("alice.test")).unwrap().reserved_margin.0, 500_000);
    let position = ketos.get_positions(id("alice.test"))[0].clone();
    assert!(position.take_profit.is_some() && position.stop_loss.is_some());
    assert!(get_created_receipts().is_empty());
}

#[test]
fn rejected_wallet_entries_return_all_reservations_not_preexisting_margin() {
    for delisted in [false, true] {
        let mut ketos = trading_setup();
        let mut request = entry(Side::Long, P4, 100 * USD, 5);
        request.brackets = Some(brackets());
        let order = wallet_order(&mut ketos, request);
        let before = margin(&ketos, "alice.test");
        if delisted {
            ketos.markets.get_mut("NEAR").unwrap().created_at_ms = T0_MS + 1;
        } else {
            ketos.markets.get_mut("NEAR").unwrap().max_leverage = 1;
        }
        let result = execute(&mut ketos, vec![order.id], P4, T0_MS);
        assert!(matches!(result[0], OrderExecution::Rejected { .. }));
        assert_eq!(margin(&ketos, "alice.test"), before);
        assert_eq!(margin(&ketos, "executor.test"), 0);
        assert_eq!(ketos.get_account(id("alice.test")).unwrap().reserved_margin.0, 0);
        assert!(ketos.get_orders(id("alice.test")).is_empty());
        assert!(ketos.get_positions(id("alice.test")).is_empty());
        assert_margin_wallet_transfer(100_750_000);
        drop(ketos);
        near_sdk::mock::with_mocked_blockchain(|blockchain| { blockchain.take_storage(); });
    }
}

#[test]
fn entry_reserves_margin_cancellation_releases_it_without_fees_or_oi() {
    let mut ketos = trading_setup();
    let vault = ketos.vaults[VaultId::Core.index()].balance;
    let order = place(
        &mut ketos,
        OrderRequest::Limit(entry(Side::Long, 380_000_000, 100 * USD, 5)),
    );
    let account = ketos.get_account(id("alice.test")).unwrap();
    assert_eq!(
        (account.margin.0, account.reserved_margin.0),
        (99_750_000, 100_250_000)
    );
    assert_eq!(ketos.get_orders(id("alice.test")), vec![order.clone()]);
    assert_eq!(ketos.get_market("NEAR".into()).unwrap().market.oi_long.0, 0);
    assert_eq!(ketos.vaults[0].balance, vault);
    let _ = ketos.cancel_order(order.id, Some(false));
    let account = ketos.get_account(id("alice.test")).unwrap();
    assert_eq!(
        (account.margin.0, account.reserved_margin.0),
        (200 * USD, 0)
    );
    assert!(ketos.get_orders(id("alice.test")).is_empty());
    assert_eq!(ketos.vaults[0].balance, vault);
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
    assert_eq!(margin(&ketos, "alice.test"), 49_625_000);
    assert_eq!(
        ketos
            .get_account(id("alice.test"))
            .unwrap()
            .reserved_margin
            .0,
        150_375_000
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
    let _ = ketos.cancel_order(order.id, Some(false));
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
        40_400_000
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
        .all(|p| p.account_id == id("alice.test") && p.margin.0 == 9_940_000));
    assert_eq!(
        ketos
            .get_account(id("alice.test"))
            .unwrap()
            .reserved_margin
            .0,
        0
    );
    assert!(ketos.get_positions(id("executor.test")).is_empty());
    assert_eq!(ketos.vaults[0].balance, 10_000 * USD + 240_000);
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
    assert_eq!(margin(&ketos, "alice.test"), 99_750_000);
    assert_eq!(margin(&ketos, "executor.test"), 250_000);
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
        ketos.execute_orders_now(vec![order.id]),
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
        100_250_000
    );
    assert!(matches!(
        execute(&mut ketos, vec![order.id], P4, T0_MS + 120_001)[0],
        OrderExecution::Filled { .. }
    ));
}

#[test]
fn cap_is_checked_sequentially_at_fill_and_rejection_refunds_only_that_entry() {
    let mut ketos = trading_setup();
    ketos.vaults[VaultId::Core.index()].balance = 60_000 * USD;
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
    assert_eq!(margin(&ketos, "alice.test"), 18_069_750_000);
    assert_eq!(
        ketos
            .get_account(id("alice.test"))
            .unwrap()
            .reserved_margin
            .0,
        0
    );
    assert_eq!(ketos.vaults[0].balance, 60_000 * USD + 218_700_000);
    assert_eq!(ketos.get_positions(id("alice.test")).len(), 2);
    assert!(ketos.get_orders(id("alice.test")).is_empty());
}

#[test]
fn tightened_leverage_and_stale_depth_reject_and_refund_triggered_entries() {
    let mut ketos = trading_setup();
    deposit(&mut ketos, "alice.test", USD);
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
    assert_eq!(margin(&ketos, "alice.test"), 201 * USD);
    assert_eq!(ketos.vaults[0].balance, 10_000 * USD);
}

#[test]
fn long_stop_loss_closes_once_and_cancels_sibling_take_profit() {
    let mut ketos = trading_setup();
    ctx_at("alice.test", T0_MS);
    let position = ketos.open_position_now("NEAR".into(), Side::Long, U128(100 * USD), 5, Some(brackets()), None);
    let tp = position.take_profit.unwrap();
    let sl = position.stop_loss.unwrap();
    assert_eq!(
        ketos
            .get_account(id("alice.test"))
            .unwrap()
            .reserved_margin
            .0,
        500_000
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
    assert_eq!(margin(&ketos, "alice.test"), 171_750_000);
    assert_eq!(ketos.get_market("NEAR".into()).unwrap().market.oi_long.0, 0);
    assert_eq!(
        ketos.vaults[0].balance + margin(&ketos, "alice.test") + margin(&ketos, "executor.test"),
        10_200 * USD
    );
}

#[test]
fn short_take_profit_closes_at_threshold_and_cancels_stop_loss() {
    let mut ketos = trading_setup();
    ctx_at("alice.test", T0_MS);
    let position = ketos.open_position_now("NEAR".into(), Side::Short, U128(100 * USD), 5, Some(Brackets {
        take_profit: Some(U128(380_000_000)),
        stop_loss: Some(U128(440_000_000)),
    }), None);
    let tp = position.take_profit.unwrap();
    let sl = position.stop_loss.unwrap();
    let result = execute(&mut ketos, vec![tp, sl], 380_000_000, T0_MS);
    assert!(matches!(result[0], OrderExecution::Filled { .. }));
    assert_eq!(result[1], OrderExecution::Skipped { order_id: sl });
    assert_eq!(margin(&ketos, "alice.test"), 221_750_000);
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
    ketos.close_position_now(position.id);
    assert!(ketos.get_orders(id("alice.test")).is_empty());
    assert_eq!(margin(&ketos, "alice.test"), 196_750_000);
}

#[test]
fn liquidation_cleans_brackets_without_refunding_position_collateral_twice() {
    let mut ketos = trading_setup();
    ctx_at("alice.test", T0_MS);
    let position = ketos.open_position_now("NEAR".into(), Side::Long, U128(100 * USD), 5, Some(brackets()), None);
    set_price(&mut ketos, "NEAR", 350_000_000, T0_MS);
    ctx_at("executor.test", T0_MS);
    let liquidation = ketos.liquidate_now(position.id);
    assert!(ketos.get_orders(id("alice.test")).is_empty());
    assert_eq!(
        margin(&ketos, "alice.test"),
        100 * USD + liquidation.returned.0
    );
    assert_eq!(
        ketos.vaults[0].balance + margin(&ketos, "alice.test") + margin(&ketos, "executor.test"),
        10_200 * USD
    );
    assert_eq!(
        ketos.execute_orders_now(vec![position.stop_loss.unwrap()]),
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
    let _ = ketos.cancel_order(sl.id, Some(false));
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
    assert_eq!(margin(&ketos, "alice.test"), 246_750_000);
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn cannot_place_an_exit_on_another_accounts_position() {
    let mut ketos = trading_setup();
    let position = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    deposit(&mut ketos, "stranger.test", USD);
    ctx_at("stranger.test", T0_MS);
    ketos.place_order_now(OrderRequest::StopLoss {
        position_id: position.id,
        trigger_price: U128(380_000_000),
    });
}

#[test]
#[should_panic(expected = "ERR_EXIT_ORDER_EXISTS")]
fn duplicate_exit_is_rejected_instead_of_orphaning_first_order() {
    let mut ketos = trading_setup();
    ctx_at("alice.test", T0_MS);
    let position = ketos.open_position_now("NEAR".into(), Side::Long, U128(100 * USD), 5, Some(brackets()), None);
    ketos.place_order_now(OrderRequest::StopLoss {
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
    assert_eq!(ketos.vaults[0].balance, 10_000 * USD);
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
    ketos.open_position_now("NEAR".into(), Side::Long, U128(10 * USD), 5, Some(brackets()), None);
}

#[test]
#[should_panic(expected = "ERR_ORDER_BATCH_TOO_LARGE")]
fn execution_batch_bound_is_enforced_before_mutation() {
    let mut ketos = trading_setup();
    ketos.execute_orders_now(vec![0; 51]);
}
