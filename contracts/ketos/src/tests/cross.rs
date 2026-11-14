use super::*;
use crate::cross::{MarginMode, MAX_CROSS_POSITIONS};
use crate::orders::{Brackets, EntryOrder, OrderExecution, OrderRequest};

fn cross_setup() -> Ketos {
    let mut ketos = trading_setup();
    ketos.vaults.get_mut(&VaultId::LongTail).unwrap().balance = 10_000 * USD;
    ketos
}

fn cross_open(
    ketos: &mut Ketos,
    market: &str,
    side: Side,
    collateral: u128,
    leverage: u32,
) -> PositionView {
    ctx_at("alice.test", T0_MS);
    ketos.open_position_now(market.into(),
    side,
    U128(collateral),
    leverage,
    None,
    Some(MarginMode::Cross),)
}

fn health(ketos: &Ketos) -> crate::cross::CrossAccountView {
    ketos.get_cross_account(id("alice.test"))
}

fn assert_backed(ketos: &Ketos, total: u128) {
    let accounts = ["alice.test", "keeper.test", "bob.test"];
    let mut liabilities = 0i128;
    for trader in accounts {
        if let Some(account) = ketos.accounts.get(&id(trader)) {
            liabilities +=
                math::to_i128(account.margin + account.reserved_margin) + account.cross_cash;
            liabilities += account
                .positions
                .iter()
                .map(|id| math::to_i128(ketos.positions.get(id).unwrap().margin))
                .sum::<i128>();
            assert_eq!(
                account.cross_debt.iter().sum::<u128>(),
                account.cross_cash.min(0).unsigned_abs()
            );
        }
    }
    for (vault_id, vault) in ketos.vaults.iter() {
        liabilities += math::to_i128(vault.balance);
        assert!(vault.cross_receivable <= vault.balance);
        assert_eq!(
            vault.cross_receivable,
            accounts
                .iter()
                .filter_map(|a| ketos.accounts.get(&id(a)))
                .map(|a| if vault_id.is_market() { 0 } else { a.cross_debt[vault_id.shared_index()] })
                .sum::<u128>()
        );
    }
    assert_eq!(liabilities, math::to_i128(total));
}

#[test]
fn wallet_cross_close_keeps_partial_cash_and_releases_actual_final_balance() {
    for gain_first in [false, true] {
        for to_wallet in [None, Some(false)] {
            let mut ketos = cross_setup();
            deposit(&mut ketos, "alice.test", 50 * USD);
            let long = cross_open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
            let short = cross_open(&mut ketos, "ZEC", Side::Short, 100 * USD, 5);
            set_price(&mut ketos, "NEAR", P4 / 2, T0_MS);
            set_price(&mut ketos, "ZEC", P4 / 2, T0_MS);
            let (first, last) = if gain_first { (short.id, long.id) } else { (long.id, short.id) };
            ctx_at("alice.test", T0_MS);
            let PromiseOrValue::Value(released) = ketos.close_position(first, to_wallet, None, close_execution_for_test(&ketos, first)) else {
                panic!("cash behind surviving cross positions must not be withdrawn");
            };
            assert_eq!(released, U128(0));
            assert_eq!(margin(&ketos, "alice.test"), 50 * USD);
            assert_eq!(health(&ketos).cash.0, if gain_first { 347 * USD as i128 } else { -(153 * USD as i128) });
            assert_eq!(health(&ketos).position_count, 1);
            assert!(get_created_receipts().is_empty());
            assert_backed(&ketos, 20_250 * USD);

            ctx_at("alice.test", T0_MS);
            match ketos.close_position(last, to_wallet, None, close_execution_for_test(&ketos, last)) {
                PromiseOrValue::Promise(promise) => {
                    assert_eq!(to_wallet, None);
                    promise.detach();
                    assert_eq!(margin(&ketos, "alice.test"), 50 * USD);
                    assert_margin_wallet_transfer(194 * USD);
                    assert_backed(&ketos, (20_250 - 194) * USD);
                    ctx_at(CONTRACT, T0_MS + 1);
                    ketos.on_margin_withdrawn(
                        id("alice.test"), U128(194 * USD), Err(PromiseError::Failed),
                    );
                }
                PromiseOrValue::Value(released) => {
                    assert_eq!(to_wallet, Some(false));
                    assert_eq!(released, U128(194 * USD));
                    assert!(get_created_receipts().is_empty());
                }
            }
            assert_eq!(margin(&ketos, "alice.test"), 244 * USD);
            assert_eq!(health(&ketos).cash.0, 0);
            assert_eq!(health(&ketos).debt_by_vault, [U128(0); 2]);
            assert_eq!(health(&ketos).position_count, 0);
            assert_backed(&ketos, 20_250 * USD);
            drop(ketos);
            near_sdk::mock::with_mocked_blockchain(|blockchain| { blockchain.take_storage(); });
        }
    }
}

