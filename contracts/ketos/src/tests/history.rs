use super::*;
use crate::history::{HistoryKind, LeaderboardSort};
use crate::orders::{Brackets, EntryOrder, OrderExecution, OrderRequest};

fn history(ketos: &Ketos, account: &str) -> Vec<crate::history::HistoryEvent> {
    ketos.get_history(id(account), None, Some(200))
}

#[test]
fn realized_pnl_and_roi_follow_cash_settlement_not_unrealized_price_moves() {
    let mut ketos = trading_setup();
    let p = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    let first = history(&ketos, "alice.test");
    assert_eq!(first[0].kind, HistoryKind::Open);
    assert_eq!(
        (first[0].price.0, first[0].size.0, first[0].fees.0),
        (P4, 500 * USD, USD / 2)
    );
    assert_eq!(first[0].realized_pnl.0, -(USD as i128 / 2));
    set_price(&mut ketos, "NEAR", 440_000_000, T0_MS);
    assert_eq!(
        ketos
            .get_account_stats(id("alice.test"))
            .unwrap()
            .realized_pnl
            .0,
        -(USD as i128 / 2)
    );
    close_at(&mut ketos, p.id, 440_000_000, T0_MS);
    let events = history(&ketos, "alice.test");
    assert_eq!(
        events.iter().map(|e| e.kind).collect::<Vec<_>>(),
        [HistoryKind::Open, HistoryKind::Close]
    );
    assert_eq!(events[1].pnl.0, 50 * USD as i128);
    assert_eq!(events[1].realized_pnl.0, 49_500_000);
    assert_eq!(events[1].timestamp_ms, T0_MS);
    let stats = ketos.get_account_stats(id("alice.test")).unwrap();
    assert_eq!(
        stats.realized_pnl.0,
        margin(&ketos, "alice.test") as i128 - 200 * USD as i128
    );
    assert_eq!(
        (stats.volume.0, stats.trades, stats.committed_margin.0),
        (1_000 * USD, 2, 100 * USD)
    );
    assert_eq!(ketos.get_leaderboard(None, None)[0].roi_bps.0, 4_900);
    assert!(ketos.get_account_stats(id("nobody.test")).is_none());
    assert!(history(&ketos, "nobody.test").is_empty());
}

#[test]
fn insolvent_loss_is_capped_at_committed_collateral() {
    let mut ketos = trading_setup();
    let p = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    close_at(&mut ketos, p.id, 100_000_000, T0_MS);
    let events = history(&ketos, "alice.test");
    assert_eq!(events[1].pnl.0, -375_000_000);
    assert_eq!(events[1].fees.0, 0);
    assert_eq!(events[1].realized_pnl.0, -99_500_000);
    assert_eq!(
        ketos
            .get_account_stats(id("alice.test"))
            .unwrap()
            .realized_pnl
            .0,
        -100_000_000
    );
    assert_eq!(ketos.get_leaderboard(None, None)[0].roi_bps.0, -10_000);
}

#[test]
fn capped_vault_payout_does_not_report_a_profit_that_was_never_paid() {
    let mut ketos = trading_setup();
    ketos.vaults[0].balance = 0;
    let p = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    assert_eq!(close_at(&mut ketos, p.id, 800_000_000, T0_MS), 100 * USD);
    let events = history(&ketos, "alice.test");
    assert_eq!(events[1].pnl.0, 500 * USD as i128);
    assert_eq!(events[1].realized_pnl.0, 500_000);
    assert_eq!(
        ketos
            .get_account_stats(id("alice.test"))
            .unwrap()
            .realized_pnl
            .0,
        0
    );
}

#[test]
fn funding_history_is_realized_once_at_exit_and_keeps_payer_receiver_signs() {
    let mut ketos = trading_setup();
    deposit(&mut ketos, "bob.test", 100 * USD);
    let long = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 3);
    ctx_at("bob.test", T0_MS);
    let short = ketos.open_position("NEAR".into(), Side::Short, U128(100 * USD), 1, None);
    let now = T0_MS + HOUR_MS;
    ctx_at("executor.test", now);
    ketos.settle_funding("NEAR".into());
    ketos.settle_funding("NEAR".into());
    assert_eq!(history(&ketos, "alice.test").len(), 1);
    set_price(&mut ketos, "NEAR", P4, now);
    for (owner, position, initial, net) in [
        ("alice.test", long.id, 200 * USD, 75_000),
        ("bob.test", short.id, 100 * USD, -25_000),
    ] {
        ctx_at(owner, now);
        ketos.close_position(position);
        let events = history(&ketos, owner);
        assert_eq!(
            events.iter().map(|e| e.kind).collect::<Vec<_>>(),
            [HistoryKind::Open, HistoryKind::Funding, HistoryKind::Close]
        );
        assert_eq!(events[1].funding_payment.0, net);
        assert_eq!(events[2].funding_payment.0, net);
        assert_eq!(events[1].realized_pnl.0, 0);
        let stats = ketos.get_account_stats(id(owner)).unwrap();
        assert_eq!(stats.trades, 2);
        assert_eq!(
            stats.realized_pnl.0,
            margin(&ketos, owner) as i128 - initial as i128
        );
        assert_eq!(
            events.iter().map(|e| e.realized_pnl.0).sum::<i128>(),
            stats.realized_pnl.0
        );
    }
}