#[test]
fn partial_cross_wallet_close_returns_only_unused_bracket_rewards() {
    let mut ketos = cross_setup();
    deposit(&mut ketos, "alice.test", USD);
    ctx_at("alice.test", T0_MS);
    let first = ketos.open_position_now(
        "NEAR".into(), Side::Long, U128(100 * USD), 5,
        Some(Brackets { take_profit: Some(U128(P4 * 2)), stop_loss: Some(U128(P4 / 2)) }),
        Some(MarginMode::Cross),
    );
    let last = cross_open(&mut ketos, "ZEC", Side::Short, 100 * USD, 5);
    ctx_at("alice.test", T0_MS);
    assert!(matches!(ketos.close_position(first.id, None, None, close_execution_for_test(&ketos, first.id)), PromiseOrValue::Promise(_)));
    assert_margin_wallet_transfer(500_000);
    assert_eq!(margin(&ketos, "alice.test"), 500_000);
    assert_eq!(health(&ketos).cash.0, 97 * USD as i128);
    assert_eq!(health(&ketos).position_count, 1);
    assert!(ketos.get_position(last.id).is_some());
    assert_eq!(ketos.get_account(id("alice.test")).unwrap().reserved_margin.0, 0);
    assert_backed(&ketos, 20_201 * USD - 500_000);
}

#[test]
fn cross_health_offsets_multi_position_losses_without_free_or_isolated_margin() {
    let mut ketos = cross_setup();
    deposit(&mut ketos, "alice.test", 200 * USD);
    let long = cross_open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    let short = cross_open(&mut ketos, "ZEC", Side::Short, 100 * USD, 5);
    let isolated = open(&mut ketos, "NEAR", Side::Short, 100 * USD, 1);
    set_price(&mut ketos, "NEAR", P4 / 2, T0_MS);
    set_price(&mut ketos, "ZEC", P4 / 2, T0_MS);
    let long_view = ketos.get_position(long.id).unwrap();
    let short_view = ketos.get_position(short.id).unwrap();
    let view = health(&ketos);
    assert!(long_view.equity.0 < 0);
    assert_eq!(view.equity.0, long_view.equity.0 + short_view.equity.0);
    assert_eq!(view.maintenance_margin.0, 100 * USD);
    assert_eq!(view.health_bps.unwrap().0, 19_700);
    assert_eq!(view.position_count, 2);
    assert!(!view.liquidatable);
    assert_eq!(
        ketos.get_position(isolated.id).unwrap().margin_mode,
        MarginMode::Isolated
    );
    assert_eq!(long_view.liquidation_price.0, 0);
    assert_backed(&ketos, 20_400 * USD);
}