#[test]
fn liquidation_history_charges_penalties_to_owner_not_executor() {
    let mut ketos = trading_setup();
    let p = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    set_price(&mut ketos, "NEAR", 360_000_000, T0_MS);
    ctx_at("executor.test", T0_MS);
    let liquidation = ketos.liquidate(p.id);
    assert_eq!(liquidation.returned.0, 43_500_000);
    let events = history(&ketos, "alice.test");
    assert_eq!(events[1].kind, HistoryKind::Liquidation);
    assert_eq!((events[1].pnl.0, events[1].fees.0), (-50_000_000, 6 * USD));
    assert_eq!(events[1].realized_pnl.0, -56 * USD as i128);
    assert_eq!(
        ketos
            .get_account_stats(id("alice.test"))
            .unwrap()
            .realized_pnl
            .0,
        -56_500_000
    );
    assert!(history(&ketos, "executor.test").is_empty());
    assert_eq!(
        ketos
            .get_leaderboard(None, None)
            .iter()
            .map(|e| e.account_id.as_str())
            .collect::<Vec<_>>(),
        ["alice.test"]
    );
}

#[test]
fn order_fills_annotate_entry_and_bracket_exit_without_duplicate_trades() {
    let mut ketos = trading_setup();
    ctx_at("alice.test", T0_MS);
    let order = ketos.place_order(OrderRequest::Limit(EntryOrder {
        market_id: "NEAR".into(),
        side: Side::Long,
        margin: U128(100 * USD),
        leverage: 5,
        trigger_price: U128(P4),
        brackets: Some(Brackets {
            take_profit: Some(U128(440_000_000)),
            stop_loss: Some(U128(380_000_000)),
        }),
    }));
    ctx_at("executor.test", T0_MS);
    let filled = ketos.execute_orders(vec![order.id, order.id]);
    let OrderExecution::Filled { position_id, .. } = filled[0] else {
        panic!("entry must fill");
    };
    let position = ketos.get_position(position_id).unwrap();
    assert_eq!(ketos.get_account_stats(id("alice.test")).unwrap().trades, 1);
    set_price(&mut ketos, "NEAR", 450_000_000, T0_MS);
    ketos.execute_orders(vec![
        position.take_profit.unwrap(),
        position.stop_loss.unwrap(),
    ]);
    let events = history(&ketos, "alice.test");
    assert_eq!(
        events.iter().map(|e| e.kind).collect::<Vec<_>>(),
        [
            HistoryKind::Open,
            HistoryKind::OrderFill,
            HistoryKind::Close,
            HistoryKind::OrderFill
        ]
    );
    assert_eq!(events[1].order_id, Some(order.id));
    assert_eq!(events[3].order_id, position.take_profit);
    assert_eq!(
        (events[3].price.0, events[3].size.0),
        (450_000_000, 500 * USD)
    );
    assert_eq!(events[1].realized_pnl.0 + events[3].realized_pnl.0, 0);
    let stats = ketos.get_account_stats(id("alice.test")).unwrap();
    assert_eq!((stats.trades, stats.volume.0), (2, 1_000 * USD));
    assert_eq!(
        stats.realized_pnl.0,
        margin(&ketos, "alice.test") as i128 - 200 * USD as i128
    );
    assert!(history(&ketos, "executor.test").is_empty());
}

#[test]
fn rejected_cancelled_and_untriggered_orders_do_not_create_trade_history() {
    let mut ketos = trading_setup();
    ctx_at("alice.test", T0_MS);
    let entry = EntryOrder {
        market_id: "NEAR".into(),
        side: Side::Long,
        margin: U128(100 * USD),
        leverage: 5,
        trigger_price: U128(380_000_000),
        brackets: None,
    };
    let cancel = ketos.place_order(OrderRequest::Limit(entry.clone()));
    ketos.cancel_order(cancel.id);
    let reject = ketos.place_order(OrderRequest::Limit(entry));
    ctx_at("executor.test", T0_MS);
    assert_eq!(
        ketos.execute_orders(vec![reject.id]),
        [OrderExecution::Skipped {
            order_id: reject.id
        }]
    );
    set_depth_at(
        &mut ketos,
        "NEAR",
        vec![DepthSample {
            size_usd: 1_000,
            impact_bps: Some(10),
        }],
        T0_MS + 1,
    );
    set_price(&mut ketos, "NEAR", 370_000_000, T0_MS + 1);
    assert!(matches!(
        ketos.execute_orders(vec![reject.id])[0],
        OrderExecution::Rejected { .. }
    ));
    assert!(history(&ketos, "alice.test").is_empty());
    assert!(ketos.get_account_stats(id("alice.test")).is_none());
    assert!(ketos.get_leaderboard(None, None).is_empty());
}

#[test]
fn history_ring_preserves_absolute_cursors_and_all_time_stats_after_wrap() {
    let mut ketos = trading_setup();
    for _ in 0..105 {
        let position = open(&mut ketos, "NEAR", Side::Long, USD, 1);
        ctx_at("alice.test", T0_MS);
        ketos.close_position(position.id);
    }
    let events = history(&ketos, "alice.test");
    assert_eq!(
        events.iter().map(|e| e.sequence).collect::<Vec<_>>(),
        (10..210).collect::<Vec<_>>()
    );
    assert_eq!(events[0].position_id, 5);
    assert_eq!(events[199].position_id, 104);
    let stats = ketos.get_account_stats(id("alice.test")).unwrap();
    assert_eq!(
        (
            stats.event_count,
            stats.trades,
            stats.volume.0,
            stats.realized_pnl.0
        ),
        (210, 210, 210 * USD, -210_000)
    );
    assert_eq!(
        ketos.get_history(id("alice.test"), Some(208), Some(200)),
        events[198..]
    );
    assert_eq!(
        ketos.get_history(id("alice.test"), Some(0), Some(u32::MAX)),
        events
    );
    assert!(ketos
        .get_history(id("alice.test"), Some(u64::MAX), Some(10))
        .is_empty());
    assert!(ketos
        .get_history(id("alice.test"), None, Some(0))
        .is_empty());
    deposit(&mut ketos, "bob.test", 5 * USD);
    ctx_at("bob.test", T0_MS);
    ketos.open_position("NEAR".into(), Side::Short, U128(USD), 1, None);
    assert_eq!(history(&ketos, "bob.test")[0].sequence, 0);
    assert_eq!(history(&ketos, "alice.test"), events);
}

#[test]
fn leaderboard_sorts_signed_pnl_and_volume_and_reindexes_existing_accounts() {
    let mut ketos = trading_setup();
    let alice = open(&mut ketos, "NEAR", Side::Long, 100 * USD, 5);
    deposit(&mut ketos, "bob.test", 100 * USD);
    ctx_at("bob.test", T0_MS);
    let bob = ketos.open_position("NEAR".into(), Side::Short, U128(10 * USD), 5, None);
    close_at(&mut ketos, alice.id, 360_000_000, T0_MS);
    ctx_at("bob.test", T0_MS);
    ketos.close_position(bob.id);
    let pnl = ketos.get_leaderboard(Some(LeaderboardSort::Pnl), None);
    let volume = ketos.get_leaderboard(Some(LeaderboardSort::Volume), None);
    assert_eq!(
        pnl.iter()
            .map(|e| e.account_id.as_str())
            .collect::<Vec<_>>(),
        ["bob.test", "alice.test"]
    );
    assert_eq!(
        volume
            .iter()
            .map(|e| e.account_id.as_str())
            .collect::<Vec<_>>(),
        ["alice.test", "bob.test"]
    );
    assert_eq!(
        (pnl[0].realized_pnl.0, pnl[1].realized_pnl.0),
        (4_900_000, -51_000_000)
    );
    assert_eq!(ketos.get_leaderboard(None, Some(1)), pnl[..1]);
    assert!(ketos.get_leaderboard(None, Some(0)).is_empty());
    assert_eq!(
        (
            ketos.pnl_ranking.len(),
            ketos.volume_ranking.len(),
            ketos.active_traders.len()
        ),
        (2, 2, 2)
    );
}

#[test]
fn leaderboard_evicts_oldest_activity_without_losing_history_and_allows_reentry() {
    let mut ketos = trading_setup();
    for i in 0..501 {
        let owner = format!("trader{i:03}.test");
        deposit(&mut ketos, &owner, 5 * USD);
        ctx_at(&owner, T0_MS);
        ketos.open_position("NEAR".into(), Side::Long, U128(USD), 1, None);
        near_sdk::env::state_write(&ketos);
        drop(ketos);
        ketos = near_sdk::env::state_read().unwrap();
    }
    ctx_at("viewer.test", T0_MS);
    let board = ketos.get_leaderboard(None, Some(u32::MAX));
    assert_eq!(board.len(), 500);
    assert_eq!(board.first().unwrap().account_id, id("trader500.test"));
    assert_eq!(board.last().unwrap().account_id, id("trader001.test"));
    assert_eq!(history(&ketos, "trader000.test")[0].sequence, 0);
    ctx_at("trader000.test", T0_MS);
    ketos.open_position("NEAR".into(), Side::Short, U128(USD), 1, None);
    ctx_at("viewer.test", T0_MS);
    let board = ketos.get_leaderboard(None, Some(500));
    assert!(board.iter().all(|e| e.account_id != id("trader001.test")));
    let returning = board
        .iter()
        .find(|e| e.account_id == id("trader000.test"))
        .unwrap();
    assert_eq!(
        (
            returning.trades,
            returning.volume.0,
            returning.realized_pnl.0
        ),
        (2, 2 * USD, -2_000)
    );
    assert_eq!(
        (
            ketos.pnl_ranking.len(),
            ketos.volume_ranking.len(),
            ketos.active_traders.len()
        ),
        (500, 500, 500)
    );
}