#[test]
fn cross_loss_remains_due_until_other_vault_gain_repays_it() {
    let mut ketos = cross_setup();
    let long = cross_open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    let short = cross_open(&mut ketos, "ZEC", Side::Short, 100 * USD, 5);
    set_price(&mut ketos, "NEAR", P4 / 2, T0_MS);
    set_price(&mut ketos, "ZEC", P4 / 2, T0_MS);
    ctx_at("alice.test", T0_MS);
    assert_eq!(ketos.close_position_now(long.id).0, 0);
    assert_eq!(health(&ketos).cash.0, -(153 * USD as i128));
    assert_eq!(health(&ketos).debt_by_vault, [U128(153 * USD), U128(0)]);
    assert_eq!(ketos.get_vault(VaultId::Core).cross_receivable.0, 153 * USD);
    assert_eq!(margin(&ketos, "alice.test"), 0);
    assert_backed(&ketos, 20_200 * USD);
    ctx_at("alice.test", T0_MS);
    ketos.close_position_now(short.id);
    assert_eq!(margin(&ketos, "alice.test"), 194 * USD);
    assert_eq!(health(&ketos).cash.0, 0);
    assert_eq!(health(&ketos).health_bps, None);
    assert_eq!(ketos.get_vault(VaultId::Core).cross_receivable.0, 0);
    assert_eq!(
        ketos
            .get_account_stats(id("alice.test"))
            .unwrap()
            .realized_pnl
            .0,
        -(6 * USD as i128)
    );
    assert_backed(&ketos, 20_200 * USD);
}

#[test]
fn cross_liquidation_closes_riskiest_first_and_stops_after_recovery() {
    let mut ketos = cross_setup();
    let risky = cross_open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    let safe = cross_open(&mut ketos, "ZEC", Side::Long, 100 * USD, 1);
    set_price(&mut ketos, "NEAR", 280_000_000, T0_MS);
    assert!(health(&ketos).liquidatable);
    ctx_at("keeper.test", T0_MS);
    let records = ketos.liquidate_cross_now(id("alice.test"));
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].position_id, risky.id);
    assert_eq!(records[0].reward.0, USD);
    assert_eq!(records[0].penalty.0, 5 * USD);
    assert_eq!(margin(&ketos, "keeper.test"), USD);
    assert_eq!(health(&ketos).equity.0, 42_200_000);
    assert_eq!(health(&ketos).maintenance_margin.0, 10 * USD);
    assert!(!health(&ketos).liquidatable);
    assert!(ketos.get_position(safe.id).is_some());
    assert_eq!(ketos.get_liquidations(None), records);
    assert_backed(&ketos, 20_200 * USD);
    ctx_at("alice.test", T0_MS);
    ketos.close_position_now(safe.id);
    assert_eq!(margin(&ketos, "alice.test"), 41_900_000);
    assert_backed(&ketos, 20_200 * USD);
}

#[test]
fn cross_insolvency_is_absorbed_only_by_the_creditor_vaults() {
    let mut ketos = cross_setup();
    cross_open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    cross_open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    let tail_before = ketos.get_vault(VaultId::LongTail);
    set_price(&mut ketos, "NEAR", P4 / 2, T0_MS);
    ctx_at("keeper.test", T0_MS);
    let records = ketos.liquidate_cross_now(id("alice.test"));
    assert_eq!(records.len(), 2);
    assert!(records.iter().all(|r| r.reward.0 == 0 && r.penalty.0 == 0));
    assert_eq!(health(&ketos).position_count, 0);
    assert_eq!(health(&ketos).cash.0, 0);
    assert_eq!(ketos.get_vault(VaultId::Core).balance.0, 10_200 * USD);
    assert_eq!(ketos.get_vault(VaultId::Core).cross_receivable.0, 0);
    assert_eq!(ketos.get_vault(VaultId::LongTail), tail_before);
    assert_eq!(
        ketos
            .get_account_stats(id("alice.test"))
            .unwrap()
            .realized_pnl
            .0,
        -(200 * USD as i128)
    );
    assert_backed(&ketos, 20_200 * USD);
}

#[test]
fn switch_to_cross_preserves_size_fees_funding_and_brackets() {
    let mut ketos = cross_setup();
    ctx_at("alice.test", T0_MS);
    let isolated = ketos.open_position_now("NEAR".into(),
    Side::Long,
    U128(100 * USD),
    5,
    Some(Brackets {
        take_profit: Some(U128(500_000_000)),
        stop_loss: Some(U128(300_000_000)),
    }),
    None,);
    let before_vault = ketos.get_vault(VaultId::Core);
    let history_before = ketos.get_account_stats(id("alice.test")).unwrap();
    let switched = ketos.switch_to_cross(isolated.id);
    assert_eq!(switched.margin_mode, MarginMode::Cross);
    assert_eq!(switched.size, isolated.size);
    assert_eq!(switched.margin, isolated.margin);
    assert_eq!(switched.funding_payment, isolated.funding_payment);
    assert_eq!(switched.take_profit, isolated.take_profit);
    assert_eq!(switched.stop_loss, isolated.stop_loss);
    assert_eq!(ketos.get_vault(VaultId::Core), before_vault);
    assert_eq!(
        ketos.get_account_stats(id("alice.test")).unwrap(),
        history_before
    );
    assert_eq!(health(&ketos).position_count, 1);
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn switch_to_cross_rejects_another_owner() {
    let mut ketos = cross_setup();
    let position = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    ctx_at("bob.test", T0_MS);
    ketos.switch_to_cross(position.id);
}

#[test]
#[should_panic(expected = "ERR_CROSS_UNDERMARGINED")]
fn insolvent_isolated_position_cannot_enter_an_empty_cross_pool() {
    let mut ketos = cross_setup();
    let position = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    set_price(&mut ketos, "NEAR", P4 / 2, T0_MS);
    ctx_at("alice.test", T0_MS);
    ketos.switch_to_cross(position.id);
}

#[test]
#[should_panic(expected = "ERR_USE_CROSS_LIQUIDATION")]
fn isolated_liquidation_cannot_bypass_cross_health() {
    let mut ketos = cross_setup();
    let position = cross_open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    set_price(&mut ketos, "NEAR", P4 / 2, T0_MS);
    ctx_at("keeper.test", T0_MS);
    ketos.liquidate_now(position.id);
}

#[test]
#[should_panic(expected = "ERR_CROSS_HEALTHY")]
fn cross_liquidation_rejects_healthy_account() {
    let mut ketos = cross_setup();
    cross_open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    ctx_at("keeper.test", T0_MS);
    ketos.liquidate_cross_now(id("alice.test"));
}

#[test]
fn shared_cash_top_up_covers_debt_without_using_reserved_orders() {
    let mut ketos = cross_setup();
    deposit(&mut ketos, "alice.test", 300 * USD + 100_000);
    let long = cross_open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    cross_open(&mut ketos, "ZEC", Side::Short, 100 * USD, 5);
    ctx_at("alice.test", T0_MS);
    let order = ketos.place_order_now(OrderRequest::Limit(EntryOrder {
        market_id: "NEAR".into(),
        side: Side::Long,
        margin: U128(100 * USD),
        leverage: 1,
        trigger_price: U128(P4 / 4),
        brackets: None,
        margin_mode: MarginMode::Cross,
    }));
    set_price(&mut ketos, "NEAR", P4 / 2, T0_MS);
    set_price(&mut ketos, "ZEC", P4 / 2, T0_MS);
    ctx_at("alice.test", T0_MS);
    ketos.close_position_now(long.id);
    ketos.add_cross_margin(U128(200 * USD));
    assert_eq!(health(&ketos).cash.0, 47 * USD as i128);
    assert_eq!(health(&ketos).debt_by_vault, [U128(0); 2]);
    assert_eq!(
        ketos
            .get_account(id("alice.test"))
            .unwrap()
            .reserved_margin
            .0,
        100_100_000
    );
    ketos.remove_cross_margin(U128(47 * USD));
    assert_eq!(margin(&ketos, "alice.test"), 47 * USD);
    let _ = ketos.cancel_order(order.id, Some(false));
    assert_eq!(margin(&ketos, "alice.test"), 147_100_000);
    assert_backed(&ketos, 20_500 * USD + 100_000);
}

#[test]
#[should_panic(expected = "ERR_CROSS_UNDERMARGINED")]
fn withdrawing_shared_cash_cannot_expose_an_unsafe_position() {
    let mut ketos = cross_setup();
    cross_open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    ctx_at("alice.test", T0_MS);
    ketos.add_cross_margin(U128(100 * USD));
    set_price(&mut ketos, "NEAR", 300_000_000, T0_MS);
    ctx_at("alice.test", T0_MS);
    ketos.remove_cross_margin(U128(25 * USD));
}

#[test]
fn stale_peer_blocks_risk_changes_but_not_cash_rescue() {
    let mut ketos = cross_setup();
    cross_open(&mut ketos, "NEAR", Side::Long, 50 * USD, 5);
    cross_open(&mut ketos, "ZEC", Side::Short, 50 * USD, 5);
    let now = T0_MS + 120_001;
    set_price(&mut ketos, "NEAR", P4, now);
    ctx_at("alice.test", now);
    let view = health(&ketos);
    assert!(!view.prices_fresh);
    assert!(!view.liquidatable);
    assert_eq!(
        ketos
            .cross_admission(&id("alice.test"), USD as i128, USD, 1)
            .unwrap_err(),
        "ERR_STALE_CROSS_PRICE"
    );
    ketos.add_cross_margin(U128(10 * USD));
    assert_eq!(health(&ketos).cash.0, 10 * USD as i128);
}

#[test]
#[should_panic(expected = "ERR_STALE_CROSS_PRICE")]
fn cross_liquidation_requires_fresh_prices_for_every_peer() {
    let mut ketos = cross_setup();
    cross_open(&mut ketos, "NEAR", Side::Long, 50 * USD, 5);
    cross_open(&mut ketos, "ZEC", Side::Long, 50 * USD, 5);
    let now = T0_MS + 120_001;
    set_price(&mut ketos, "NEAR", P4 / 2, now);
    ctx_at("keeper.test", now);
    ketos.liquidate_cross_now(id("alice.test"));
}

#[test]
fn cross_bracket_exit_uses_shared_settlement_and_cancels_its_peer() {
    let mut ketos = cross_setup();
    deposit(&mut ketos, "alice.test", USD);
    ctx_at("alice.test", T0_MS);
    let position = ketos.open_position_now("NEAR".into(),
    Side::Long,
    U128(100 * USD),
    5,
    Some(Brackets {
        take_profit: Some(U128(500_000_000)),
        stop_loss: Some(U128(300_000_000)),
    }),
    Some(MarginMode::Cross),);
    cross_open(&mut ketos, "ZEC", Side::Long, 100 * USD, 1);
    set_price(&mut ketos, "NEAR", 280_000_000, T0_MS);
    ctx_at("keeper.test", T0_MS);
    let filled = ketos.execute_orders_now(vec![position.stop_loss.unwrap()]);
    assert!(
        matches!(filled[0], OrderExecution::Filled { position_id, .. } if position_id == position.id)
    );
    assert!(ketos.get_orders(id("alice.test")).is_empty());
    assert_eq!(health(&ketos).cash.0, -(53 * USD as i128));
    assert_eq!(health(&ketos).position_count, 1);
    assert_backed(&ketos, 20_201 * USD);
}

#[test]
fn triggered_cross_entry_preserves_mode_and_refunds_when_peer_is_stale() {
    let mut ketos = cross_setup();
    ctx_at("alice.test", T0_MS);
    let entry = EntryOrder {
        market_id: "NEAR".into(),
        side: Side::Long,
        margin: U128(50 * USD),
        leverage: 5,
        trigger_price: U128(P4),
        brackets: None,
        margin_mode: MarginMode::Cross,
    };
    let first = ketos.place_order_now(OrderRequest::Limit(entry.clone()));
    ctx_at("keeper.test", T0_MS);
    let fills = ketos.execute_orders_now(vec![first.id]);
    let OrderExecution::Filled { position_id, .. } = fills[0] else {
        panic!("expected fill");
    };
    assert_eq!(
        ketos.get_position(position_id).unwrap().margin_mode,
        MarginMode::Cross
    );
    ctx_at("alice.test", T0_MS);
    let pending = ketos.place_order_now(OrderRequest::Limit(EntryOrder {
        market_id: "ZEC".into(),
        ..entry
    }));
    let now = T0_MS + 120_001;
    set_price(&mut ketos, "ZEC", P4, now);
    ctx_at("keeper.test", now);
    assert!(
        matches!(&ketos.execute_orders_now(vec![pending.id])[0], OrderExecution::Rejected { reason, .. } if reason == "ERR_STALE_CROSS_PRICE")
    );
    assert_eq!(margin(&ketos, "alice.test"), 149_875_000);
    assert_eq!(
        ketos
            .get_account(id("alice.test"))
            .unwrap()
            .reserved_margin
            .0,
        0
    );
}

#[test]
fn cross_position_bound_keeps_account_liquidation_executable() {
    let mut ketos = cross_setup();
    for _ in 0..MAX_CROSS_POSITIONS {
        cross_open(&mut ketos, "NEAR", Side::Long, USD, 5);
    }
    assert_eq!(
        ketos
            .cross_admission(&id("alice.test"), USD as i128, USD, 1)
            .unwrap_err(),
        "ERR_TOO_MANY_CROSS_POSITIONS"
    );
    set_price(&mut ketos, "NEAR", P4 / 2, T0_MS);
    ctx_at("keeper.test", T0_MS);
    assert_eq!(
        ketos.liquidate_cross_now(id("alice.test")).len(),
        MAX_CROSS_POSITIONS as usize
    );
    assert_backed(&ketos, 20_200 * USD);
}

#[test]
fn same_vault_receivable_is_netted_before_capping_a_cross_gain() {
    let mut ketos = cross_setup();
    let long = cross_open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    let short = cross_open(&mut ketos, "NEAR", Side::Short, 100 * USD, 5);
    // Model a later cash loss while retaining the two already collected opening fees.
    ketos.vaults.get_mut(&VaultId::Core).unwrap().balance = 3 * USD;
    set_price(&mut ketos, "NEAR", P4 / 2, T0_MS);
    ctx_at("alice.test", T0_MS);
    ketos.close_position_now(long.id);
    assert_eq!(health(&ketos).cash.0, -(153 * USD as i128));
    assert_eq!(ketos.get_vault(VaultId::Core).balance.0, 254_500_000);
    assert_backed(&ketos, 10_200 * USD);
    ctx_at("alice.test", T0_MS);
    ketos.close_position_now(short.id);
    assert_eq!(margin(&ketos, "alice.test"), 194 * USD);
    assert_eq!(ketos.get_vault(VaultId::Core).balance.0, 6 * USD);
    assert_backed(&ketos, 10_200 * USD);
}

#[test]
fn cross_liquidation_triggers_at_exact_aggregate_maintenance() {
    let mut ketos = cross_setup();
    cross_open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    set_price(&mut ketos, "NEAR", 361_200_000, T0_MS);
    assert_eq!(health(&ketos).equity.0, 50 * USD as i128);
    assert_eq!(health(&ketos).health_bps.unwrap().0, 10_000);
    ctx_at("keeper.test", T0_MS);
    let records = ketos.liquidate_cross_now(id("alice.test"));
    assert_eq!(records.len(), 1);
    assert_eq!(margin(&ketos, "alice.test"), 144 * USD);
    assert_backed(&ketos, 20_200 * USD);
}
